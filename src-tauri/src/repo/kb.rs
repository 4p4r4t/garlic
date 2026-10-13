//! Ссылки нод на базу знаний (ТЗ §4.10, §4.11): `nodes.kb_path` (у задачи —
//! «Комментарий», у заметки — её `.md`) и `nodes.kb_result_path` («Результат»
//! задачи). Всё, что переписывает или ищет пути, работает с обеими колонками.

use rusqlite::{params, Connection};

use super::parse_col;
use crate::error::AppResult;
use crate::model::{LinkRole, LinkedNode, NodeKind, ResultLink};

/// Колонки со ссылками на vault (обе роли задачи; у заметки — только `kb_path`).
const LINK_COLUMNS: [&str; 2] = ["kb_path", "kb_result_path"];

/// Переписывает ссылки после переименования/перемещения в vault: `old` → `new`.
///
/// Меняются ссылки, равные `old`, и все ссылки внутри папки `old/…` (переименование
/// папки тянет за собой пути вложенных заметок и папок) — во всех ролях
/// (комментарий и результат задачи, файл заметки). Возвращает число изменённых
/// ссылок (нода с обеими ролями на этом пути считается дважды). Идемпотентна: повторный вызов (эхо watcher'а после нашего же
/// переименования) ничего не находит.
pub fn rewrite_prefix(conn: &Connection, old: &str, new: &str) -> AppResult<usize> {
    if old.is_empty() || old == new {
        return Ok(0);
    }
    let old_dir = format!("{old}/");
    let tx = conn.unchecked_transaction()?;
    let mut n = 0;
    for col in LINK_COLUMNS {
        // Без LIKE: в именах файлов бывают `%` и `_`.
        n += tx.execute(
            &format!(
                "UPDATE nodes
                    SET {col} = ?2 || substr({col}, length(?1) + 1)
                  WHERE {col} = ?1
                     OR substr({col}, 1, length(?3)) = ?3"
            ),
            params![old, new, old_dir],
        )?;
    }
    if n > 0 {
        sync_note_titles(&tx, new)?;
    }
    tx.commit()?;
    Ok(n)
}

/// Заголовок ноды-заметки = имя её файла (ТЗ §4.10): после переименования/
/// перемещения `prefix` (файла или папки) заголовки нод-заметок, привязанных
/// к `.md` по этому пути, приводятся к имени файла.
pub fn sync_note_titles(conn: &Connection, prefix: &str) -> AppResult<usize> {
    let dir = format!("{prefix}/");
    let rows: Vec<(String, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, kb_path, title FROM nodes
              WHERE kind = 'note'
                AND (kb_path = ?1 OR substr(kb_path, 1, length(?2)) = ?2)",
        )?;
        let it = stmt.query_map(params![prefix, dir], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })?;
        it.collect::<Result<_, _>>()?
    };
    let mut changed = 0;
    for (id, path, title) in rows {
        let Some(stem) = note_stem(&path) else {
            continue;
        };
        if stem != title {
            conn.execute(
                "UPDATE nodes SET title = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, stem, super::now_ms()],
            )?;
            changed += 1;
        }
    }
    Ok(changed)
}

/// Имя файла заметки без `.md` (`a/План.md` → `План`); не заметка — `None`.
pub fn note_stem(path: &str) -> Option<String> {
    let name = crate::vault::paths::file_name(path);
    crate::vault::paths::is_md(name).then(|| name[..name.len() - 3].to_owned())
}

/// Ноды всех пространств, привязанные ровно к `path` (заметке или папке), с
/// ролью ссылки: файл ноды-заметки, «Комментарий» или «Результат» задачи.
/// Задача с обеими ролями на этом пути даёт две записи.
pub fn linked_nodes(conn: &Connection, path: &str) -> AppResult<Vec<LinkedNode>> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.title, n.kind, n.status, n.canvas_id, c.space_id, s.name, l.role
           FROM (SELECT id, 0 AS ord, 'path' AS role FROM nodes WHERE kb_path = ?1
                 UNION ALL
                 SELECT id, 1, 'result' FROM nodes WHERE kb_result_path = ?1) l
           JOIN nodes n ON n.id = l.id
           JOIN canvases c ON c.id = n.canvas_id
           JOIN spaces s ON s.id = c.space_id
          ORDER BY s.sort_order, s.created_at, n.created_at, n.id, l.ord",
    )?;
    let rows = stmt
        .query_map([path], |r| {
            let kind: NodeKind = parse_col(2, r.get(2)?)?;
            let role = match (r.get::<_, String>(7)?.as_str(), kind) {
                ("result", _) => LinkRole::Result,
                (_, NodeKind::Task) => LinkRole::Comment,
                (_, NodeKind::Note) => LinkRole::Note,
            };
            Ok((
                LinkedNode {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    kind,
                    status: r
                        .get::<_, Option<String>>(3)?
                        .map(|s| parse_col(3, s))
                        .transpose()?,
                    space_id: r.get(5)?,
                    space_name: r.get(6)?,
                    canvas_chain: Vec::new(),
                    role,
                },
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut out = Vec::with_capacity(rows.len());
    for (mut node, canvas_id) in rows {
        node.canvas_chain = canvas_chain(conn, &canvas_id)?;
        out.push(node);
    }
    Ok(out)
}

/// Все «Результаты» задач всех пространств (фильтр проводника «Показывать
/// только результаты», ТЗ §4.11): путь + задача-владелец (статус, пространство,
/// заголовки предков, цепочка холстов). Статус не фильтруется — это решает фронт.
pub fn result_links(conn: &Connection) -> AppResult<Vec<ResultLink>> {
    let mut stmt = conn.prepare(
        "SELECT n.kb_result_path, n.id, n.title, COALESCE(n.status, 'todo'), n.canvas_id,
                c.space_id, s.name
           FROM nodes n
           JOIN canvases c ON c.id = n.canvas_id
           JOIN spaces s ON s.id = c.space_id
          WHERE n.kind = 'task' AND n.kb_result_path IS NOT NULL
          ORDER BY n.kb_result_path, s.sort_order, s.created_at, n.created_at, n.id",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                ResultLink {
                    path: r.get(0)?,
                    id: r.get(1)?,
                    title: r.get(2)?,
                    status: parse_col(3, r.get(3)?)?,
                    space_id: r.get(5)?,
                    space_name: r.get(6)?,
                    parents: Vec::new(),
                    canvas_chain: Vec::new(),
                },
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut out = Vec::with_capacity(rows.len());
    for (mut link, canvas_id) in rows {
        link.parents = owner_titles(conn, &canvas_id)?;
        link.canvas_chain = canvas_chain(conn, &canvas_id)?;
        out.push(link);
    }
    Ok(out)
}

/// Заголовки задач-владельцев холстов от корня пространства до `canvas_id`
/// (у корневого холста — пусто): путь задачи `Задача A › Подзадача B`.
/// Ничейный слой (ТЗ §4.12.3) даёт в пути «Без родителя».
pub fn owner_titles(conn: &Connection, canvas_id: &str) -> AppResult<Vec<String>> {
    Ok(super::canvases::lineage(conn, canvas_id)?.titles)
}

/// Цепочка холстов от корневого холста пространства до `canvas_id` включительно.
pub fn canvas_chain(conn: &Connection, canvas_id: &str) -> AppResult<Vec<String>> {
    Ok(super::canvases::lineage(conn, canvas_id)?.chain)
}
