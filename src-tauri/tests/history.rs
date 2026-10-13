//! Снимок/восстановление части графа для undo/redo (ТЗ M6a).

use garlic_lib::db;
use garlic_lib::model::{HandleSide, NewEdge, NewNode, NodeKind, NodePatch, TaskStatus};
use garlic_lib::repo::{canvases, edges, history, nodes, spaces};
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

fn edge(conn: &Connection, canvas: &str, s: &str, t: &str) -> String {
    edges::create(
        conn,
        &NewEdge {
            canvas_id: canvas.into(),
            source: s.into(),
            target: t.into(),
            source_handle: Some(HandleSide::Right),
            target_handle: None,
        },
    )
    .expect("create edge")
    .id
}

fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

/// Всё содержимое графа в сравнимом виде.
fn dump(conn: &Connection) -> Vec<String> {
    let mut out = Vec::new();
    for (table, cols) in [
        (
            "canvases",
            "id, space_id, owner_node, viewport_x, viewport_y, zoom",
        ),
        (
            "nodes",
            "id, canvas_id, kind, title, status, color, x, y, kb_path, kb_result_path, created_at, updated_at",
        ),
        (
            "edges",
            "id, canvas_id, source, target, source_handle, target_handle",
        ),
    ] {
        let mut stmt = conn
            .prepare(&format!("SELECT {cols} FROM {table} ORDER BY id"))
            .unwrap();
        let n = stmt.column_count();
        let rows = stmt
            .query_map([], |r| {
                let mut s = String::from(table);
                for i in 0..n {
                    let v: rusqlite::types::Value = r.get(i)?;
                    s.push_str(&format!("|{v:?}"));
                }
                Ok(s)
            })
            .unwrap();
        out.extend(rows.map(Result::unwrap));
    }
    out
}

/// Корень: A → B, C → A. Слой A: A → A1, A1 → A2, заметка N. Слой A1: A1a → A1.
struct Tree {
    root: String,
    a: String,
    b: String,
    a1: String,
    a1a: String,
}

fn tree(conn: &Connection, root: &str) -> Tree {
    let a = node(conn, root, NodeKind::Task, "A");
    let b = node(conn, root, NodeKind::Task, "B");
    let c = node(conn, root, NodeKind::Note, "C");
    edge(conn, root, &a, &b);
    edge(conn, root, &c, &a);
    let la = canvases::get_or_create_child(conn, &a).unwrap().id;
    let a1 = node(conn, &la, NodeKind::Task, "A1");
    let a2 = node(conn, &la, NodeKind::Task, "A2");
    let n = node(conn, &la, NodeKind::Note, "N");
    nodes::update(
        conn,
        &a1,
        &NodePatch {
            status: Some(Some(TaskStatus::Done)),
            color: Some(Some("teal".into())),
            kb_path: Some(Some("Задачи/A1.md".into())),
            kb_result_path: Some(Some("Результаты/A1".into())),
            ..Default::default()
        },
    )
    .unwrap();
    nodes::update(
        conn,
        &n,
        &NodePatch {
            kb_path: Some(Some("N.md".into())),
            ..Default::default()
        },
    )
    .unwrap();
    edge(conn, &la, &a, &a1);
    edge(conn, &la, &a1, &a2);
    let la1 = canvases::get_or_create_child(conn, &a1).unwrap().id;
    let a1a = node(conn, &la1, NodeKind::Task, "A1a");
    edge(conn, &la1, &a1a, &a1);
    Tree {
        root: root.into(),
        a,
        b,
        a1,
        a1a,
    }
}

#[test]
fn snapshot_delete_restore_round_trips_nested_subtree() {
    let (conn, root) = setup();
    let t = tree(&conn, &root);
    let before = dump(&conn);

    let snap = history::snapshot(&conn, std::slice::from_ref(&t.a), &[]).unwrap();
    assert_eq!(snap.canvases.len(), 2, "слой A и слой A1");
    assert_eq!(snap.nodes.len(), 5, "A, A1, A2, N, A1a");
    assert_eq!(snap.nodes[0].id, t.a, "сама нода — первой");
    // A → B и C → A на корне, A → A1 и A1 → A2 в слое A, A1a → A1 в слое A1.
    assert_eq!(snap.edges.len(), 5);

    nodes::delete_many(&conn, std::slice::from_ref(&t.a)).unwrap();
    assert_eq!(count(&conn, "nodes"), 2);
    assert_eq!(count(&conn, "edges"), 0);
    assert_eq!(count(&conn, "canvases"), 1);

    assert_eq!(history::restore(&conn, &snap).unwrap(), 5);
    assert_eq!(dump(&conn), before, "всё вернулось с теми же id и полями");
    let p = canvases::progress(&conn, &t.root).unwrap();
    assert_eq!(p.len(), 1);
    assert_eq!((p[0].done, p[0].total), (1, 2), "бейдж A снова 1/2");
}

#[test]
fn restore_twice_fails_and_changes_nothing() {
    let (conn, root) = setup();
    let t = tree(&conn, &root);
    let snap = history::snapshot(&conn, std::slice::from_ref(&t.a1), &[]).unwrap();
    let before = dump(&conn);
    assert!(history::restore(&conn, &snap).is_err(), "id заняты");
    assert_eq!(dump(&conn), before);
}

#[test]
fn restore_fails_when_parent_canvas_is_gone() {
    let (conn, root) = setup();
    let t = tree(&conn, &root);
    // Подзадача A1 удалена, затем удалён и её родитель A (слой A исчез).
    let snap = history::snapshot(&conn, std::slice::from_ref(&t.a1), &[]).unwrap();
    nodes::delete_many(&conn, std::slice::from_ref(&t.a1)).unwrap();
    nodes::delete_many(&conn, std::slice::from_ref(&t.a)).unwrap();
    let before = dump(&conn);
    let err = history::restore(&conn, &snap).unwrap_err().to_string();
    assert!(err.contains("не найдено"), "{err}");
    assert_eq!(dump(&conn), before, "транзакция откатилась целиком");
}

#[test]
fn restore_skips_edges_whose_other_end_is_gone() {
    let (conn, root) = setup();
    let t = tree(&conn, &root);
    let snap = history::snapshot(&conn, std::slice::from_ref(&t.b), &[]).unwrap();
    assert_eq!(snap.edges.len(), 1, "A → B");
    nodes::delete_many(&conn, std::slice::from_ref(&t.b)).unwrap();
    nodes::delete_many(&conn, std::slice::from_ref(&t.a)).unwrap();
    assert_eq!(history::restore(&conn, &snap).unwrap(), 1);
    assert!(nodes::find(&conn, &t.b).unwrap().is_some());
    assert_eq!(count(&conn, "edges"), 0, "стрелку к удалённой A не вернуть");
}

#[test]
fn edges_only_snapshot_and_restore() {
    let (conn, root) = setup();
    let t = tree(&conn, &root);
    let ids: Vec<String> = edges::list_by_canvas(&conn, &t.root)
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect();
    let snap = history::snapshot(&conn, &[], &ids).unwrap();
    assert!(snap.nodes.is_empty() && snap.canvases.is_empty());
    assert_eq!(snap.edges.len(), 2);
    let before = dump(&conn);
    edges::delete_many(&conn, &ids).unwrap();
    assert_eq!(history::restore(&conn, &snap).unwrap(), 0);
    assert_eq!(dump(&conn), before);

    // Ту же стрелку провели заново (другой id) — восстановление её пропускает.
    edges::delete_many(&conn, &ids).unwrap();
    edge(&conn, &t.root, &t.a, &t.b);
    history::restore(&conn, &snap).unwrap();
    assert_eq!(edges::list_by_canvas(&conn, &t.root).unwrap().len(), 2);
}

#[test]
fn snapshot_of_several_nodes_dedups_shared_edges() {
    let (conn, root) = setup();
    let t = tree(&conn, &root);
    let ids = vec![
        t.a.clone(),
        t.b.clone(),
        t.a1a.clone(),
        "нет такой".to_string(),
    ];
    let snap = history::snapshot(&conn, &ids, &[]).unwrap();
    // A1a — и запрошенная, и вложенная в A: один раз.
    assert_eq!(snap.nodes.len(), 6);
    let mut e: Vec<_> = snap.edges.iter().map(|e| e.id.clone()).collect();
    e.sort();
    e.dedup();
    assert_eq!(e.len(), snap.edges.len());
    assert_eq!(snap.edges.len(), 5);
    let before = dump(&conn);
    nodes::delete_many(&conn, &ids).unwrap();
    history::restore(&conn, &snap).unwrap();
    assert_eq!(dump(&conn), before);
}
