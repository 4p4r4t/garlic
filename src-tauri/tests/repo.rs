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
fn cross_canvas_edges_only_from_anchor() {
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
    assert!(matches!(
        edge(&conn, &child.id, &sub, &parent),
        Err(AppError::Invalid(_))
    ));
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
