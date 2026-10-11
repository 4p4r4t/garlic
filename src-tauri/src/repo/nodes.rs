use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{canvases, ensure_finite, new_id, now_ms, parse_col};
use crate::error::{AppError, AppResult};
use crate::model::{NewNode, Node, NodeKind, NodePatch, NodePosition, TaskStatus};

/// Ключи палитры нод (ТЗ §8). Фронт сопоставляет их с конкретными цветами.
pub const PALETTE: &[&str] = &[
    "red", "orange", "yellow", "green", "teal", "blue", "violet", "gray",
];

const COLS: &str =
    "id, canvas_id, kind, title, body, status, color, x, y, width, height, created_at, updated_at";

fn from_row(r: &Row<'_>) -> rusqlite::Result<Node> {
    Ok(Node {
        id: r.get(0)?,
        canvas_id: r.get(1)?,
        kind: parse_col(2, r.get(2)?)?,
        title: r.get(3)?,
        body: r.get(4)?,
        status: r
            .get::<_, Option<String>>(5)?
            .map(|s| parse_col(5, s))
            .transpose()?,
        color: r.get(6)?,
        x: r.get(7)?,
        y: r.get(8)?,
        width: r.get(9)?,
        height: r.get(10)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
    })
}

pub fn find(conn: &Connection, id: &str) -> AppResult<Option<Node>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLS} FROM nodes WHERE id = ?1"),
            [id],
            from_row,
        )
        .optional()?)
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Node> {
    find(conn, id)?.ok_or_else(|| AppError::NotFound(format!("нода {id}")))
}

pub fn list_by_canvas(conn: &Connection, canvas_id: &str) -> AppResult<Vec<Node>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLS} FROM nodes WHERE canvas_id = ?1 ORDER BY created_at, id"
    ))?;
    let rows = stmt.query_map([canvas_id], from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn create(conn: &Connection, input: &NewNode) -> AppResult<Node> {
    ensure_finite("x", input.x)?;
    ensure_finite("y", input.y)?;
    canvases::get(conn, &input.canvas_id)?;
    let id = new_id();
    let now = now_ms();
    let status = match input.kind {
        NodeKind::Task => Some(TaskStatus::Todo.as_str()),
        NodeKind::Note => None,
    };
    conn.execute(
        "INSERT INTO nodes (id, canvas_id, kind, title, body, status, color, x, y, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, '', ?5, NULL, ?6, ?7, ?8, ?8)",
        params![
            id,
            input.canvas_id,
            input.kind.as_str(),
            input.title.trim(),
            status,
            input.x,
            input.y,
            now
        ],
    )?;
    get(conn, &id)
}

/// Применяет частичное обновление. Возвращает актуальную ноду.
pub fn update(conn: &Connection, id: &str, patch: &NodePatch) -> AppResult<Node> {
    let tx = conn.unchecked_transaction()?;
    let mut node = get(&tx, id)?;

    if let Some(title) = &patch.title {
        node.title = title.trim().to_owned();
    }
    if let Some(body) = &patch.body {
        node.body.clone_from(body);
    }
    if let Some(status) = patch.status {
        match (node.kind, status) {
            (NodeKind::Task, Some(_)) => node.status = status,
            (NodeKind::Task, None) => {
                return Err(AppError::Invalid("у задачи должен быть статус".into()))
            }
            (NodeKind::Note, Some(_)) => {
                return Err(AppError::Invalid("у заметки нет статуса".into()))
            }
            (NodeKind::Note, None) => {}
        }
    }
    if let Some(color) = &patch.color {
        if let Some(c) = color {
            if !PALETTE.contains(&c.as_str()) {
                return Err(AppError::Invalid(format!("неизвестный цвет: {c}")));
            }
        }
        node.color.clone_from(color);
    }
    for (name, value, slot) in [
        ("width", patch.width, &mut node.width),
        ("height", patch.height, &mut node.height),
    ] {
        if let Some(v) = value {
            if let Some(v) = v {
                ensure_finite(name, v)?;
                if v <= 0.0 {
                    return Err(AppError::Invalid(format!("{name} должен быть > 0")));
                }
            }
            *slot = v;
        }
    }

    node.updated_at = now_ms();
    tx.execute(
        "UPDATE nodes SET title = ?2, body = ?3, status = ?4, color = ?5,
                          width = ?6, height = ?7, updated_at = ?8
         WHERE id = ?1",
        params![
            id,
            node.title,
            node.body,
            node.status.map(TaskStatus::as_str),
            node.color,
            node.width,
            node.height,
            node.updated_at
        ],
    )?;
    tx.commit()?;
    Ok(node)
}

/// Пакетное перемещение нод. Неизвестный id — ошибка, вся пачка откатывается.
pub fn move_many(conn: &Connection, positions: &[NodePosition]) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let now = now_ms();
        let mut stmt =
            tx.prepare("UPDATE nodes SET x = ?2, y = ?3, updated_at = ?4 WHERE id = ?1")?;
        for p in positions {
            ensure_finite("x", p.x)?;
            ensure_finite("y", p.y)?;
            if stmt.execute(params![p.id, p.x, p.y, now])? == 0 {
                return Err(AppError::NotFound(format!("нода {}", p.id)));
            }
        }
    }
    tx.commit()?;
    Ok(())
}

/// Сколько всего нод вложено в ноду (на всех уровнях её слоёв).
/// Нужно фронту для подтверждения удаления задачи с подзадачами.
pub fn count_descendants(conn: &Connection, id: &str) -> AppResult<i64> {
    Ok(conn.query_row(
        "WITH RECURSIVE sub(canvas_id) AS (
             SELECT id FROM canvases WHERE owner_node = ?1
             UNION ALL
             SELECT c.id FROM canvases c
             JOIN nodes n ON c.owner_node = n.id
             JOIN sub ON n.canvas_id = sub.canvas_id
         )
         SELECT COUNT(*) FROM nodes WHERE canvas_id IN (SELECT canvas_id FROM sub)",
        [id],
        |r| r.get(0),
    )?)
}

/// Удаляет ноды. Связи, вложенные холсты и их содержимое уходят каскадом.
/// Возвращает число реально удалённых нод (неизвестные id игнорируются).
pub fn delete_many(conn: &Connection, ids: &[String]) -> AppResult<usize> {
    let tx = conn.unchecked_transaction()?;
    let mut deleted = 0;
    {
        let mut stmt = tx.prepare("DELETE FROM nodes WHERE id = ?1")?;
        for id in ids {
            deleted += stmt.execute([id])?;
        }
    }
    tx.commit()?;
    Ok(deleted)
}
