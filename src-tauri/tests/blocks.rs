//! Блокировки (ТЗ §4.12.7, M7c): статусы «Заблокирована» / «Чужая», стикеры,
//! авторазблокировка, отрыв и обратная приклейка, undo через снимки.

use garlic_lib::db::{self, MIGRATIONS};
use garlic_lib::model::{EdgeKind, NewEdge, NewNode, NodeKind, NodePatch, TaskStatus};
use garlic_lib::repo::{blocks, canvases, edges, history, nodes, restructure, spaces, tasks};
use rusqlite::Connection;

fn setup() -> (Connection, String) {
    let conn = db::open_in_memory().expect("open db");
    let space = spaces::ensure_default(&conn).expect("default space");
    (conn, space.root_canvas)
}

fn task(conn: &Connection, canvas: &str, title: &str) -> String {
    nodes::create(
        conn,
        &NewNode {
            canvas_id: canvas.into(),
            kind: NodeKind::Task,
            title: title.into(),
            x: 100.0,
            y: 200.0,
        },
    )
    .unwrap()
    .id
}

fn status(conn: &Connection, id: &str) -> TaskStatus {
    nodes::get(conn, id).unwrap().status.unwrap()
}

fn set_status(conn: &Connection, id: &str, s: TaskStatus) {
    nodes::update(
        conn,
        id,
        &NodePatch {
            status: Some(Some(s)),
            ..Default::default()
        },
    )
    .unwrap();
}

#[test]
fn migration_v6_rebuilds_nodes_keeping_data_indexes_and_trigger() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    for sql in &MIGRATIONS[..5] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 5).unwrap();
    conn.execute_batch(
        "INSERT INTO canvases (id, space_id) VALUES ('c1', 's1');
         INSERT INTO spaces (id, name, root_canvas, created_at, updated_at)
              VALUES ('s1', 'Проект', 'c1', 0, 0);
         INSERT INTO nodes (id, canvas_id, kind, title, status, x, y, created_at, updated_at,
                            kb_path, kb_result_path, status_rank)
              VALUES ('t1', 'c1', 'task', 'Задача', 'in_progress', 1, 2, 1, 1, 'a.md', 'r', 3);
         INSERT INTO canvases (id, space_id, owner_node) VALUES ('c2', 's1', 't1');
         INSERT INTO nodes (id, canvas_id, kind, title, status, x, y, created_at, updated_at)
              VALUES ('t2', 'c2', 'task', 'Подзадача', 'done', 5, 5, 2, 2);
         INSERT INTO nodes (id, canvas_id, kind, title, x, y, created_at, updated_at)
              VALUES ('n1', 'c1', 'note', 'Заметка', 7, 7, 3, 3);
         INSERT INTO edges (id, canvas_id, source, target) VALUES ('e1', 'c1', 't1', 'n1');",
    )
    .unwrap();

    db::migrate(&mut conn).unwrap();
    assert_eq!(
        db::schema_version(&conn).unwrap() as usize,
        MIGRATIONS.len()
    );
    let fk: bool = conn
        .pragma_query_value(None, "foreign_keys", |r| r.get(0))
        .unwrap();
    assert!(fk, "внешние ключи снова включены");

    let t1 = nodes::get(&conn, "t1").unwrap();
    assert_eq!(t1.status, Some(TaskStatus::InProgress));
    assert_eq!(t1.kb_path.as_deref(), Some("a.md"));
    assert_eq!(t1.kb_result_path.as_deref(), Some("r"));
    assert!(t1.prev_status.is_none() && t1.sticker_of.is_none());
    let rank: Option<f64> = conn
        .query_row("SELECT status_rank FROM nodes WHERE id = 't1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(rank, Some(3.0));
    assert_eq!(edges::get(&conn, "e1").unwrap().kind, EdgeKind::Link);
    assert_eq!(
        canvases::get(&conn, "c2").unwrap().owner_node.as_deref(),
        Some("t1")
    );

    // Индексы и триггер на месте.
    for name in [
        "idx_nodes_canvas",
        "idx_nodes_kb_path",
        "idx_nodes_kb_result_path",
        "idx_nodes_sticker",
        "trg_nodes_status_rank",
    ] {
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name = ?1",
                [name],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "{name}");
    }
    set_status(&conn, "t1", TaskStatus::Foreign);
    let rank: Option<f64> = conn
        .query_row("SELECT status_rank FROM nodes WHERE id = 't1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(rank, None, "триггер сбрасывает ранг");

    // Внешние ключи новой таблицы работают: удаление t1 уносит слой и стрелку.
    conn.execute("DELETE FROM nodes WHERE id = 't1'", [])
        .unwrap();
    assert!(canvases::find(&conn, "c2").unwrap().is_none());
    assert!(nodes::find(&conn, "t2").unwrap().is_none());
    assert!(edges::get(&conn, "e1").is_err());
    // CHECK пропускает новые статусы и не пропускает мусор.
    assert!(conn
        .execute("UPDATE nodes SET status = 'nope' WHERE id = 'n1'", [])
        .is_err());
}

#[test]
fn block_creates_sticker_and_done_sticker_unblocks() {
    let (conn, root) = setup();
    let t = task(&conn, &root, "T");
    set_status(&conn, &t, TaskStatus::InProgress);

    let s = blocks::block_task(&conn, &t, "  ждём дизайн ").unwrap();
    assert_eq!(s.title, "ждём дизайн");
    assert_eq!(s.status, Some(TaskStatus::Foreign));
    assert_eq!(s.sticker_of.as_deref(), Some(t.as_str()));
    assert_eq!(s.canvas_id, root);
    let sync = blocks::sync(&conn).unwrap();
    assert_eq!(sync.blocked.len(), 1);
    let tn = nodes::get(&conn, &t).unwrap();
    assert_eq!(tn.status, Some(TaskStatus::Blocked));
    assert_eq!(tn.prev_status, Some(TaskStatus::InProgress));
    // Повторный пересчёт ничего не меняет.
    assert!(blocks::sync(&conn).unwrap().is_empty());

    // Прямо поставить/сменить статус заблокированной нельзя; групповая — пропускает.
    assert!(nodes::update(
        &conn,
        &t,
        &NodePatch {
            status: Some(Some(TaskStatus::Done)),
            ..Default::default()
        }
    )
    .is_err());
    assert!(nodes::set_status_many(&conn, std::slice::from_ref(&t), TaskStatus::Blocked).is_err());
    assert!(
        nodes::set_status_many(&conn, std::slice::from_ref(&t), TaskStatus::Done)
            .unwrap()
            .is_empty()
    );
    assert!(blocks::block_task(&conn, &t, "  ").is_err());
    assert!(blocks::block_task(&conn, &s.id, "стикер").is_err());

    // Стикер «готово» — разблокировка в прежний статус.
    set_status(&conn, &s.id, TaskStatus::Done);
    let sync = blocks::sync(&conn).unwrap();
    assert_eq!(sync.unblocked.len(), 1);
    assert_eq!(sync.unblocked[0].id, t);
    assert_eq!(status(&conn, &t), TaskStatus::InProgress);
    assert!(nodes::get(&conn, &t).unwrap().prev_status.is_none());
    // Undo: стикер снова «Чужая» — снова заблокирована.
    set_status(&conn, &s.id, TaskStatus::Foreign);
    blocks::sync(&conn).unwrap();
    assert_eq!(status(&conn, &t), TaskStatus::Blocked);
}

#[test]
fn two_stickers_delete_and_restore() {
    let (conn, root) = setup();
    let t = task(&conn, &root, "T");
    let s1 = blocks::block_task(&conn, &t, "первая").unwrap();
    let s2 = blocks::block_task(&conn, &t, "вторая").unwrap();
    assert_ne!(
        (s1.x, s1.y),
        (s2.x, s2.y),
        "второй стикер — на другом месте"
    );
    blocks::sync(&conn).unwrap();

    // Прогресс родителя стикеры не считают; список задач их видит.
    let all = tasks::list_all_tasks(&conn).unwrap();
    assert_eq!(
        all.iter()
            .filter(|x| x.status == TaskStatus::Foreign)
            .count(),
        2
    );

    let snap1 = history::snapshot(&conn, std::slice::from_ref(&s1.id), &[]).unwrap();
    nodes::delete_many(&conn, std::slice::from_ref(&s1.id)).unwrap();
    blocks::sync(&conn).unwrap();
    assert_eq!(status(&conn, &t), TaskStatus::Blocked, "вторая ещё держит");
    nodes::delete_many(&conn, std::slice::from_ref(&s2.id)).unwrap();
    let sync = blocks::sync(&conn).unwrap();
    assert_eq!(sync.unblocked.len(), 1);
    assert_eq!(status(&conn, &t), TaskStatus::Todo);

    // Undo удаления: стикер вернулся с привязкой — задача снова заблокирована.
    history::restore(&conn, &snap1).unwrap();
    blocks::sync(&conn).unwrap();
    assert_eq!(
        nodes::get(&conn, &s1.id).unwrap().sticker_of.as_deref(),
        Some(t.as_str())
    );
    assert_eq!(status(&conn, &t), TaskStatus::Blocked);

    // Удаление задачи уносит её стикеры; снимок их содержит.
    let snap = history::snapshot(&conn, std::slice::from_ref(&t), &[]).unwrap();
    assert!(snap.nodes.iter().any(|n| n.id == s1.id));
    nodes::delete_many(&conn, std::slice::from_ref(&t)).unwrap();
    assert!(nodes::find(&conn, &s1.id).unwrap().is_none());
    history::restore(&conn, &snap).unwrap();
    blocks::sync(&conn).unwrap();
    assert_eq!(status(&conn, &t), TaskStatus::Blocked);
    assert_eq!(
        nodes::get(&conn, &t).unwrap().prev_status,
        Some(TaskStatus::Todo)
    );
}

#[test]
fn detach_and_reattach_sticker() {
    let (conn, root) = setup();
    let t = task(&conn, &root, "T");
    let s = blocks::block_task(&conn, &t, "причина").unwrap();
    blocks::sync(&conn).unwrap();

    // Отрыв драгом: обычная нода на мировых координатах + стрелка «блокирует».
    let r = blocks::stick(
        &conn,
        &s.id,
        None,
        Some((600.0, 50.0)),
        Some("edge-1".into()),
    )
    .unwrap();
    assert!(r.node.sticker_of.is_none());
    assert_eq!((r.node.x, r.node.y), (600.0, 50.0));
    let e = r.edge.unwrap();
    assert_eq!(e.id, "edge-1");
    assert_eq!(e.kind, EdgeKind::Blocks);
    assert_eq!(
        (e.source.as_str(), e.target.as_str()),
        (s.id.as_str(), t.as_str())
    );
    assert!(
        blocks::sync(&conn).unwrap().is_empty(),
        "по-прежнему заблокирована"
    );
    assert_eq!(status(&conn, &t), TaskStatus::Blocked);

    // Оторванная «готово» — разблокировка; снова «Чужая» — блокировка.
    set_status(&conn, &s.id, TaskStatus::Done);
    blocks::sync(&conn).unwrap();
    assert_eq!(status(&conn, &t), TaskStatus::Todo);
    set_status(&conn, &s.id, TaskStatus::Foreign);
    blocks::sync(&conn).unwrap();
    assert_eq!(status(&conn, &t), TaskStatus::Blocked);

    // Обратно на задачу: стикер на свободном месте, стрелка исчезает.
    let r = blocks::stick(&conn, &s.id, Some(&t), None, None).unwrap();
    assert_eq!(r.node.sticker_of.as_deref(), Some(t.as_str()));
    assert_eq!((r.node.x, r.node.y), blocks::sticker_slot(0));
    assert!(edges::get(&conn, "edge-1").is_err());
    assert!(blocks::sync(&conn).unwrap().is_empty());

    // Удаление стрелки «блокирует» разблокирует.
    blocks::stick(&conn, &s.id, None, Some((1.0, 1.0)), Some("edge-2".into())).unwrap();
    edges::delete_many(&conn, &["edge-2".to_string()]).unwrap();
    blocks::sync(&conn).unwrap();
    assert_eq!(status(&conn, &t), TaskStatus::Todo);

    // «Разблокировать → оторвать»: без стрелки — блокировка снята.
    blocks::stick(&conn, &s.id, Some(&t), None, None).unwrap();
    blocks::sync(&conn).unwrap();
    assert_eq!(status(&conn, &t), TaskStatus::Blocked);
    let r = blocks::stick(&conn, &s.id, None, None, None).unwrap();
    let (sx, sy) = blocks::sticker_slot(0);
    assert_eq!(
        (r.node.x, r.node.y),
        (100.0 + sx, 200.0 + sy),
        "на месте стикера"
    );
    blocks::sync(&conn).unwrap();
    assert_eq!(status(&conn, &t), TaskStatus::Todo);

    // Запреты.
    assert!(blocks::stick(&conn, &t, Some(&t), None, None).is_err());
    let other = canvases::get_or_create_child(&conn, &t).unwrap().id;
    let far = task(&conn, &other, "в слое");
    assert!(blocks::stick(&conn, &s.id, Some(&far), None, None).is_err());
    // Ручная стрелка «блокирует» — только между задачами одного холста.
    let u = task(&conn, &root, "U");
    edges::create(
        &conn,
        &NewEdge {
            canvas_id: root.clone(),
            source: s.id.clone(),
            target: u.clone(),
            source_handle: None,
            target_handle: None,
            kind: EdgeKind::Blocks,
            id: None,
        },
    )
    .unwrap();
    blocks::sync(&conn).unwrap();
    assert_eq!(status(&conn, &u), TaskStatus::Blocked);
}

#[test]
fn stickers_follow_their_task_into_another_task() {
    let (conn, root) = setup();
    let t = task(&conn, &root, "T");
    let p = task(&conn, &root, "P");
    let s = blocks::block_task(&conn, &t, "причина").unwrap();
    blocks::sync(&conn).unwrap();
    // Стикер отдельно не переносится.
    assert!(restructure::move_into_task(&conn, std::slice::from_ref(&s.id), &p).is_err());
    let change = restructure::move_into_task(&conn, std::slice::from_ref(&t), &p).unwrap();
    let dest = nodes::get(&conn, &t).unwrap().canvas_id;
    assert_ne!(dest, root);
    assert_eq!(nodes::get(&conn, &s.id).unwrap().canvas_id, dest);
    // Прогресс P: только T (стикер не подзадача).
    let prog = canvases::progress(&conn, &root).unwrap();
    let pp = prog.iter().find(|x| x.node_id == p).unwrap();
    assert_eq!((pp.done, pp.total), (0, 1));
    restructure::apply_region(&conn, &change.before).unwrap();
    blocks::sync(&conn).unwrap();
    assert_eq!(nodes::get(&conn, &s.id).unwrap().canvas_id, root);
    assert_eq!(status(&conn, &t), TaskStatus::Blocked);
    // Вложенные ноды для группового перемещения стикеры не включают.
    let q = task(
        &conn,
        &canvases::get_or_create_child(&conn, &p).unwrap().id,
        "Q",
    );
    blocks::block_task(&conn, &q, "x").unwrap();
    let d = nodes::descendants(&conn, std::slice::from_ref(&p)).unwrap();
    assert_eq!(d.len(), 1);
}
