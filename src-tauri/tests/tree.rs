//! Слои и дерево (ТЗ §4.12, M7a): ничейные слои, удаление родителя с выбором
//! судьбы подзадач, «Перенести в задачу…», соседи по уровню, вложенные ноды.

use garlic_lib::db::{self, MIGRATIONS};
use garlic_lib::model::{DeleteMode, HandleSide, NewEdge, NewNode, NodeKind};
use garlic_lib::repo::{canvases, edges, history, nodes, restructure, search, spaces, tasks};
use rusqlite::Connection;

fn setup() -> (Connection, String) {
    let conn = db::open_in_memory().expect("open db");
    let space = spaces::ensure_default(&conn).expect("default space");
    (conn, space.root_canvas)
}

fn node_at(conn: &Connection, canvas: &str, kind: NodeKind, title: &str, x: f64) -> String {
    nodes::create(
        conn,
        &NewNode {
            canvas_id: canvas.into(),
            kind,
            title: title.into(),
            x,
            y: 20.0,
        },
    )
    .expect("create node")
    .id
}

fn task(conn: &Connection, canvas: &str, title: &str) -> String {
    node_at(conn, canvas, NodeKind::Task, title, 10.0)
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
            kind: Default::default(),
            id: None,
        },
    )
    .expect("create edge")
    .id
}

fn child(conn: &Connection, node: &str) -> String {
    canvases::get_or_create_child(conn, node).unwrap().id
}

fn canvas_of(conn: &Connection, node: &str) -> String {
    nodes::get(conn, node).unwrap().canvas_id
}

fn exists(conn: &Connection, table: &str, id: &str) -> bool {
    conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
        [id],
        |r| r.get(0),
    )
    .unwrap()
}

/// Всё содержимое графа в сравнимом виде (без updated_at — его меняют перемещения).
fn dump(conn: &Connection) -> Vec<String> {
    let mut out = Vec::new();
    for (table, cols) in [
        ("canvases", "id, space_id, owner_node, host_canvas"),
        (
            "nodes",
            "id, canvas_id, kind, title, status, color, x, y, kb_path, kb_result_path, created_at",
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

/// Корень: P → Q. Слой P (C): P → A, A → B, заметка N; слой A (CA): A1.
struct Tree {
    root: String,
    p: String,
    q: String,
    c: String,
    a: String,
    b: String,
    n: String,
    ca: String,
    a1: String,
}

fn tree(conn: &Connection, root: &str) -> Tree {
    let p = task(conn, root, "P");
    let q = task(conn, root, "Q");
    edge(conn, root, &p, &q);
    let c = child(conn, &p);
    let a = node_at(conn, &c, NodeKind::Task, "A", 100.0);
    let b = node_at(conn, &c, NodeKind::Task, "B", 400.0);
    let n = node_at(conn, &c, NodeKind::Note, "N", 700.0);
    edge(conn, &c, &p, &a);
    edge(conn, &c, &a, &b);
    let ca = child(conn, &a);
    let a1 = task(conn, &ca, "A1");
    Tree {
        root: root.into(),
        p,
        q,
        c,
        a,
        b,
        n,
        ca,
        a1,
    }
}

#[test]
fn migration_v5_adds_host_canvas_to_existing_db() {
    // БД версии 4 (M7b) с вложенным слоем.
    let mut conn = Connection::open_in_memory().unwrap();
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();
    for sql in &MIGRATIONS[..4] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 4).unwrap();
    conn.execute_batch(
        "INSERT INTO canvases (id, space_id) VALUES ('c1', 's1');
         INSERT INTO spaces (id, name, root_canvas, created_at, updated_at)
              VALUES ('s1', 'Проект', 'c1', 0, 0);
         INSERT INTO nodes (id, canvas_id, kind, title, status, x, y, created_at, updated_at)
              VALUES ('t1', 'c1', 'task', 'Задача', 'todo', 0, 0, 1, 1);
         INSERT INTO canvases (id, space_id, owner_node) VALUES ('c2', 's1', 't1');
         INSERT INTO nodes (id, canvas_id, kind, title, status, x, y, created_at, updated_at)
              VALUES ('t2', 'c2', 'task', 'Подзадача', 'done', 5, 5, 2, 2);",
    )
    .unwrap();

    db::migrate(&mut conn).unwrap();
    assert_eq!(
        db::schema_version(&conn).unwrap() as usize,
        MIGRATIONS.len()
    );
    assert!(MIGRATIONS.len() >= 5);
    let c2 = canvases::get(&conn, "c2").unwrap();
    assert_eq!(c2.owner_node.as_deref(), Some("t1"));
    assert!(c2.host_canvas.is_none());
    assert!(!c2.is_orphan());
    let sub = canvases::load_subtree(&conn, "c1", 3).unwrap();
    assert_eq!(sub.len(), 1);
    assert_eq!(sub[0].nodes[0].id, "t2");
    // Удаление холста-хозяина уносит приютившийся ничейный слой.
    conn.execute_batch(
        "UPDATE canvases SET owner_node = NULL, host_canvas = 'c1' WHERE id = 'c2';
         DELETE FROM nodes WHERE id = 't1';",
    )
    .unwrap();
    assert!(canvases::get(&conn, "c2").unwrap().is_orphan());
    conn.execute_batch("DELETE FROM spaces; DELETE FROM canvases WHERE id = 'c1';")
        .unwrap();
    assert!(!exists(&conn, "canvases", "c2"));
    assert!(!exists(&conn, "nodes", "t2"));
}

#[test]
fn delete_lift_moves_subtasks_to_parent_level_and_reverts() {
    let (conn, root) = setup();
    let t = tree(&conn, &root);
    let start = dump(&conn);

    let change =
        restructure::delete_with_mode(&conn, std::slice::from_ref(&t.p), &[], DeleteMode::Lift)
            .unwrap();
    assert!(!exists(&conn, "nodes", &t.p));
    assert!(!exists(&conn, "canvases", &t.c));
    for id in [&t.a, &t.b, &t.n] {
        assert_eq!(canvas_of(&conn, id), t.root);
    }
    // Координаты те же, поддерево A на месте.
    assert_eq!(nodes::get(&conn, &t.b).unwrap().x, 400.0);
    assert_eq!(canvas_of(&conn, &t.a1), t.ca);
    // Стрелка A → B переехала, стрелка P → A и P → Q удалены.
    let root_edges = edges::list_by_canvas(&conn, &t.root).unwrap();
    assert_eq!(root_edges.len(), 1);
    assert_eq!(
        (root_edges[0].source.as_str(), root_edges[0].target.as_str()),
        (t.a.as_str(), t.b.as_str())
    );

    let lifted = dump(&conn);
    restructure::apply_region(&conn, &change.before).unwrap();
    assert_eq!(dump(&conn), start, "undo возвращает всё как было");
    restructure::apply_region(&conn, &change.after).unwrap();
    assert_eq!(dump(&conn), lifted, "redo повторяет");
    restructure::apply_region(&conn, &change.before).unwrap();
    assert_eq!(dump(&conn), start);
    let _ = t.q;
}

#[test]
fn delete_orphan_keeps_layer_without_parent() {
    let (conn, root) = setup();
    let t = tree(&conn, &root);
    let start = dump(&conn);

    let change =
        restructure::delete_with_mode(&conn, std::slice::from_ref(&t.p), &[], DeleteMode::Orphan)
            .unwrap();
    assert!(!exists(&conn, "nodes", &t.p));
    let c = canvases::get(&conn, &t.c).unwrap();
    assert!(c.is_orphan());
    assert_eq!(c.host_canvas.as_deref(), Some(t.root.as_str()));
    // Стрелка родитель → подзадача ушла, A → B осталась.
    let layer_edges = edges::list_by_canvas(&conn, &t.c).unwrap();
    assert_eq!(layer_edges.len(), 1);
    assert_eq!(layer_edges[0].source, t.a);

    // Ничейный слой просвечивает на уровне бывшего родителя.
    let sub = canvases::load_subtree(&conn, &t.root, 3).unwrap();
    assert_eq!(sub[0].canvas.id, t.c);
    assert_eq!(sub[0].depth, 1);
    assert_eq!(sub[0].path, vec![canvases::ORPHAN_LABEL.to_string()]);
    assert_eq!(sub[1].canvas.id, t.ca);
    assert_eq!(
        sub[1].path,
        vec![canvases::ORPHAN_LABEL.to_string(), "A".into()]
    );
    // Пути и цепочки холстов идут через хозяина.
    let l = canvases::lineage(&conn, &t.ca).unwrap();
    assert_eq!(l.chain, vec![t.root.clone(), t.c.clone(), t.ca.clone()]);
    assert_eq!(
        l.titles,
        vec![canvases::ORPHAN_LABEL.to_string(), "A".into()]
    );
    let hit = search::list_graph_nodes(&conn)
        .unwrap()
        .into_iter()
        .find(|h| h.id == t.a1)
        .unwrap();
    assert_eq!(hit.canvas_chain, l.chain);
    assert_eq!(hit.parents, l.titles);
    let all = tasks::list_all_tasks(&conn).unwrap();
    let a1 = all.iter().find(|x| x.id == t.a1).unwrap();
    assert_eq!(a1.canvas_chain, l.chain);
    assert_eq!(a1.parents, l.titles);
    assert!(all.iter().any(|x| x.id == t.b));
    // Удаление задачи с подзадачами считает и ничейные слои под ней.
    assert_eq!(nodes::count_descendants(&conn, &t.a).unwrap(), 1);

    let orphaned = dump(&conn);
    restructure::apply_region(&conn, &change.before).unwrap();
    assert_eq!(dump(&conn), start);
    restructure::apply_region(&conn, &change.after).unwrap();
    assert_eq!(dump(&conn), orphaned);
}

#[test]
fn delete_orphan_of_empty_layer_just_deletes() {
    let (conn, root) = setup();
    let p = task(&conn, &root, "P");
    let c = child(&conn, &p);
    restructure::delete_with_mode(&conn, std::slice::from_ref(&p), &[], DeleteMode::Orphan)
        .unwrap();
    assert!(!exists(&conn, "canvases", &c));
}

#[test]
fn snapshot_and_restore_carry_hosted_orphans() {
    // Удаление задачи, на чьём слое приютился ничейный слой: снимок забирает его тоже.
    let (conn, root) = setup();
    let x = task(&conn, &root, "X");
    let cx = child(&conn, &x);
    let p = task(&conn, &cx, "P");
    let c = child(&conn, &p);
    let a = task(&conn, &c, "A");
    restructure::delete_with_mode(&conn, std::slice::from_ref(&p), &[], DeleteMode::Orphan)
        .unwrap();
    assert_eq!(nodes::count_descendants(&conn, &x).unwrap(), 1);
    let before = dump(&conn);
    let snap = history::snapshot(&conn, std::slice::from_ref(&x), &[]).unwrap();
    assert!(snap.canvases.iter().any(|k| k.id == c && k.is_orphan()));
    nodes::delete_many(&conn, std::slice::from_ref(&x)).unwrap();
    assert!(!exists(&conn, "nodes", &a));
    history::restore(&conn, &snap).unwrap();
    assert_eq!(dump(&conn), before);
}

#[test]
fn move_into_task_moves_subtrees_and_reverts() {
    let (conn, root) = setup();
    let t = tree(&conn, &root);
    // Корень: ещё задача T; стрелки A? нет — A в слое. Переносим Q и P? Берём слой P.
    let target = task(&conn, &root, "T");
    let e_qt = edge(&conn, &root, &t.q, &target);
    let start = dump(&conn);

    // P (с поддеревом) и Q — в T. Стрелка P → Q едет с ними, Q → T становится
    // стрелкой «подзадача → родитель» слоя T.
    let change = restructure::move_into_task(&conn, &[t.p.clone(), t.q.clone()], &target).unwrap();
    let dest = canvases::get_or_create_child(&conn, &target).unwrap().id;
    assert_eq!(canvas_of(&conn, &t.p), dest);
    assert_eq!(canvas_of(&conn, &t.q), dest);
    assert_eq!(canvas_of(&conn, &t.a), t.c, "поддерево висит на P");
    assert_eq!(nodes::get(&conn, &t.p).unwrap().x, 10.0);
    let dest_edges = edges::list_by_canvas(&conn, &dest).unwrap();
    assert_eq!(dest_edges.len(), 2);
    assert!(dest_edges.iter().any(|e| e.id == e_qt));
    assert!(edges::list_by_canvas(&conn, &root).unwrap().is_empty());
    // Глубина: A1 теперь на 4-м уровне.
    assert_eq!(canvases::lineage(&conn, &t.ca).unwrap().chain.len(), 4);

    let moved = dump(&conn);
    restructure::apply_region(&conn, &change.before).unwrap();
    assert_eq!(dump(&conn), start, "undo убирает и созданный слой T");
    restructure::apply_region(&conn, &change.after).unwrap();
    assert_eq!(dump(&conn), moved);
    let _ = (t.b, t.n, t.a1);
}

#[test]
fn move_into_task_forbids_descendants_and_self() {
    let (conn, root) = setup();
    let t = tree(&conn, &root);
    let err = restructure::move_into_task(&conn, std::slice::from_ref(&t.p), &t.a1).unwrap_err();
    assert!(err.to_string().contains("подзадач"), "{err}");
    let err = restructure::move_into_task(&conn, std::slice::from_ref(&t.p), &t.a).unwrap_err();
    assert!(err.to_string().contains("подзадач"), "{err}");
    let err = restructure::move_into_task(&conn, std::slice::from_ref(&t.p), &t.p).unwrap_err();
    assert!(err.to_string().contains("саму себя"), "{err}");
    // В заметку — нельзя; в соседа — можно.
    assert!(restructure::move_into_task(&conn, std::slice::from_ref(&t.b), &t.n).is_err());
    restructure::move_into_task(&conn, std::slice::from_ref(&t.b), &t.a).unwrap();
    assert_eq!(canvas_of(&conn, &t.b), t.ca);
    // A → B стала стрелкой «родитель → подзадача» слоя A.
    let e = edges::list_by_canvas(&conn, &t.ca).unwrap();
    assert_eq!(e.len(), 1);
    assert_eq!(
        (e[0].source.as_str(), e[0].target.as_str()),
        (t.a.as_str(), t.b.as_str())
    );
}

#[test]
fn move_whole_orphan_layer_deletes_it() {
    let (conn, root) = setup();
    let t = tree(&conn, &root);
    restructure::delete_with_mode(&conn, std::slice::from_ref(&t.p), &[], DeleteMode::Orphan)
        .unwrap();
    let before = dump(&conn);
    let ids: Vec<String> = nodes::list_by_canvas(&conn, &t.c)
        .unwrap()
        .into_iter()
        .map(|n| n.id)
        .collect();
    let change = restructure::move_into_task(&conn, &ids, &t.q).unwrap();
    assert!(
        !exists(&conn, "canvases", &t.c),
        "пустой ничейный слой удалён"
    );
    let dest = canvases::get_or_create_child(&conn, &t.q).unwrap().id;
    assert_eq!(canvas_of(&conn, &t.a), dest);
    assert_eq!(edges::list_by_canvas(&conn, &dest).unwrap().len(), 1);
    restructure::apply_region(&conn, &change.before).unwrap();
    assert_eq!(dump(&conn), before);
    assert!(canvases::get(&conn, &t.c).unwrap().is_orphan());
}

#[test]
fn neighbors_and_descendants() {
    let (conn, root) = setup();
    let t = tree(&conn, &root);
    // Слой Q на том же уровне, что слой P; пустые слои в соседи не попадают.
    let cq = child(&conn, &t.q);
    let empty = task(&conn, &root, "Пустая");
    child(&conn, &empty);
    assert!(canvases::level_neighbors(&conn, &t.c).unwrap().is_empty());
    let q1 = task(&conn, &cq, "Q1");
    let nb = canvases::level_neighbors(&conn, &t.c).unwrap();
    assert_eq!(nb.len(), 1);
    assert_eq!(nb[0].canvas.id, cq);
    assert_eq!(nb[0].parent_title.as_deref(), Some("Q"));
    assert_eq!(nb[0].canvas_chain, vec![root.clone(), cq.clone()]);
    assert_eq!(nb[0].nodes[0].id, q1);
    assert!(canvases::level_neighbors(&conn, &root).unwrap().is_empty());
    // Соседи ничейного слоя подписаны «без родителя» (parent_title = None).
    restructure::delete_with_mode(&conn, std::slice::from_ref(&t.p), &[], DeleteMode::Orphan)
        .unwrap();
    let nb = canvases::level_neighbors(&conn, &cq).unwrap();
    assert_eq!(nb.len(), 1);
    assert_eq!(nb[0].canvas.id, t.c);
    assert!(nb[0].parent_title.is_none());

    // Вложенные ноды с положением: все уровни, без самих корней, без повторов.
    let d = nodes::descendants(&conn, &[t.q.clone(), t.a.clone()]).unwrap();
    let ids: Vec<&str> = d.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, vec![q1.as_str(), t.a1.as_str()]);
    assert_eq!(d[1].canvas_id, t.ca);
}
