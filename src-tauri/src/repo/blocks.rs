//! Блокировки (ТЗ §4.12.7): статусы «Заблокирована» / «Чужая», стикеры.
//!
//! Модель:
//! - блокирующий задачи T — задача-стикер (`nodes.sticker_of = T`, лежит на
//!   холсте T, её `x`/`y` — смещение от угла T) или задача, от которой идёт
//!   стрелка вида `blocks` к T (оторванный стикер);
//! - блокирующий «активен», пока он не `done`;
//! - инвариант: у задачи статус `blocked` ⇔ у неё есть активный блокирующий.
//!   Его держит `sync` — его вызывают команды после каждого изменения, которое
//!   может его нарушить (статусы, удаление, восстановление, стикеры, стрелки).
//!   При блокировке прежний статус уходит в `prev_status`, при разблокировке
//!   возвращается. Поэтому undo/redo любых шагов (удаление стикера, его «готово»,
//!   восстановление снимка) само возвращает и блокировку.

use rusqlite::{params, Connection};

use super::{edges, ensure_finite, new_id, nodes, now_ms};
use crate::error::{AppError, AppResult};
use crate::model::{BlockSync, Edge, EdgeKind, Node, NodeKind, StickResult, TaskStatus};

/// Ширина ноды задачи (ТЗ §4.3) и стикера — для места стикера у правого верхнего угла.
const TASK_W: f64 = 240.0;
const STICKER_W: f64 = 150.0;
/// Сдвиг каждого следующего стикера влево.
const STICKER_STEP: f64 = 132.0;

/// Место `k`-го стикера задачи (смещение от её левого верхнего угла): первый —
/// за правым верхним углом, следующие — левее, чуть вразнобой по высоте.
pub fn sticker_slot(k: usize) -> (f64, f64) {
    let x = TASK_W - STICKER_W + 16.0 - STICKER_STEP * k as f64;
    let y = if k.is_multiple_of(2) { -26.0 } else { -20.0 };
    (x, y)
}

/// Условие «у задачи `t` есть активный блокирующий» (SQL, алиас задачи — `t`).
const ACTIVE: &str = "(EXISTS(SELECT 1 FROM nodes b
                WHERE b.sticker_of = t.id AND b.status IS NOT 'done')
         OR EXISTS(SELECT 1 FROM edges e JOIN nodes b ON b.id = e.source
                WHERE e.kind = 'blocks' AND e.target = t.id AND b.status IS NOT 'done'))";

/// Восстанавливает инвариант блокировок по всей БД. Разблокировка может
/// вернуть задаче `done` — тогда меняются и её собственные «подопечные»,
/// поэтому повторяем до неподвижной точки.
pub fn sync(conn: &Connection) -> AppResult<BlockSync> {
    let mut out = BlockSync::default();
    for _ in 0..16 {
        let to_block: Vec<String> = {
            let mut stmt = conn.prepare(&format!(
                "SELECT t.id FROM nodes t
                 WHERE t.kind = 'task' AND t.status IS NOT 'blocked' AND {ACTIVE}"
            ))?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let to_unblock: Vec<String> = {
            let mut stmt = conn.prepare(&format!(
                "SELECT t.id FROM nodes t WHERE t.status = 'blocked' AND NOT {ACTIVE}"
            ))?;
            let rows = stmt.query_map([], |r| r.get(0))?;
            rows.collect::<Result<_, _>>()?
        };
        if to_block.is_empty() && to_unblock.is_empty() {
            break;
        }
        let now = now_ms();
        for id in &to_block {
            conn.execute(
                "UPDATE nodes SET prev_status = COALESCE(status, 'todo'), status = 'blocked',
                                  updated_at = ?2
                 WHERE id = ?1",
                params![id, now],
            )?;
            out.unblocked.retain(|n| &n.id != id);
            out.blocked.retain(|n| &n.id != id);
            out.blocked.push(nodes::get(conn, id)?);
        }
        for id in &to_unblock {
            conn.execute(
                "UPDATE nodes SET status = COALESCE(prev_status, 'todo'), prev_status = NULL,
                                  updated_at = ?2
                 WHERE id = ?1",
                params![id, now],
            )?;
            out.blocked.retain(|n| &n.id != id);
            out.unblocked.retain(|n| &n.id != id);
            out.unblocked.push(nodes::get(conn, id)?);
        }
    }
    Ok(out)
}

fn sticker_count(conn: &Connection, host: &str, except: &str) -> AppResult<usize> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM nodes WHERE sticker_of = ?1 AND id <> ?2",
        params![host, except],
        |r| r.get(0),
    )?;
    Ok(n as usize)
}

fn has_stickers(conn: &Connection, id: &str) -> AppResult<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM nodes WHERE sticker_of = ?1)",
        [id],
        |r| r.get(0),
    )?)
}

fn task(conn: &Connection, id: &str) -> AppResult<Node> {
    let n = nodes::get(conn, id)?;
    if n.kind != NodeKind::Task {
        return Err(AppError::Invalid("это не задача".into()));
    }
    Ok(n)
}

/// «Заблокировать…» (ТЗ §4.12.7): новая задача «Чужая» с заголовком-причиной,
/// приклеенная стикером к задаче `task_id`. Возвращает стикер (статус самой
/// задачи меняет `sync`).
pub fn block_task(conn: &Connection, task_id: &str, reason: &str) -> AppResult<Node> {
    let reason = reason.trim();
    if reason.is_empty() {
        return Err(AppError::Invalid("укажите причину блокировки".into()));
    }
    let tx = conn.unchecked_transaction()?;
    let host = task(&tx, task_id)?;
    if host.sticker_of.is_some() {
        return Err(AppError::Invalid("стикер нельзя заблокировать".into()));
    }
    let (x, y) = sticker_slot(sticker_count(&tx, task_id, "")?);
    let now = now_ms();
    let sticker = Node {
        id: new_id(),
        canvas_id: host.canvas_id.clone(),
        kind: NodeKind::Task,
        title: reason.to_owned(),
        body: String::new(),
        status: Some(TaskStatus::Foreign),
        color: None,
        x,
        y,
        width: None,
        height: None,
        kb_path: None,
        kb_result_path: None,
        created_at: now,
        updated_at: now,
        prev_status: None,
        sticker_of: Some(host.id),
    };
    nodes::insert_full(&tx, &sticker)?;
    tx.commit()?;
    nodes::get(conn, &sticker.id)
}

/// Приклеить / оторвать стикер (ТЗ §4.12.7).
///
/// - `target = Some(T)` — нода `id` становится стикером задачи T (того же
///   холста): `pos` — смещение от угла T (нет — следующее свободное место);
///   стрелки «блокирует» `id → T` удаляются (стикер их заменяет).
/// - `target = None` — нода становится обычной: `pos` — мировые координаты
///   (нет — там, где был стикер). Если она была стикером и задан `edge_id`, к
///   прежней задаче проводится стрелка «блокирует» с этим id (отрыв драгом);
///   без `edge_id` — блокировка снимается (ручное «Разблокировать → оторвать»).
pub fn stick(
    conn: &Connection,
    id: &str,
    target: Option<&str>,
    pos: Option<(f64, f64)>,
    edge_id: Option<String>,
) -> AppResult<StickResult> {
    if let Some((x, y)) = pos {
        ensure_finite("x", x)?;
        ensure_finite("y", y)?;
    }
    let tx = conn.unchecked_transaction()?;
    let node = task(&tx, id)?;
    let mut edge: Option<Edge> = None;
    match target {
        Some(t) => {
            if t == id {
                return Err(AppError::Invalid(
                    "нельзя приклеить задачу к самой себе".into(),
                ));
            }
            let host = task(&tx, t)?;
            if host.canvas_id != node.canvas_id {
                return Err(AppError::Invalid(
                    "стикер приклеивается только к задаче того же холста".into(),
                ));
            }
            if host.sticker_of.is_some() {
                return Err(AppError::Invalid("нельзя приклеить к стикеру".into()));
            }
            if has_stickers(&tx, id)? {
                return Err(AppError::Invalid(
                    "у этой задачи свои стикеры — её нельзя приклеить".into(),
                ));
            }
            let (x, y) = match pos {
                Some(p) => p,
                None => sticker_slot(sticker_count(&tx, t, id)?),
            };
            tx.execute(
                "UPDATE nodes SET sticker_of = ?2, x = ?3, y = ?4, updated_at = ?5 WHERE id = ?1",
                params![id, t, x, y, now_ms()],
            )?;
            tx.execute(
                "DELETE FROM edges WHERE kind = 'blocks' AND source = ?1 AND target = ?2",
                params![id, t],
            )?;
        }
        None => {
            let host = match &node.sticker_of {
                Some(h) => nodes::find(&tx, h)?,
                None => None,
            };
            let (x, y) = match (pos, &host) {
                (Some(p), _) => p,
                (None, Some(h)) => (h.x + node.x, h.y + node.y),
                (None, None) => (node.x, node.y),
            };
            tx.execute(
                "UPDATE nodes SET sticker_of = NULL, x = ?2, y = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, x, y, now_ms()],
            )?;
            if let (Some(h), Some(eid)) = (&host, edge_id) {
                if !edges::exists_pair(&tx, &node.canvas_id, id, &h.id, EdgeKind::Blocks)? {
                    let e = Edge {
                        id: eid,
                        canvas_id: node.canvas_id.clone(),
                        source: id.to_owned(),
                        target: h.id.clone(),
                        source_handle: None,
                        target_handle: None,
                        label: None,
                        kind: EdgeKind::Blocks,
                    };
                    edges::insert_full(&tx, &e)?;
                    edge = Some(edges::get(&tx, &e.id)?);
                }
            }
        }
    }
    let node = nodes::get(&tx, id)?;
    tx.commit()?;
    Ok(StickResult { node, edge })
}
