//! Интеграционные тесты repo на in-memory SQLite.

use garlic_lib::db;
use garlic_lib::error::AppError;
use garlic_lib::model::{
    HandleSide, NewEdge, NewNode, NodeKind, NodePatch, NodePosition, TaskStatus, Viewport,
};
use garlic_lib::repo::{app_state, canvases, edges, nodes, spaces};
use rusqlite::Connection;

fn setup() -> (Connection, String) {
    let conn = db::open_in_memory().expect("open db");
    let space = spaces::ensure_default(&conn).expect("default space");
    (conn, space.root_canvas)
}

fn node(conn: &Connection, canvas: &str, kind: NodeKind, title: &str) -> String {
    nodes::create(
        conn,
        &NewNode {
            canvas_id: canvas.into(),
            kind,
            title: title.into(),
            x: 10.0,
            y: 20.0,
        },
    )
    .expect("create node")
    .id
}

fn edge(conn: &Connection, canvas: &str, s: &str, t: &str) -> Result<String, AppError> {
    edges::create(
        conn,
        &NewEdge {
            canvas_id: canvas.into(),
            source: s.into(),
            target: t.into(),
            source_handle: Some(HandleSide::Right),
            target_handle: Some(HandleSide::Left),
            kind: Default::default(),
            id: None,
        },
    )
    .map(|e| e.id)
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

#[test]
fn migrations_set_user_version_and_are_idempotent() {
    let mut conn = db::open_in_memory().unwrap();
    assert_eq!(
        db::schema_version(&conn).unwrap() as usize,
        db::MIGRATIONS.len()
    );
    db::migrate(&mut conn).unwrap();
    assert_eq!(
        db::schema_version(&conn).unwrap() as usize,
        db::MIGRATIONS.len()
    );
    let fk: i64 = conn
        .pragma_query_value(None, "foreign_keys", |r| r.get(0))
        .unwrap();
    assert_eq!(fk, 1);
}

#[test]
fn file_db_uses_wal() {
    let dir = std::env::temp_dir().join(format!("garlic-test-{}", garlic_lib::repo::new_id()));
    std::fs::create_dir_all(&dir).unwrap();
    {
        let conn = db::open(&dir.join("t.db")).unwrap();
        let mode: String = conn
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        spaces::ensure_default(&conn).unwrap();
    }
    // Повторное открытие не ломается и не дублирует пространство.
    {
        let conn = db::open(&dir.join("t.db")).unwrap();
        spaces::ensure_default(&conn).unwrap();
        assert_eq!(spaces::list(&conn).unwrap().len(), 1);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn default_space_created_once_with_root_canvas() {
    let (conn, root) = setup();
    let again = spaces::ensure_default(&conn).unwrap();
    assert_eq!(again.root_canvas, root);
    assert_eq!(spaces::list(&conn).unwrap().len(), 1);
    let canvas = canvases::get(&conn, &root).unwrap();
    assert_eq!(canvas.owner_node, None);
    assert_eq!(canvas.space_id, again.id);
    assert_eq!(canvas.viewport, Viewport::default());
}

#[test]
fn space_crud() {
    let (conn, _) = setup();
    let s = spaces::create(&conn, "  Работа ").unwrap();
    assert_eq!(s.name, "Работа");
    assert_eq!(s.sort_order, 1);
    assert!(matches!(
        spaces::create(&conn, "   "),
        Err(AppError::Invalid(_))
    ));
    let s = spaces::rename(&conn, &s.id, "Проект").unwrap();
    assert_eq!(s.name, "Проект");

    let a = node(&conn, &s.root_canvas, NodeKind::Task, "a");
    let child = canvases::get_or_create_child(&conn, &a).unwrap();
    node(&conn, &child.id, NodeKind::Task, "sub");

    spaces::delete(&conn, &s.id).unwrap();
    assert_eq!(spaces::list(&conn).unwrap().len(), 1);
    assert_eq!(count(&conn, "nodes"), 0);
    assert_eq!(count(&conn, "canvases"), 1);

    let last = spaces::list(&conn).unwrap().remove(0);
    assert!(matches!(
        spaces::delete(&conn, &last.id),
        Err(AppError::Invalid(_))
    ));
}

#[test]
fn node_create_and_load() {
    let (conn, root) = setup();
    let t = node(&conn, &root, NodeKind::Task, " Купить чеснок ");
    let n = node(&conn, &root, NodeKind::Note, "Мысли");
    let data = canvases::load(&conn, &root).unwrap();
    assert_eq!(data.nodes.len(), 2);
    let task = data.nodes.iter().find(|x| x.id == t).unwrap();
    assert_eq!(task.title, "Купить чеснок");
    assert_eq!(task.status, Some(TaskStatus::Todo));
    assert_eq!((task.x, task.y), (10.0, 20.0));
    let note = data.nodes.iter().find(|x| x.id == n).unwrap();
    assert_eq!(note.status, None);

    let bad = nodes::create(
        &conn,
        &NewNode {
            canvas_id: "nope".into(),
            kind: NodeKind::Task,
            title: String::new(),
            x: 0.0,
            y: 0.0,
        },
    );
    assert!(matches!(bad, Err(AppError::NotFound(_))));
}

#[test]
fn node_update_patch_rules() {
    let (conn, root) = setup();
    let t = node(&conn, &root, NodeKind::Task, "t");
    let n = node(&conn, &root, NodeKind::Note, "n");

    let upd = nodes::update(
        &conn,
        &t,
        &NodePatch {
            title: Some("новое".into()),
            status: Some(Some(TaskStatus::InProgress)),
            color: Some(Some("teal".into())),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(upd.title, "новое");
    assert_eq!(upd.status, Some(TaskStatus::InProgress));
    assert_eq!(upd.color.as_deref(), Some("teal"));
    assert_eq!(nodes::get(&conn, &t).unwrap(), upd);

    // Отсутствующие поля не трогаются, null сбрасывает.
    let upd = nodes::update(
        &conn,
        &t,
        &NodePatch {
            color: Some(None),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(upd.color, None);
    assert_eq!(upd.title, "новое");

    let status_note = NodePatch {
        status: Some(Some(TaskStatus::Done)),
        ..Default::default()
    };
    assert!(matches!(
        nodes::update(&conn, &n, &status_note),
        Err(AppError::Invalid(_))
    ));
    let clear_status = NodePatch {
        status: Some(None),
        ..Default::default()
    };
    assert!(matches!(
        nodes::update(&conn, &t, &clear_status),
        Err(AppError::Invalid(_))
    ));
    let bad_color = NodePatch {
        color: Some(Some("pink".into())),
        ..Default::default()
    };
    assert!(matches!(
        nodes::update(&conn, &t, &bad_color),
        Err(AppError::Invalid(_))
    ));
}

#[test]
fn node_patch_json_distinguishes_missing_and_null() {
    let p: NodePatch = serde_json::from_str(r#"{"title":"x"}"#).unwrap();
    assert_eq!(p.color, None);
    let p: NodePatch = serde_json::from_str(r#"{"color":null}"#).unwrap();
    assert_eq!(p.color, Some(None));
    let p: NodePatch = serde_json::from_str(r#"{"status":"in_progress"}"#).unwrap();
    assert_eq!(p.status, Some(Some(TaskStatus::InProgress)));
}

#[test]
fn move_nodes_is_atomic() {
    let (conn, root) = setup();
    let a = node(&conn, &root, NodeKind::Task, "a");
    let b = node(&conn, &root, NodeKind::Note, "b");
    nodes::move_many(
        &conn,
        &[
            NodePosition {
                id: a.clone(),
                x: 100.0,
                y: -50.5,
            },
            NodePosition {
                id: b.clone(),
                x: 1.0,
                y: 2.0,
            },
        ],
    )
    .unwrap();
    let na = nodes::get(&conn, &a).unwrap();
    assert_eq!((na.x, na.y), (100.0, -50.5));

    let res = nodes::move_many(
        &conn,
        &[
            NodePosition {
                id: a.clone(),
                x: 0.0,
                y: 0.0,
            },
            NodePosition {
                id: "missing".into(),
                x: 0.0,
                y: 0.0,
            },
        ],
    );
    assert!(matches!(res, Err(AppError::NotFound(_))));
    let na = nodes::get(&conn, &a).unwrap();
    assert_eq!((na.x, na.y), (100.0, -50.5), "rollback");
}

#[test]
fn edges_create_validate_and_delete() {
    let (conn, root) = setup();
    let a = node(&conn, &root, NodeKind::Task, "a");
    let b = node(&conn, &root, NodeKind::Note, "b");

    let e = edge(&conn, &root, &a, &b).unwrap();
    let loaded = canvases::load(&conn, &root).unwrap();
    assert_eq!(loaded.edges.len(), 1);
    assert_eq!(loaded.edges[0].source_handle, Some(HandleSide::Right));
    assert_eq!(loaded.edges[0].target_handle, Some(HandleSide::Left));

    assert!(
        matches!(edge(&conn, &root, &a, &b), Err(AppError::Invalid(_))),
        "dup"
    );
    assert!(
        matches!(edge(&conn, &root, &a, &a), Err(AppError::Invalid(_))),
        "loop"
    );
    edge(&conn, &root, &b, &a).expect("reverse direction is allowed");

    assert_eq!(
        edges::delete_many(&conn, &[e, "missing".into()]).unwrap(),
        1
    );
    assert_eq!(canvases::load(&conn, &root).unwrap().edges.len(), 1);
}

#[test]
fn cross_canvas_edges_only_with_anchor() {
    let (conn, root) = setup();
    let parent = node(&conn, &root, NodeKind::Task, "parent");
    let other = node(&conn, &root, NodeKind::Task, "other");
    let child = canvases::get_or_create_child(&conn, &parent).unwrap();
    assert_eq!(child.owner_node.as_deref(), Some(parent.as_str()));
    assert_eq!(
        canvases::get_or_create_child(&conn, &parent).unwrap(),
        child
    );
    let sub = node(&conn, &child.id, NodeKind::Task, "sub");

    edge(&conn, &child.id, &parent, &sub).expect("anchor -> subtask");
    assert!(matches!(
        edge(&conn, &child.id, &other, &sub),
        Err(AppError::Invalid(_))
    ));
    // Подзадача → родитель: тоже допустимо, направление сохраняется (ТЗ §4.5).
    let back = edge(&conn, &child.id, &sub, &parent).expect("subtask -> anchor");
    let back = edges::get(&conn, &back).unwrap();
    assert_eq!(
        (back.source.as_str(), back.target.as_str()),
        (sub.as_str(), parent.as_str())
    );
    assert_eq!(back.canvas_id, child.id);
    assert!(matches!(
        edge(&conn, &child.id, &sub, &parent),
        Err(AppError::Invalid(_))
    ));
    assert!(matches!(
        edge(&conn, &child.id, &sub, &other),
        Err(AppError::Invalid(_))
    ));
    // Межуровневая стрелка — только в холсте, чей владелец её конец.
    assert!(matches!(
        edge(&conn, &root, &sub, &parent),
        Err(AppError::Invalid(_))
    ));
    let data = canvases::load(&conn, &child.id).unwrap();
    assert_eq!(data.edges.len(), 2);
    assert!(matches!(
        edge(&conn, &root, &parent, &sub),
        Err(AppError::Invalid(_))
    ));

    let note = node(&conn, &root, NodeKind::Note, "note");
    assert!(matches!(
        canvases::get_or_create_child(&conn, &note),
        Err(AppError::Invalid(_))
    ));
}

#[test]
fn delete_nodes_cascades_through_layers() {
    let (conn, root) = setup();
    let a = node(&conn, &root, NodeKind::Task, "a");
    let b = node(&conn, &root, NodeKind::Task, "b");
    edge(&conn, &root, &a, &b).unwrap();

    let l1 = canvases::get_or_create_child(&conn, &a).unwrap();
    let s1 = node(&conn, &l1.id, NodeKind::Task, "s1");
    edge(&conn, &l1.id, &a, &s1).unwrap();
    let l2 = canvases::get_or_create_child(&conn, &s1).unwrap();
    node(&conn, &l2.id, NodeKind::Note, "deep");
    node(&conn, &l2.id, NodeKind::Task, "deep2");

    assert_eq!(nodes::count_descendants(&conn, &a).unwrap(), 3);
    assert_eq!(nodes::count_descendants(&conn, &b).unwrap(), 0);

    assert_eq!(
        nodes::delete_many(&conn, std::slice::from_ref(&a)).unwrap(),
        1
    );
    assert_eq!(count(&conn, "nodes"), 1, "only b remains");
    assert_eq!(count(&conn, "edges"), 0);
    assert_eq!(count(&conn, "canvases"), 1, "only root remains");
    assert!(nodes::find(&conn, &b).unwrap().is_some());
}

#[test]
fn viewport_and_app_state() {
    let (conn, root) = setup();
    let vp = Viewport {
        x: -120.0,
        y: 40.5,
        zoom: 1.5,
    };
    canvases::save_viewport(&conn, &root, vp).unwrap();
    assert_eq!(canvases::get(&conn, &root).unwrap().viewport, vp);
    assert!(matches!(
        canvases::save_viewport(
            &conn,
            &root,
            Viewport {
                x: 0.0,
                y: 0.0,
                zoom: 0.0
            }
        ),
        Err(AppError::Invalid(_))
    ));
    assert!(matches!(
        canvases::save_viewport(&conn, "missing", vp),
        Err(AppError::NotFound(_))
    ));

    assert_eq!(
        app_state::get(&conn, app_state::ACTIVE_SPACE).unwrap(),
        None
    );
    app_state::set(&conn, app_state::ACTIVE_SPACE, "x").unwrap();
    app_state::set(&conn, app_state::ACTIVE_SPACE, "y").unwrap();
    assert_eq!(
        app_state::get(&conn, app_state::ACTIVE_SPACE)
            .unwrap()
            .as_deref(),
        Some("y")
    );
}

/// Правила, на которые опирается панель пространств (M4).
#[test]
fn spaces_panel_rules() {
    let (conn, main_root) = setup();
    let main = spaces::list(&conn).unwrap().remove(0);
    let b = spaces::create(&conn, "B").unwrap();
    let c = spaces::create(&conn, "C").unwrap();
    // Порядок списка — порядок создания.
    let names: Vec<_> = spaces::list(&conn)
        .unwrap()
        .into_iter()
        .map(|s| s.name)
        .collect();
    assert_eq!(names, [main.name.as_str(), "B", "C"]);

    // Неизвестный id — NotFound, пустое имя при переименовании — Invalid.
    assert!(matches!(
        spaces::rename(&conn, "nope", "x"),
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        spaces::delete(&conn, "nope"),
        Err(AppError::NotFound(_))
    ));
    assert!(matches!(
        spaces::rename(&conn, &b.id, "  "),
        Err(AppError::Invalid(_))
    ));

    // Вьюпорт пространства живёт в корневом холсте и не зависит от других пространств.
    let vp = Viewport {
        x: 12.0,
        y: -40.0,
        zoom: 1.5,
    };
    canvases::save_viewport(&conn, &b.root_canvas, vp).unwrap();
    assert_eq!(canvases::get(&conn, &b.root_canvas).unwrap().viewport, vp);
    assert_eq!(
        canvases::get(&conn, &main_root).unwrap().viewport,
        Viewport::default()
    );

    // Удаление одного пространства не трогает данные других.
    node(&conn, &main_root, NodeKind::Task, "keep");
    node(&conn, &c.root_canvas, NodeKind::Note, "drop");
    spaces::delete(&conn, &c.id).unwrap();
    assert_eq!(count(&conn, "nodes"), 1);
    assert_eq!(count(&conn, "canvases"), 2);
    assert!(spaces::find(&conn, &c.id).unwrap().is_none());

    // Последнее пространство остаётся всегда.
    spaces::delete(&conn, &b.id).unwrap();
    assert!(matches!(
        spaces::delete(&conn, &main.id),
        Err(AppError::Invalid(_))
    ));
}

fn set_status(conn: &Connection, id: &str, status: TaskStatus) {
    nodes::update(
        conn,
        id,
        &NodePatch {
            status: Some(Some(status)),
            ..Default::default()
        },
    )
    .unwrap();
}

#[test]
fn set_status_many_updates_tasks_and_skips_notes() {
    let (conn, root) = setup();
    let a = node(&conn, &root, NodeKind::Task, "a");
    let b = node(&conn, &root, NodeKind::Task, "b");
    let n = node(&conn, &root, NodeKind::Note, "n");
    let ids = vec![a.clone(), n.clone(), b.clone(), "missing".to_string()];
    let updated = nodes::set_status_many(&conn, &ids, TaskStatus::Done).unwrap();
    assert_eq!(
        updated.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        vec![a.as_str(), b.as_str()]
    );
    assert!(updated.iter().all(|m| m.status == Some(TaskStatus::Done)));
    assert_eq!(
        nodes::get(&conn, &a).unwrap().status,
        Some(TaskStatus::Done)
    );
    assert_eq!(nodes::get(&conn, &n).unwrap().status, None);
    let updated =
        nodes::set_status_many(&conn, std::slice::from_ref(&b), TaskStatus::InProgress).unwrap();
    assert_eq!(updated[0].status, Some(TaskStatus::InProgress));
    assert!(nodes::set_status_many(&conn, &[], TaskStatus::Todo)
        .unwrap()
        .is_empty());
}

#[test]
fn progress_counts_direct_subtasks_only() {
    let (conn, root) = setup();
    let a = node(&conn, &root, NodeKind::Task, "A");
    let empty = node(&conn, &root, NodeKind::Task, "empty");
    node(&conn, &root, NodeKind::Task, "plain");

    // У A: 3 задачи (2 done) + заметка; у подзадачи A1 — ещё 2 задачи.
    let ca = canvases::get_or_create_child(&conn, &a).unwrap();
    let a1 = node(&conn, &ca.id, NodeKind::Task, "A1");
    let a2 = node(&conn, &ca.id, NodeKind::Task, "A2");
    node(&conn, &ca.id, NodeKind::Task, "A3");
    node(&conn, &ca.id, NodeKind::Note, "note");
    set_status(&conn, &a1, TaskStatus::Done);
    set_status(&conn, &a2, TaskStatus::Done);
    let ca1 = canvases::get_or_create_child(&conn, &a1).unwrap();
    node(&conn, &ca1.id, NodeKind::Task, "A1a");
    node(&conn, &ca1.id, NodeKind::Task, "A1b");
    // Пустой вложенный холст — без бейджа.
    canvases::get_or_create_child(&conn, &empty).unwrap();

    let data = canvases::load(&conn, &root).unwrap();
    assert_eq!(data.progress.len(), 1);
    let p = &data.progress[0];
    assert_eq!((p.node_id.as_str(), p.done, p.total), (a.as_str(), 2, 3));

    let inner = canvases::load(&conn, &ca.id).unwrap();
    assert_eq!(inner.progress.len(), 1);
    assert_eq!(
        (
            inner.progress[0].node_id.as_str(),
            inner.progress[0].done,
            inner.progress[0].total
        ),
        (a1.as_str(), 0, 2)
    );

    // Статус меняется — прогресс тоже.
    set_status(&conn, &a2, TaskStatus::InProgress);
    let p = &canvases::load(&conn, &root).unwrap().progress[0];
    assert_eq!((p.done, p.total), (1, 3));
}

#[test]
fn load_subtree_returns_levels_with_paths_up_to_depth() {
    let (conn, root) = setup();
    let a = node(&conn, &root, NodeKind::Task, "Задача A");
    let b = node(&conn, &root, NodeKind::Task, "Задача B");
    let ca = canvases::get_or_create_child(&conn, &a).unwrap();
    let a1 = node(&conn, &ca.id, NodeKind::Task, "Подзадача A1");
    let a2 = node(&conn, &ca.id, NodeKind::Note, "Заметка A2");
    edge(&conn, &ca.id, &a, &a1).unwrap(); // якорь → подзадача
    edge(&conn, &ca.id, &a1, &a2).unwrap();
    let ca1 = canvases::get_or_create_child(&conn, &a1).unwrap();
    let a1x = node(&conn, &ca1.id, NodeKind::Task, "Глубже");
    let ca1x = canvases::get_or_create_child(&conn, &a1x).unwrap();
    let deepest = node(&conn, &ca1x.id, NodeKind::Task, "Самое дно");
    let cb = canvases::get_or_create_child(&conn, &b).unwrap();
    node(&conn, &cb.id, NodeKind::Task, "Подзадача B1");

    // Другое пространство не протекает.
    let other = spaces::create(&conn, "Другое").unwrap();
    let foreign = node(&conn, &other.root_canvas, NodeKind::Task, "чужая");
    let cf = canvases::get_or_create_child(&conn, &foreign).unwrap();
    node(&conn, &cf.id, NodeKind::Task, "чужая подзадача");

    let all = canvases::load_subtree(&conn, &root, 10).unwrap();
    let ids: Vec<&str> = all.iter().map(|l| l.canvas.id.as_str()).collect();
    assert_eq!(all.len(), 4);
    assert!(!ids.contains(&cf.id.as_str()));
    assert!(all.windows(2).all(|w| w[0].depth <= w[1].depth));

    let la = all.iter().find(|l| l.canvas.id == ca.id).unwrap();
    assert_eq!(la.depth, 1);
    assert_eq!(la.canvas.owner_node.as_deref(), Some(a.as_str()));
    assert_eq!(la.path, vec!["Задача A".to_string()]);
    assert_eq!(la.nodes.len(), 2);
    assert_eq!(la.edges.len(), 2);
    assert_eq!(la.progress.len(), 1); // у A1 есть подзадача
    let l1x = all.iter().find(|l| l.canvas.id == ca1x.id).unwrap();
    assert_eq!(l1x.depth, 3);
    assert_eq!(l1x.path, vec!["Задача A", "Подзадача A1", "Глубже"]);
    assert_eq!(l1x.nodes[0].id, deepest);

    // Ограничение глубины.
    let two = canvases::load_subtree(&conn, &root, 2).unwrap();
    assert_eq!(two.len(), 3);
    assert!(two.iter().all(|l| l.depth <= 2));
    assert!(canvases::load_subtree(&conn, &root, 0).unwrap().is_empty());

    // Из слоя: глубина и путь считаются от него.
    let from_a = canvases::load_subtree(&conn, &ca.id, 3).unwrap();
    assert_eq!(from_a.len(), 2);
    assert_eq!(from_a[0].canvas.id, ca1.id);
    assert_eq!(from_a[0].depth, 1);
    assert_eq!(from_a[0].path, vec!["Подзадача A1".to_string()]);

    // Лист и неизвестный холст.
    assert!(canvases::load_subtree(&conn, &ca1x.id, 3)
        .unwrap()
        .is_empty());
    assert!(matches!(
        canvases::load_subtree(&conn, "nope", 3),
        Err(AppError::NotFound(_))
    ));

    // Удаление задачи уносит её поддерево.
    nodes::delete_many(&conn, std::slice::from_ref(&a)).unwrap();
    let rest = canvases::load_subtree(&conn, &root, 10).unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0].canvas.id, cb.id);
}
