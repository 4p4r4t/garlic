use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{canvases, ensure_finite, new_id, now_ms, parse_col};
use crate::error::{AppError, AppResult};
use crate::model::{NewNode, Node, NodeKind, NodePatch, NodePlace, NodePosition, TaskStatus};

/// Ключи палитры нод (ТЗ §8). Фронт сопоставляет их с конкретными цветами.
pub const PALETTE: &[&str] = &[
    "red", "orange", "yellow", "green", "teal", "blue", "violet", "gray",
];

pub(crate) const COLS: &str =
    "id, canvas_id, kind, title, body, status, color, x, y, width, height,
                    created_at, updated_at, kb_path, kb_result_path, prev_status, sticker_of";

pub(crate) fn from_row(r: &Row<'_>) -> rusqlite::Result<Node> {
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
        kb_path: r.get(13)?,
        kb_result_path: r.get(14)?,
        created_at: r.get(11)?,
        updated_at: r.get(12)?,
        prev_status: r
            .get::<_, Option<String>>(15)?
            .map(|s| parse_col(15, s))
            .transpose()?,
        sticker_of: r.get(16)?,
    })
}

/// Значения колонок `COLS` ноды — для вставки «как было» (undo, перестройки).
pub(crate) fn insert_full(conn: &Connection, n: &Node) -> AppResult<()> {
    conn.execute(
        &format!(
            "INSERT INTO nodes ({COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)"
        ),
        params![
            n.id,
            n.canvas_id,
            n.kind.as_str(),
            n.title,
            n.body,
            n.status.map(TaskStatus::as_str),
            n.color,
            n.x,
            n.y,
            n.width,
            n.height,
            n.created_at,
            n.updated_at,
            n.kb_path,
            n.kb_result_path,
            n.prev_status.map(TaskStatus::as_str),
            n.sticker_of
        ],
    )?;
    Ok(())
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
        if node.status != status {
            if status.is_some_and(TaskStatus::is_blocked) {
                return Err(AppError::Invalid(
                    "«Заблокирована» ставится только блокировкой (ПКМ → «Заблокировать…»)".into(),
                ));
            }
            if node.status.is_some_and(TaskStatus::is_blocked) {
                return Err(AppError::Invalid(
                    "задача заблокирована — сначала разблокируйте её".into(),
                ));
            }
        }
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

    if let Some(kb) = &patch.kb_path {
        node.kb_path = match kb {
            Some(p) => Some(crate::vault::paths::normalize_rel(p)?),
            None => None,
        };
    }

    if let Some(kb) = &patch.kb_result_path {
        node.kb_result_path = match (node.kind, kb) {
            (NodeKind::Task, Some(p)) => Some(crate::vault::paths::normalize_rel(p)?),
            (NodeKind::Note, Some(_)) => {
                return Err(AppError::Invalid(
                    "«Результат» бывает только у задачи".into(),
                ))
            }
            (_, None) => None,
        };
    }

    node.updated_at = now_ms();
    tx.execute(
        "UPDATE nodes SET title = ?2, body = ?3, status = ?4, color = ?5,
                          width = ?6, height = ?7, updated_at = ?8, kb_path = ?9,
                          kb_result_path = ?10
         WHERE id = ?1",
        params![
            id,
            node.title,
            node.body,
            node.status.map(TaskStatus::as_str),
            node.color,
            node.width,
            node.height,
            node.updated_at,
            node.kb_path,
            node.kb_result_path
        ],
    )?;
    tx.commit()?;
    Ok(node)
}

/// Пакетная смена статуса (групповые действия, ТЗ §4.3). Заметки,
/// заблокированные задачи и неизвестные id пропускаются. Возвращает
/// обновлённые задачи (в порядке `ids`). «Заблокирована» так не ставится.
pub fn set_status_many(
    conn: &Connection,
    ids: &[String],
    status: TaskStatus,
) -> AppResult<Vec<Node>> {
    if status.is_blocked() {
        return Err(AppError::Invalid(
            "«Заблокирована» ставится только блокировкой".into(),
        ));
    }
    let tx = conn.unchecked_transaction()?;
    let mut updated = Vec::new();
    {
        let now = now_ms();
        let mut stmt = tx.prepare(
            "UPDATE nodes SET status = ?2, updated_at = ?3
             WHERE id = ?1 AND kind = 'task' AND status IS NOT 'blocked'",
        )?;
        for id in ids {
            if stmt.execute(params![id, status.as_str(), now])? > 0 {
                updated.push(get(&tx, id)?);
            }
        }
    }
    tx.commit()?;
    Ok(updated)
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
        &format!("{SUB_CANVASES} SELECT COUNT(*) FROM nodes WHERE canvas_id IN (SELECT canvas_id FROM sub)"),
        [id],
        |r| r.get(0),
    )?)
}

/// Все холсты под задачей `?1` на всех уровнях: её слой, слои его задач, …
/// и ничейные слои, приютившиеся на этих холстах (удаление задачи уносит их тоже).
const SUB_CANVASES: &str = "WITH RECURSIVE sub(canvas_id) AS (
     SELECT id FROM canvases WHERE owner_node = ?1
     UNION
     SELECT c.id FROM canvases c
     JOIN nodes n ON c.owner_node = n.id
     JOIN sub ON n.canvas_id = sub.canvas_id
     UNION
     SELECT c.id FROM canvases c
     JOIN sub ON c.host_canvas = sub.canvas_id
 )";

/// Все вложенные ноды задач `ids` (все уровни) с положением — для перемещения
/// задачи вместе с подзадачами (ТЗ §4.12.2). Сами `ids` не входят; повторы убраны.
/// Стикеры не входят: их `x`/`y` — смещение от своей задачи, они едут с ней.
pub fn descendants(conn: &Connection, ids: &[String]) -> AppResult<Vec<NodePlace>> {
    let mut stmt = conn.prepare(&format!(
        "{SUB_CANVASES} SELECT id, canvas_id, x, y FROM nodes
          WHERE canvas_id IN (SELECT canvas_id FROM sub) AND sticker_of IS NULL
          ORDER BY created_at, id"
    ))?;
    let roots: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        let rows = stmt.query_map([id], |r| {
            Ok(NodePlace {
                id: r.get(0)?,
                canvas_id: r.get(1)?,
                x: r.get(2)?,
                y: r.get(3)?,
            })
        })?;
        for p in rows {
            let p = p?;
            if !roots.contains(p.id.as_str()) && seen.insert(p.id.clone()) {
                out.push(p);
            }
        }
    }
    Ok(out)
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
