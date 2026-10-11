//! Ссылки нод на базу знаний (ТЗ §4.10, M5.2): поле-ссылка, «заметка → папка»,
//! нода-заметка как карточка `.md`, проверка ссылок, миграция старых заметок.

use std::fs;
use std::path::Path;

use garlic_lib::db;
use garlic_lib::kblink::{self, LinkTarget};
use garlic_lib::model::{NewNode, Node, NodeKind, NodePatch};
use garlic_lib::repo::{app_state, canvases, kb, nodes, spaces};
use garlic_lib::vault::{self, names};
use rusqlite::Connection;

fn setup() -> (Connection, String, tempfile::TempDir) {
    let conn = db::open_in_memory().expect("open db");
    let space = spaces::ensure_default(&conn).expect("default space");
    (
        conn,
        space.root_canvas,
        tempfile::tempdir().expect("tempdir"),
    )
}

fn input(canvas: &str, kind: NodeKind, title: &str) -> NewNode {
    NewNode {
        canvas_id: canvas.into(),
        kind,
        title: title.into(),
        x: 0.0,
        y: 0.0,
    }
}

fn link(conn: &Connection, id: &str, path: Option<&str>) -> Node {
    nodes::update(
        conn,
        id,
        &NodePatch {
            kb_path: Some(path.map(str::to_owned)),
            ..NodePatch::default()
        },
    )
    .unwrap()
}

fn title(conn: &Connection, root: Option<&Path>, id: &str, t: &str) -> Node {
    kblink::update_node(
        conn,
        root,
        id,
        &NodePatch {
            title: Some(t.into()),
            ..NodePatch::default()
        },
    )
    .unwrap()
}

#[test]
fn note_node_gets_md_in_default_folder() {
    let (conn, canvas, dir) = setup();
    let root = dir.path();
    // По умолчанию — корень vault.
    let a = kblink::create_node(&conn, Some(root), &input(&canvas, NodeKind::Note, "")).unwrap();
    assert_eq!(a.kb_path.as_deref(), Some("Без названия.md"));
    assert_eq!(a.title, "Без названия");
    assert!(root.join("Без названия.md").is_file());
    let b = kblink::create_node(&conn, Some(root), &input(&canvas, NodeKind::Note, "")).unwrap();
    assert_eq!(b.kb_path.as_deref(), Some("Без названия 2.md"));
    assert_eq!(b.title, "Без названия 2");

    // Папка по умолчанию из настроек создаётся при отсутствии.
    app_state::set(&conn, vault::DEFAULT_FOLDER_KEY, "Входящие/Граф").unwrap();
    let c = kblink::create_node(
        &conn,
        Some(root),
        &input(&canvas, NodeKind::Note, "План: Q1"),
    )
    .unwrap();
    assert_eq!(c.kb_path.as_deref(), Some("Входящие/Граф/План Q1.md"));
    assert_eq!(c.title, "План Q1");

    // Задача файла не получает; без vault заметка создаётся без ссылки.
    let t = kblink::create_node(&conn, Some(root), &input(&canvas, NodeKind::Task, "x")).unwrap();
    assert_eq!(t.kb_path, None);
    let d = kblink::create_node(&conn, None, &input(&canvas, NodeKind::Note, "y")).unwrap();
    assert_eq!(d.kb_path, None);
    assert_eq!(d.title, "y");
}

#[test]
fn note_title_renames_file_and_back() {
    let (conn, canvas, dir) = setup();
    let root = dir.path();
    let a =
        kblink::create_node(&conn, Some(root), &input(&canvas, NodeKind::Note, "Идея")).unwrap();
    // Вторая нода-заметка и задача привязаны к тому же файлу.
    let twin = nodes::create(&conn, &input(&canvas, NodeKind::Note, "")).unwrap();
    let twin = kblink::update_node(
        &conn,
        Some(root),
        &twin.id,
        &NodePatch {
            kb_path: Some(Some("Идея.md".into())),
            ..NodePatch::default()
        },
    )
    .unwrap();
    assert_eq!(
        twin.title, "Идея",
        "привязка заметки берёт заголовок из имени файла"
    );
    let task = nodes::create(&conn, &input(&canvas, NodeKind::Task, "T")).unwrap();
    link(&conn, &task.id, Some("Идея.md"));

    let a = title(&conn, Some(root), &a.id, "Идея: v2");
    assert_eq!(a.title, "Идея v2");
    assert_eq!(a.kb_path.as_deref(), Some("Идея v2.md"));
    assert!(root.join("Идея v2.md").is_file());
    assert!(!root.join("Идея.md").exists());
    let twin = nodes::get(&conn, &twin.id).unwrap();
    assert_eq!(
        (twin.title.as_str(), twin.kb_path.as_deref()),
        ("Идея v2", Some("Идея v2.md"))
    );
    let task = nodes::get(&conn, &task.id).unwrap();
    assert_eq!(
        (task.title.as_str(), task.kb_path.as_deref()),
        ("T", Some("Идея v2.md"))
    );

    // Занятое имя — суффикс; смена регистра — то же имя.
    fs::write(root.join("Занято.md"), "").unwrap();
    let a = title(&conn, Some(root), &a.id, "Занято");
    assert_eq!(a.kb_path.as_deref(), Some("Занято 2.md"));
    let a = title(&conn, Some(root), &a.id, "занято 2");
    assert_eq!(a.kb_path.as_deref(), Some("занято 2.md"));
    assert_eq!(a.title, "занято 2");

    // Файл пропал — меняется только заголовок.
    fs::remove_file(root.join("занято 2.md")).unwrap();
    let a = title(&conn, Some(root), &a.id, "Другое");
    assert_eq!(
        (a.title.as_str(), a.kb_path.as_deref()),
        ("Другое", Some("занято 2.md"))
    );
}

#[test]
fn rewrite_prefix_syncs_note_titles() {
    let (conn, canvas, _dir) = setup();
    let n = nodes::create(&conn, &input(&canvas, NodeKind::Note, "Старое")).unwrap();
    link(&conn, &n.id, Some("Папка/Старое.md"));
    // Переименование снаружи (watcher) — заголовок следует за файлом.
    kb::rewrite_prefix(&conn, "Папка/Старое.md", "Папка/Новое.md").unwrap();
    assert_eq!(nodes::get(&conn, &n.id).unwrap().title, "Новое");
    // Переименование папки: имя файла то же.
    kb::rewrite_prefix(&conn, "Папка", "Архив").unwrap();
    let n = nodes::get(&conn, &n.id).unwrap();
    assert_eq!(
        (n.title.as_str(), n.kb_path.as_deref()),
        ("Новое", Some("Архив/Новое.md"))
    );
}

#[test]
fn create_target_and_note_to_folder() {
    let (conn, canvas, dir) = setup();
    let root = dir.path();
    let note = kblink::create_target(root, "Проекты", LinkTarget::Note, "Отчёт").unwrap();
    assert_eq!(note, "Проекты/Отчёт.md");
    let folder = kblink::create_target(root, "", LinkTarget::Folder, "Отчёт").unwrap();
    assert_eq!(folder, "Отчёт");
    assert!(root.join("Отчёт").is_dir());
    fs::write(root.join("Проекты/Отчёт.md"), "текст").unwrap();

    let a = nodes::create(&conn, &input(&canvas, NodeKind::Task, "Отчёт")).unwrap();
    let b = nodes::create(&conn, &input(&canvas, NodeKind::Task, "Другая")).unwrap();
    link(&conn, &a.id, Some(&note));
    link(&conn, &b.id, Some(&note));
    // Занятое имя папки рядом с заметкой — суффикс.
    fs::create_dir(root.join("Проекты/Отчёт")).unwrap();

    let f = kblink::note_to_folder(&conn, root, &note, "Отчёт").unwrap();
    assert_eq!(f, "Проекты/Отчёт 2");
    assert_eq!(
        fs::read_to_string(root.join("Проекты/Отчёт 2/Отчёт.md")).unwrap(),
        "текст"
    );
    assert!(!root.join("Проекты/Отчёт.md").exists());
    // Ссылка второй ноды переписана на новый путь заметки.
    assert_eq!(
        nodes::get(&conn, &b.id).unwrap().kb_path.as_deref(),
        Some("Проекты/Отчёт 2/Отчёт.md")
    );
    // Ссылку «своей» ноды на папку ставит вызывающий.
    let a = link(&conn, &a.id, Some(&f));
    assert_eq!(a.kb_path.as_deref(), Some("Проекты/Отчёт 2"));

    // Ошибки ничего не оставляют: не заметка, нет файла.
    assert!(kblink::note_to_folder(&conn, root, "Отчёт", "x").is_err());
    assert!(kblink::note_to_folder(&conn, root, "Нет.md", "Нет").is_err());
    assert!(!root.join("Нет").exists());
    assert!(kblink::create_target(root, "../x", LinkTarget::Note, "y").is_err());
}

#[test]
fn stat_reports_existence_and_previews() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    fs::create_dir_all(root.join("Папка")).unwrap();
    fs::write(
        root.join("Папка/З.md"),
        "---\na: 1\n---\n# Привет\n\n**мир**",
    )
    .unwrap();
    let list: Vec<String> = ["Папка", "Папка/З.md", "Нет.md", "", "../x.md"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let s = kblink::stat(Some(root), &list);
    assert!(s[0].exists && s[0].is_dir && s[0].preview.is_none());
    assert!(s[1].exists && !s[1].is_dir);
    assert_eq!(s[1].preview.as_deref(), Some("Привет\nмир"));
    assert!(!s[2].exists && !s[3].exists && !s[4].exists);
    assert!(kblink::stat(None, &list).iter().all(|x| !x.exists));
}

#[test]
fn migration_exports_old_notes_once() {
    let (conn, canvas, dir) = setup();
    let root = dir.path();
    let other = spaces::create(&conn, "Работа: 2026").unwrap();
    let mk = |canvas: &str, t: &str, body: &str| {
        let n = nodes::create(&conn, &input(canvas, NodeKind::Note, t)).unwrap();
        nodes::update(
            &conn,
            &n.id,
            &NodePatch {
                body: Some(body.into()),
                ..NodePatch::default()
            },
        )
        .unwrap()
    };
    let a = mk(&canvas, "Идея", "# Идея\nтекст");
    let b = mk(&canvas, "Идея", "вторая");
    let c = mk(&other.root_canvas, "", "");
    // Заметка в слое (вложенный холст задачи) — тоже.
    let task = nodes::create(&conn, &input(&canvas, NodeKind::Task, "T")).unwrap();
    let child = canvases::get_or_create_child(&conn, &task.id).unwrap();
    let d = mk(&child.id, "Глубже", "x");
    // Уже привязанная заметка не трогается.
    let e = mk(&canvas, "Своя", "y");
    link(&conn, &e.id, Some("Свой.md"));

    // Прерванная миграция: часть уже выгружена, флага нет — продолжает.
    let space_dir = format!("Garlic/{}", names::sanitize("Основное"));
    let first_space = spaces::list(&conn).unwrap()[0].name.clone();
    assert_eq!(first_space, "Основное");

    assert_eq!(kblink::migrate_note_bodies(&conn, root).unwrap(), 4);
    let get = |id: &str| nodes::get(&conn, id).unwrap();
    assert_eq!(
        get(&a.id).kb_path.as_deref(),
        Some(format!("{space_dir}/Идея.md").as_str())
    );
    assert_eq!(
        get(&b.id).kb_path.as_deref(),
        Some(format!("{space_dir}/Идея 2.md").as_str())
    );
    assert_eq!(get(&b.id).title, "Идея 2");
    assert_eq!(
        get(&c.id).kb_path.as_deref(),
        Some("Garlic/Работа 2026/Без названия.md")
    );
    assert_eq!(get(&c.id).title, "Без названия");
    assert_eq!(
        get(&d.id).kb_path.as_deref(),
        Some(format!("{space_dir}/Глубже.md").as_str())
    );
    assert_eq!(get(&e.id).kb_path.as_deref(), Some("Свой.md"));
    assert_eq!(
        fs::read_to_string(root.join(format!("{space_dir}/Идея.md"))).unwrap(),
        "# Идея\nтекст"
    );
    // body остаётся в БД (не используется).
    assert_eq!(get(&a.id).body, "# Идея\nтекст");
    assert_eq!(
        app_state::get(&conn, kblink::NOTES_MIGRATED_KEY)
            .unwrap()
            .as_deref(),
        Some("1")
    );

    // Повторно — ничего, даже если заметку отвязали.
    link(&conn, &a.id, None);
    assert_eq!(kblink::migrate_note_bodies(&conn, root).unwrap(), 0);
    assert_eq!(get(&a.id).kb_path, None);
    let files = fs::read_dir(root.join(&space_dir)).unwrap().count();
    assert_eq!(files, 3);
}

#[test]
fn migration_resumes_after_interruption() {
    let (conn, canvas, dir) = setup();
    let root = dir.path();
    let a = nodes::create(&conn, &input(&canvas, NodeKind::Note, "A")).unwrap();
    let b = nodes::create(&conn, &input(&canvas, NodeKind::Note, "B")).unwrap();
    // Как будто первая попытка успела выгрузить A и упала до флага.
    fs::create_dir_all(root.join("Garlic/Основное")).unwrap();
    fs::write(root.join("Garlic/Основное/A.md"), "").unwrap();
    link(&conn, &a.id, Some("Garlic/Основное/A.md"));
    assert_eq!(kblink::migrate_note_bodies(&conn, root).unwrap(), 1);
    assert_eq!(
        nodes::get(&conn, &b.id).unwrap().kb_path.as_deref(),
        Some("Garlic/Основное/B.md")
    );
    // Без доступа к папке — ошибка, флаг не ставится.
    let (conn2, canvas2, _d) = setup();
    nodes::create(&conn2, &input(&canvas2, NodeKind::Note, "C")).unwrap();
    let file = root.join("not-a-dir");
    fs::write(&file, "").unwrap();
    assert!(kblink::migrate_note_bodies(&conn2, &file).is_err());
    assert_eq!(
        app_state::get(&conn2, kblink::NOTES_MIGRATED_KEY).unwrap(),
        None
    );
}
