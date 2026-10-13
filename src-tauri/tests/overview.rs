//! Интеграционные тесты обзора задач (`list_space_tasks`, ТЗ §4.6.1).

use garlic_lib::db;
use garlic_lib::error::AppError;
use garlic_lib::model::{NewNode, NodeKind, NodePatch, TaskStatus};
use garlic_lib::repo::{canvases, nodes, spaces, tasks};
use rusqlite::Connection;

fn at(conn: &Connection, canvas: &str, kind: NodeKind, title: &str, x: f64, y: f64) -> String {
    nodes::create(
        conn,
        &NewNode {
            canvas_id: canvas.into(),
            kind,
            title: title.into(),
            x,
            y,
        },
    )
    .expect("create node")
    .id
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
fn lists_all_levels_with_parents_and_depth() {
    let conn = db::open_in_memory().unwrap();
    let space = spaces::ensure_default(&conn).unwrap();
    let root = space.root_canvas.clone();

    // Корень: B ниже A, заметка не попадает в список.
    let b = at(&conn, &root, NodeKind::Task, "B", 0.0, 200.0);
    let a = at(&conn, &root, NodeKind::Task, "A", 300.0, 0.0);
    at(&conn, &root, NodeKind::Note, "note", 0.0, 0.0);

    // Уровень 1 под A, уровень 2 под A1.
    let ca = canvases::get_or_create_child(&conn, &a).unwrap();
    let a2 = at(&conn, &ca.id, NodeKind::Task, "A2", 100.0, 50.0);
    let a1 = at(&conn, &ca.id, NodeKind::Task, "A1", 0.0, 50.0);
    at(&conn, &ca.id, NodeKind::Note, "inner note", 0.0, 0.0);
    let ca1 = canvases::get_or_create_child(&conn, &a1).unwrap();
    let a1x = at(&conn, &ca1.id, NodeKind::Task, "A1x", 0.0, 0.0);
    set_status(&conn, &a1x, TaskStatus::Done);
    set_status(&conn, &a2, TaskStatus::InProgress);

    let list = tasks::list_space_tasks(&conn, &space.id).unwrap();
    let ids: Vec<&str> = list.iter().map(|t| t.id.as_str()).collect();
    // По глубине, затем y, затем x.
    assert_eq!(ids, [&a, &b, &a1, &a2, &a1x]);

    let get = |id: &str| list.iter().find(|t| t.id == id).unwrap();
    assert_eq!(get(&a).parent_node_id, None);
    assert_eq!(get(&a).depth, 0);
    assert_eq!(get(&a).canvas_id, root);
    assert_eq!(get(&a1).parent_node_id.as_deref(), Some(a.as_str()));
    assert_eq!(get(&a1).canvas_id, ca.id);
    assert_eq!(get(&a1).depth, 1);
    assert_eq!(get(&a1x).parent_node_id.as_deref(), Some(a1.as_str()));
    assert_eq!(get(&a1x).canvas_id, ca1.id);
    assert_eq!(get(&a1x).depth, 2);
    assert_eq!(get(&a1x).status, TaskStatus::Done);
    assert_eq!(get(&a2).status, TaskStatus::InProgress);
    assert_eq!(get(&b).status, TaskStatus::Todo);
    assert_eq!((get(&a2).x, get(&a2).y), (100.0, 50.0));

    // camelCase для фронта.
    let json = serde_json::to_value(get(&a1x)).unwrap();
    assert_eq!(json["parentNodeId"], a1.as_str());
    assert_eq!(json["canvasId"], ca1.id.as_str());
    assert_eq!(json["status"], "done");
}

#[test]
fn scoped_to_space_and_follows_deletes() {
    let conn = db::open_in_memory().unwrap();
    let main = spaces::ensure_default(&conn).unwrap();
    let other = spaces::create(&conn, "Другое").unwrap();

    let a = at(&conn, &main.root_canvas, NodeKind::Task, "A", 0.0, 0.0);
    let ca = canvases::get_or_create_child(&conn, &a).unwrap();
    at(&conn, &ca.id, NodeKind::Task, "A1", 0.0, 0.0);
    let o = at(&conn, &other.root_canvas, NodeKind::Task, "O", 0.0, 0.0);

    assert_eq!(tasks::list_space_tasks(&conn, &main.id).unwrap().len(), 2);
    let in_other = tasks::list_space_tasks(&conn, &other.id).unwrap();
    assert_eq!(in_other.len(), 1);
    assert_eq!(in_other[0].id, o);

    // Пустое пространство — пустой список; неизвестное — NotFound.
    let empty = spaces::create(&conn, "Пустое").unwrap();
    assert!(tasks::list_space_tasks(&conn, &empty.id)
        .unwrap()
        .is_empty());
    assert!(matches!(
        tasks::list_space_tasks(&conn, "nope"),
        Err(AppError::NotFound(_))
    ));

    // Удаление задачи уносит и её подзадачи.
    nodes::delete_many(&conn, std::slice::from_ref(&a)).unwrap();
    assert!(tasks::list_space_tasks(&conn, &main.id).unwrap().is_empty());
}

#[test]
fn graph_search_lists_all_nodes_with_paths() {
    use garlic_lib::repo::search;
    let conn = db::open_in_memory().unwrap();
    let s1 = spaces::ensure_default(&conn).unwrap();
    let s2 = spaces::create(&conn, "Второе").unwrap();
    let a = at(&conn, &s1.root_canvas, NodeKind::Task, "A", 0.0, 0.0);
    let ca = canvases::get_or_create_child(&conn, &a).unwrap();
    let b = at(&conn, &ca.id, NodeKind::Task, "B", 0.0, 0.0);
    let cb = canvases::get_or_create_child(&conn, &b).unwrap();
    let note = at(&conn, &cb.id, NodeKind::Note, "deep note", 0.0, 0.0);
    set_status(&conn, &b, TaskStatus::Done);
    let other = at(&conn, &s2.root_canvas, NodeKind::Task, "Other", 0.0, 0.0);

    let list = search::list_graph_nodes(&conn).unwrap();
    assert_eq!(list.len(), 4);
    let get = |id: &str| list.iter().find(|h| h.id == id).unwrap();

    let h = get(&note);
    assert_eq!(h.kind, NodeKind::Note);
    assert_eq!(h.status, None);
    assert_eq!(h.space_name, s1.name);
    assert_eq!(h.parents, ["A", "B"]);
    assert_eq!(
        h.canvas_chain,
        [s1.root_canvas.clone(), ca.id.clone(), cb.id.clone()]
    );

    let h = get(&b);
    assert_eq!(h.status, Some(TaskStatus::Done));
    assert_eq!(h.parents, ["A"]);
    assert_eq!(h.canvas_chain, [s1.root_canvas.clone(), ca.id.clone()]);

    let h = get(&a);
    assert!(h.parents.is_empty());
    assert_eq!(h.canvas_chain, [s1.root_canvas.clone()]);

    let h = get(&other);
    assert_eq!(h.space_id, s2.id);
    assert_eq!(h.canvas_chain, [s2.root_canvas.clone()]);
}
