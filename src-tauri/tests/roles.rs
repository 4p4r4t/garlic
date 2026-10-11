//! «Комментарий» и «Результат» у задачи (ТЗ §4.11, M5.3): миграция v3,
//! валидация роли, переписывание путей обеих ролей, «Ноды графа» с ролью,
//! запрос всех результатов для фильтра проводника, папки по умолчанию.

use std::fs;

use garlic_lib::db::{self, MIGRATIONS};
use garlic_lib::kblink::{self, LinkTarget};
use garlic_lib::model::{LinkRole, NewNode, Node, NodeKind, NodePatch, TaskStatus};
use garlic_lib::repo::{app_state, canvases, kb, nodes, spaces};
use rusqlite::{params, Connection};

fn setup() -> (Connection, String) {
    let conn = db::open_in_memory().expect("open db");
    let space = spaces::ensure_default(&conn).expect("default space");
    (conn, space.root_canvas)
}

fn mk(conn: &Connection, canvas: &str, kind: NodeKind, title: &str) -> Node {
    nodes::create(
        conn,
        &NewNode {
            canvas_id: canvas.into(),
            kind,
            title: title.into(),
            x: 0.0,
            y: 0.0,
        },
    )
    .unwrap()
}

fn patch(comment: Option<Option<&str>>, result: Option<Option<&str>>) -> NodePatch {
    NodePatch {
        kb_path: comment.map(|p| p.map(str::to_owned)),
        kb_result_path: result.map(|p| p.map(str::to_owned)),
        ..NodePatch::default()
    }
}

fn set_result(conn: &Connection, id: &str, p: Option<&str>) -> Node {
    nodes::update(conn, id, &patch(None, Some(p))).unwrap()
}

fn set_comment(conn: &Connection, id: &str, p: Option<&str>) -> Node {
    nodes::update(conn, id, &patch(Some(p), None)).unwrap()
}

fn get(conn: &Connection, id: &str) -> Node {
    nodes::get(conn, id).unwrap()
}

#[test]
fn migration_v3_keeps_task_link_as_comment() {
    // БД версии 2 (M5.2): у задачи одна ссылка в kb_path.
    let mut conn = Connection::open_in_memory().unwrap();
    for sql in &MIGRATIONS[..2] {
        conn.execute_batch(sql).unwrap();
    }
    conn.pragma_update(None, "user_version", 2).unwrap();
    conn.execute_batch(
        "INSERT INTO canvases (id, space_id) VALUES ('c1', 's1');
         INSERT INTO spaces (id, name, root_canvas, created_at, updated_at)
              VALUES ('s1', 'Проект', 'c1', 0, 0);
         INSERT INTO nodes (id, canvas_id, kind, title, status, x, y, created_at, updated_at, kb_path)
              VALUES ('t1', 'c1', 'task', 'Задача', 'todo', 0, 0, 1, 1, 'Задачи/Задача.md'),
                     ('n1', 'c1', 'note', 'Идея', NULL, 0, 0, 2, 2, 'Идея.md');",
    )
    .unwrap();

    db::migrate(&mut conn).unwrap();
    assert_eq!(
        db::schema_version(&conn).unwrap() as usize,
        MIGRATIONS.len()
    );
    assert_eq!(MIGRATIONS.len(), 3);

    let t = get(&conn, "t1");
    assert_eq!(t.kb_path.as_deref(), Some("Задачи/Задача.md"));
    assert!(t.kb_result_path.is_none());
    let n = get(&conn, "n1");
    assert_eq!(n.kb_path.as_deref(), Some("Идея.md"));
    assert!(n.kb_result_path.is_none());

    let linked = kb::linked_nodes(&conn, "Задачи/Задача.md").unwrap();
    assert_eq!(linked.len(), 1);
    assert_eq!(linked[0].role, LinkRole::Comment);
    assert_eq!(
        kb::linked_nodes(&conn, "Идея.md").unwrap()[0].role,
        LinkRole::Note
    );
    assert!(kb::result_links(&conn).unwrap().is_empty());
}

#[test]
fn result_role_only_on_tasks() {
    let (conn, canvas) = setup();
    let task = mk(&conn, &canvas, NodeKind::Task, "Отчёт");
    let note = mk(&conn, &canvas, NodeKind::Note, "Заметка");

    // Путь нормализуется, роли независимы.
    let t = set_result(&conn, &task.id, Some("Результаты\\Отчёт.md"));
    assert_eq!(t.kb_result_path.as_deref(), Some("Результаты/Отчёт.md"));
    assert!(t.kb_path.is_none());
    let t = set_comment(&conn, &task.id, Some("Задачи/Отчёт"));
    assert_eq!(t.kb_path.as_deref(), Some("Задачи/Отчёт"));
    assert_eq!(t.kb_result_path.as_deref(), Some("Результаты/Отчёт.md"));
    // Выход за корень — ошибка, ссылка не меняется.
    assert!(nodes::update(&conn, &task.id, &patch(None, Some(Some("../x.md")))).is_err());
    assert_eq!(
        get(&conn, &task.id).kb_result_path.as_deref(),
        Some("Результаты/Отчёт.md")
    );
    // Отвязать результат — комментарий остаётся.
    let t = set_result(&conn, &task.id, None);
    assert!(t.kb_result_path.is_none());
    assert_eq!(t.kb_path.as_deref(), Some("Задачи/Отчёт"));

    // У заметки «Результата» нет (и через kblink::update_node тоже).
    assert!(nodes::update(&conn, &note.id, &patch(None, Some(Some("a.md")))).is_err());
    assert!(kblink::update_node(&conn, None, &note.id, &patch(None, Some(Some("a.md")))).is_err());
    // null для заметки — допустим (ничего не меняет).
    assert!(set_result(&conn, &note.id, None).kb_result_path.is_none());
}

#[test]
fn rewrite_prefix_covers_both_roles() {
    let (conn, canvas) = setup();
    let a = mk(&conn, &canvas, NodeKind::Task, "A").id;
    let b = mk(&conn, &canvas, NodeKind::Task, "B").id;
    let c = mk(&conn, &canvas, NodeKind::Task, "C").id;
    set_comment(&conn, &a, Some("Проект/Исследование.md"));
    set_result(&conn, &a, Some("Проект/Итог"));
    set_result(&conn, &b, Some("Проект/Итог/Отчёт.md"));
    set_comment(&conn, &b, Some("Проект"));
    set_result(&conn, &c, Some("Проект 2/x.md"));

    // Переименование папки (как внешнее переименование, пойманное watcher'ом):
    // 4 ссылки в двух ролях, «Проект 2/…» не задета.
    assert_eq!(
        kb::rewrite_prefix(&conn, "Проект", "Архив/Проект").unwrap(),
        4
    );
    let na = get(&conn, &a);
    assert_eq!(na.kb_path.as_deref(), Some("Архив/Проект/Исследование.md"));
    assert_eq!(na.kb_result_path.as_deref(), Some("Архив/Проект/Итог"));
    let nb = get(&conn, &b);
    assert_eq!(nb.kb_path.as_deref(), Some("Архив/Проект"));
    assert_eq!(
        nb.kb_result_path.as_deref(),
        Some("Архив/Проект/Итог/Отчёт.md")
    );
    assert_eq!(
        get(&conn, &c).kb_result_path.as_deref(),
        Some("Проект 2/x.md")
    );
    // Эхо — ничего.
    assert_eq!(
        kb::rewrite_prefix(&conn, "Проект", "Архив/Проект").unwrap(),
        0
    );

    // Переименование только папки результата.
    assert_eq!(
        kb::rewrite_prefix(&conn, "Архив/Проект/Итог", "Архив/Проект/Итог v2").unwrap(),
        2
    );
    assert_eq!(
        get(&conn, &a).kb_result_path.as_deref(),
        Some("Архив/Проект/Итог v2")
    );
    assert_eq!(
        get(&conn, &b).kb_result_path.as_deref(),
        Some("Архив/Проект/Итог v2/Отчёт.md")
    );
}

#[test]
fn note_to_folder_rewrites_result_of_two_tasks() {
    let (conn, canvas) = setup();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let a = mk(&conn, &canvas, NodeKind::Task, "Отчёт").id;
    let b = mk(&conn, &canvas, NodeKind::Task, "Ревью").id;

    // «Создать заметку» для «Результата» — в папке результатов по умолчанию.
    let dir_res = kblink::default_folder_for(&conn, LinkRole::Result).unwrap();
    let note =
        kblink::create_target(root, &dir_res, LinkTarget::Note, "Отчёт — результат").unwrap();
    assert_eq!(note, "Результаты/Отчёт — результат.md");
    set_result(&conn, &a, Some(&note));
    set_result(&conn, &b, Some(&note));
    set_comment(&conn, &b, Some(&note));

    // Заметка → папка из поля «Результат» задачи A.
    let folder = kblink::note_to_folder(&conn, root, &note, "Отчёт — результат").unwrap();
    assert_eq!(folder, "Результаты/Отчёт — результат");
    assert!(root
        .join("Результаты/Отчёт — результат/Отчёт — результат.md")
        .is_file());
    set_result(&conn, &a, Some(&folder));
    let moved = format!("{folder}/Отчёт — результат.md");
    assert_eq!(
        get(&conn, &a).kb_result_path.as_deref(),
        Some(folder.as_str())
    );
    // У B обе роли указывали на заметку — обе переписаны на её новый путь.
    let nb = get(&conn, &b);
    assert_eq!(nb.kb_result_path.as_deref(), Some(moved.as_str()));
    assert_eq!(nb.kb_path.as_deref(), Some(moved.as_str()));

    // «Ноды графа»: задача с обеими ролями на одном пути — две записи.
    let linked = kb::linked_nodes(&conn, &moved).unwrap();
    let roles: Vec<_> = linked.iter().map(|n| (n.id.as_str(), n.role)).collect();
    assert_eq!(
        roles,
        [
            (b.as_str(), LinkRole::Comment),
            (b.as_str(), LinkRole::Result)
        ]
    );
    let linked = kb::linked_nodes(&conn, &folder).unwrap();
    assert_eq!(linked.len(), 1);
    assert_eq!(
        (linked[0].id.as_str(), linked[0].role),
        (a.as_str(), LinkRole::Result)
    );
}

#[test]
fn default_folders_per_role() {
    let (conn, _) = setup();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    assert_eq!(
        kblink::default_folder_for(&conn, LinkRole::Note).unwrap(),
        ""
    );
    assert_eq!(
        kblink::default_folder_for(&conn, LinkRole::Comment).unwrap(),
        "Задачи"
    );
    assert_eq!(
        kblink::default_folder_for(&conn, LinkRole::Result).unwrap(),
        "Результаты"
    );

    app_state::set(
        &conn,
        kblink::DEFAULT_COMMENT_FOLDER_KEY,
        "Работа\\Материалы",
    )
    .unwrap();
    app_state::set(&conn, kblink::DEFAULT_RESULT_FOLDER_KEY, "").unwrap();
    assert_eq!(
        kblink::default_folder_for(&conn, LinkRole::Comment).unwrap(),
        "Работа/Материалы"
    );
    // Пустая строка — корень vault (явно выбран в настройках).
    assert_eq!(
        kblink::default_folder_for(&conn, LinkRole::Result).unwrap(),
        ""
    );

    // Папка создаётся по требованию.
    let comment_dir = kblink::default_folder_for(&conn, LinkRole::Comment).unwrap();
    let p = kblink::create_target(root, &comment_dir, LinkTarget::Folder, "Задача: 1").unwrap();
    assert_eq!(p, "Работа/Материалы/Задача 1");
    assert!(fs::metadata(root.join(&p)).unwrap().is_dir());
}

#[test]
fn result_links_for_filter() {
    let (conn, root_canvas) = setup();
    let space = spaces::list(&conn).unwrap().remove(0);
    let other = spaces::create(&conn, "Второе").unwrap();

    let a = mk(&conn, &root_canvas, NodeKind::Task, "Задача A");
    let layer = canvases::get_or_create_child(&conn, &a.id).unwrap();
    let b = mk(&conn, &layer.id, NodeKind::Task, "Подзадача B");
    let layer2 = canvases::get_or_create_child(&conn, &b.id).unwrap();
    let c = mk(&conn, &layer2.id, NodeKind::Task, "Глубже C");
    let d = mk(&conn, &other.root_canvas, NodeKind::Task, "Чужая D");
    let note = mk(&conn, &root_canvas, NodeKind::Note, "Просто заметка");

    set_result(&conn, &a.id, Some("Результаты/A"));
    set_result(&conn, &c.id, Some("Результаты/A/C.md"));
    set_result(&conn, &d.id, Some("Результаты/A"));
    set_comment(&conn, &b.id, Some("Задачи/B.md")); // комментарий — не результат
    set_comment(&conn, &note.id, Some("Просто заметка.md"));
    nodes::set_status_many(&conn, std::slice::from_ref(&c.id), TaskStatus::Done).unwrap();

    let list = kb::result_links(&conn).unwrap();
    let got: Vec<_> = list
        .iter()
        .map(|r| (r.path.as_str(), r.id.as_str()))
        .collect();
    assert_eq!(
        got,
        [
            ("Результаты/A", a.id.as_str()),
            ("Результаты/A", d.id.as_str()),
            ("Результаты/A/C.md", c.id.as_str()),
        ]
    );
    let la = &list[0];
    assert_eq!(la.title, "Задача A");
    assert_eq!(la.status, TaskStatus::Todo);
    assert_eq!(la.space_id, space.id);
    assert_eq!(la.space_name, space.name);
    assert!(la.parents.is_empty());
    assert_eq!(la.canvas_chain, std::slice::from_ref(&root_canvas));
    let ld = &list[1];
    assert_eq!(ld.space_name, "Второе");
    assert_eq!(ld.canvas_chain, std::slice::from_ref(&other.root_canvas));
    let lc = &list[2];
    assert_eq!(lc.status, TaskStatus::Done);
    assert_eq!(lc.parents, ["Задача A", "Подзадача B"]);
    assert_eq!(
        lc.canvas_chain,
        [root_canvas.clone(), layer.id.clone(), layer2.id.clone()]
    );

    // Удаление задачи убирает и её результат; статус — живой.
    nodes::delete_many(&conn, std::slice::from_ref(&d.id)).unwrap();
    nodes::set_status_many(&conn, std::slice::from_ref(&a.id), TaskStatus::InProgress).unwrap();
    let list = kb::result_links(&conn).unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].status, TaskStatus::InProgress);
    // Прямой запрос: колонка результата не пишется у заметок.
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM nodes WHERE kind = 'note' AND kb_result_path IS NOT NULL",
            params![],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
}
