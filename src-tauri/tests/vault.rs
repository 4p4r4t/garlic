//! Интеграционные тесты базы знаний (ТЗ §4.10) на временных папках.

use std::fs;
use std::path::Path;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use garlic_lib::db;
use garlic_lib::model::{NewNode, NodeKind, NodePatch};
use garlic_lib::repo::{canvases, kb, nodes, spaces};
use garlic_lib::vault::watcher::{self, SelfWrites};
use garlic_lib::vault::{links, names, ops, paths, EntryKind, VaultEvent, VaultEventKind};

fn vault() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn put(root: &Path, rel: &str, content: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

#[test]
fn paths_reject_traversal_and_bad_chars() {
    let dir = vault();
    let root = dir.path();
    assert_eq!(paths::normalize_rel("a\\b//c.md/").unwrap(), "a/b/c.md");
    assert_eq!(paths::normalize_rel("").unwrap(), "");
    for bad in [
        "../x.md",
        "a/../../x",
        "./a",
        "C:/Windows",
        "a/b:c",
        "a/<x>",
        "a/b?.md",
    ] {
        assert!(
            paths::normalize_rel(bad).is_err(),
            "{bad} должен отклоняться"
        );
        assert!(
            paths::resolve(root, bad).is_err(),
            "{bad} должен отклоняться"
        );
    }
    // Абсолютный путь превращается в относительный внутри vault, а не выходит наружу.
    let abs = paths::resolve(root, "/etc/passwd").unwrap();
    assert!(abs.starts_with(root));
    assert!(ops::read(root, "../secret.md").is_err());
    assert!(ops::write(root, "..\\secret.md", "x").is_err());
    assert!(ops::create_note(root, "..", "x", "").is_err());
    assert!(ops::move_to(root, "a.md", "..").is_err());
}

#[test]
fn sanitize_and_unique_names() {
    assert_eq!(names::sanitize("  План: Q1 / 2026?  "), "План Q1 2026");
    assert_eq!(names::sanitize("a#b^c[d]e|f"), "a b c d e f");
    assert_eq!(names::sanitize("..."), names::UNTITLED);
    assert_eq!(names::sanitize(""), names::UNTITLED);
    assert_eq!(names::sanitize("con"), "con_");
    assert_eq!(names::sanitize("Lpt1.txt"), "Lpt1.txt_");
    assert_eq!(names::sanitize("trailing. "), "trailing");
    assert_eq!(names::sanitize(&"я".repeat(300)).chars().count(), 120);

    let dir = vault();
    let root = dir.path();
    assert_eq!(names::unique_name(root, "Заметка", ".md"), "Заметка.md");
    put(root, "Заметка.md", "");
    put(root, "заметка 2.md", "");
    assert_eq!(names::unique_name(root, "Заметка", ".md"), "Заметка 3.md");
    assert_eq!(names::unique_name(root, "Заметка", ""), "Заметка");
}

#[test]
fn tree_lists_folders_notes_and_images() {
    let dir = vault();
    let root = dir.path();
    put(root, "b.md", "");
    put(root, "a.md", "");
    put(root, "Заметка 10.md", "");
    put(root, "Заметка 2.md", "");
    put(root, "image.png", "");
    put(root, ".obsidian/app.json", "{}");
    put(root, ".trash/old.md", "");
    put(root, "Папка/внутри.md", "");
    fs::create_dir(root.join("Пустая")).unwrap();

    let tree = ops::tree(root).unwrap();
    let names: Vec<&str> = tree.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "Папка",
            "Пустая",
            "a.md",
            "b.md",
            "image.png",
            "Заметка 2.md",
            "Заметка 10.md"
        ]
    );
    assert_eq!(tree[0].kind, EntryKind::Folder);
    let inner = tree[0].children.as_ref().unwrap();
    assert_eq!(inner[0].path, "Папка/внутри.md");
    assert_eq!(inner[0].kind, EntryKind::Note);
    assert!(tree[2].children.is_none());
    assert_eq!(tree[4].kind, EntryKind::Image);

    let mut all = ops::list_notes(root).unwrap();
    all.sort();
    assert_eq!(all.len(), 5);
    assert!(all.contains(&"Папка/внутри.md".to_owned()));
}

#[test]
fn read_write_create_rename_move() {
    let dir = vault();
    let root = dir.path();

    let p = ops::create_note(root, "", "Новая: заметка", "# hi").unwrap();
    assert_eq!(p, "Новая заметка.md");
    assert_eq!(ops::read(root, &p).unwrap().content, "# hi");
    let p2 = ops::create_note(root, "", "Новая заметка.md", "").unwrap();
    assert_eq!(p2, "Новая заметка 2.md");

    let (_, _) = ops::write(root, &p, "обновлено\n").unwrap();
    assert_eq!(ops::read(root, &p).unwrap().content, "обновлено\n");
    // Атомарная запись не оставляет временных файлов.
    let leftovers: Vec<_> = fs::read_dir(root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains("garlic~"))
        .collect();
    assert!(leftovers.is_empty());
    // Запись с ожидаемым mtime: совпал — пишем, файл изменён снаружи — конфликт.
    let seen = ops::read(root, &p).unwrap().mtime;
    let (_, t) = ops::write_checked(root, &p, "моя правка", Some(seen)).unwrap();
    let after = ops::to_ms(t);
    std::thread::sleep(std::time::Duration::from_millis(20));
    fs::write(root.join(&p), "чужая правка").unwrap();
    let err = ops::write_checked(root, &p, "затёрла бы", Some(after)).unwrap_err();
    assert!(err.to_string().starts_with("conflict:"), "{err}");
    assert_eq!(ops::read(root, &p).unwrap().content, "чужая правка");
    // Нового файла ожидание не касается.
    ops::write_checked(root, "новый.md", "x", Some(1)).unwrap();
    ops::write(root, &p, "обновлено\n").unwrap();
    assert!(ops::write(root, "нет-папки/x.md", "").is_err());
    assert!(ops::write(root, "x.txt", "").is_err());

    let f = ops::create_folder(root, "", "Проект").unwrap();
    assert_eq!(f, "Проект");
    assert_eq!(ops::create_folder(root, "", "проект").unwrap(), "проект 2");
    let sub = ops::create_folder(root, &f, "Вложенная").unwrap();
    assert_eq!(sub, "Проект/Вложенная");

    // Переименование заметки: имя без .md, очищается.
    let r = ops::rename(root, &p, "Итоги/2026").unwrap();
    assert_eq!(r, "Итоги 2026.md");
    assert!(root.join("Итоги 2026.md").is_file());
    // Только регистр — разрешено.
    let r = ops::rename(root, &r, "итоги 2026").unwrap();
    assert_eq!(r, "итоги 2026.md");
    // Занятое имя — ошибка.
    assert!(ops::rename(root, &r, "Новая заметка 2").is_err());

    // Перемещение.
    let m = ops::move_to(root, &r, "Проект/Вложенная").unwrap();
    assert_eq!(m, "Проект/Вложенная/итоги 2026.md");
    assert!(ops::move_to(root, "Проект", "Проект/Вложенная").is_err());
    assert!(ops::move_to(root, "Проект", "Проект").is_err());
    let m2 = ops::move_to(root, "Проект", "проект 2").unwrap();
    assert_eq!(m2, "проект 2/Проект");
    assert_eq!(
        ops::read(root, "проект 2/Проект/Вложенная/итоги 2026.md")
            .unwrap()
            .content,
        "обновлено\n"
    );
    // Переименование папки.
    let rf = ops::rename(root, "проект 2", "Архив").unwrap();
    assert_eq!(rf, "Архив");
    assert!(root.join("Архив/Проект/Вложенная/итоги 2026.md").is_file());
    assert!(ops::rename(root, "", "x").is_err());
    assert!(ops::rename(root, "нет.md", "x").is_err());
}

#[test]
fn delete_goes_to_trash() {
    let dir = vault();
    let root = dir.path();
    put(root, "garlic-test-удалить.md", "x");
    ops::delete(root, "garlic-test-удалить.md").unwrap();
    assert!(!root.join("garlic-test-удалить.md").exists());
    assert!(ops::delete(root, "garlic-test-удалить.md").is_err());
}

#[test]
fn links_extract_and_resolve() {
    let text = "См. [[Идея]] и [[папка/План|план]], [[Идея#Итоги]].\n\
                ```\n[[в коде]]\n```\n\
                `[[инлайн]]` [md](Другая%20заметка.md) [web](https://x.y/a.md)";
    let found: Vec<String> = links::extract(text).into_iter().map(|l| l.target).collect();
    assert_eq!(found, ["Идея", "папка/План", "Идея", "Другая заметка.md"]);

    let notes: Vec<String> = [
        "Идея.md",
        "a/Идея.md",
        "a/b/План.md",
        "папка/План.md",
        "x/Только.md",
        "x/y/Только.md",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    let r = |t: &str, src: &str| links::resolve(&notes, t, src).map(String::as_str);
    assert_eq!(r("Идея", "z.md"), Some("Идея.md"));
    assert_eq!(r("идея", "z.md"), Some("Идея.md"));
    assert_eq!(r("Идея.md", "z.md"), Some("Идея.md"));
    assert_eq!(r("Идея", "a/z.md"), Some("a/Идея.md"));
    assert_eq!(r("папка/План", "z.md"), Some("папка/План.md"));
    assert_eq!(r("b/План", "z.md"), Some("a/b/План.md"));
    assert_eq!(r("Только", "z.md"), Some("x/Только.md"));
    assert_eq!(r("Только", "x/y/q.md"), Some("x/y/Только.md"));
    assert_eq!(r("Нет", "z.md"), None);
}

#[test]
fn search_and_backlinks() {
    let dir = vault();
    let root = dir.path();
    put(root, "Идея.md", "# Идея\nчто-то про ЧЕСНОК\n");
    put(
        root,
        "Дневник.md",
        "сегодня [[Идея]] и чеснок\nещё [[Идея|она]]\n",
    );
    put(root, "папка/Чеснок.md", "без совпадений в тексте");
    put(
        root,
        "папка/Ссылка.md",
        "[см](../Идея.md) нет; [[Идея#Идея]]",
    );
    put(root, ".obsidian/x.md", "чеснок");

    let hits = ops::search(root, "чеснок", 50).unwrap();
    let paths: Vec<&str> = hits.iter().map(|h| h.path.as_str()).collect();
    assert_eq!(paths, ["папка/Чеснок.md", "Дневник.md", "Идея.md"]);
    assert!(hits[0].name_match);
    assert_eq!(hits[2].lines[0].line, 1);
    assert_eq!(hits[2].lines[0].text, "что-то про ЧЕСНОК");
    assert!(ops::search(root, "  ", 50).unwrap().is_empty());

    let long = format!("{}чеснок{}", "а".repeat(300), "б".repeat(300));
    put(root, "long.md", &long);
    let hit = ops::search(root, "чеснок", 50)
        .unwrap()
        .into_iter()
        .find(|h| h.path == "long.md")
        .unwrap();
    assert!(hit.lines[0].text.contains("чеснок"));
    assert!(hit.lines[0].text.starts_with('…') && hit.lines[0].text.ends_with('…'));

    let back = ops::backlinks(root, "Идея.md").unwrap();
    let mut from: Vec<&str> = back.iter().map(|b| b.path.as_str()).collect();
    from.sort();
    assert_eq!(from, ["Дневник.md", "папка/Ссылка.md"]);
    let d = back.iter().find(|b| b.path == "Дневник.md").unwrap();
    assert_eq!(d.lines.len(), 2);
}

#[test]
fn kb_path_migration_rewrite_and_linked_nodes() {
    let conn = db::open_in_memory().unwrap();
    let space = spaces::ensure_default(&conn).unwrap();
    let mk = |canvas: &str, title: &str| {
        nodes::create(
            &conn,
            &NewNode {
                canvas_id: canvas.into(),
                kind: NodeKind::Task,
                title: title.into(),
                x: 0.0,
                y: 0.0,
            },
        )
        .unwrap()
        .id
    };
    let set = |id: &str, p: Option<&str>| {
        nodes::update(
            &conn,
            id,
            &NodePatch {
                kb_path: Some(p.map(str::to_owned)),
                ..Default::default()
            },
        )
    };
    let a = mk(&space.root_canvas, "A");
    let child = canvases::get_or_create_child(&conn, &a).unwrap();
    let b = mk(&child.id, "B");
    let c = mk(&space.root_canvas, "C");
    let d = mk(&space.root_canvas, "D");

    assert_eq!(
        set(&a, Some("Проект\\План.md")).unwrap().kb_path.as_deref(),
        Some("Проект/План.md")
    );
    set(&b, Some("Проект/План.md")).unwrap();
    set(&c, Some("Проект")).unwrap();
    set(&d, Some("Проект 2/x_%.md")).unwrap();
    assert!(set(&a, Some("../x.md")).is_err());
    assert_eq!(
        nodes::get(&conn, &a).unwrap().kb_path.as_deref(),
        Some("Проект/План.md")
    );

    let linked = kb::linked_nodes(&conn, "Проект/План.md").unwrap();
    assert_eq!(linked.len(), 2);
    let lb = linked.iter().find(|n| n.id == b).unwrap();
    assert_eq!(
        lb.canvas_chain,
        [space.root_canvas.clone(), child.id.clone()]
    );
    assert_eq!(lb.space_id, space.id);
    let la = linked.iter().find(|n| n.id == a).unwrap();
    assert_eq!(la.canvas_chain, std::slice::from_ref(&space.root_canvas));

    // Переименование файла.
    assert_eq!(
        kb::rewrite_prefix(&conn, "Проект/План.md", "Проект/План v2.md").unwrap(),
        2
    );
    assert_eq!(
        nodes::get(&conn, &b).unwrap().kb_path.as_deref(),
        Some("Проект/План v2.md")
    );
    // Переименование папки тянет вложенные пути, но не «Проект 2/…».
    assert_eq!(
        kb::rewrite_prefix(&conn, "Проект", "Архив/Проект").unwrap(),
        3
    );
    assert_eq!(
        nodes::get(&conn, &a).unwrap().kb_path.as_deref(),
        Some("Архив/Проект/План v2.md")
    );
    assert_eq!(
        nodes::get(&conn, &c).unwrap().kb_path.as_deref(),
        Some("Архив/Проект")
    );
    assert_eq!(
        nodes::get(&conn, &d).unwrap().kb_path.as_deref(),
        Some("Проект 2/x_%.md")
    );
    // Идемпотентность (эхо watcher'а).
    assert_eq!(
        kb::rewrite_prefix(&conn, "Проект", "Архив/Проект").unwrap(),
        0
    );
    // `%` и `_` в имени — не шаблоны.
    assert_eq!(
        kb::rewrite_prefix(&conn, "Проект 2/x_%.md", "y.md").unwrap(),
        1
    );
    assert_eq!(kb::rewrite_prefix(&conn, "Проект _", "z").unwrap(), 0);

    set(&c, None).unwrap();
    assert!(nodes::get(&conn, &c).unwrap().kb_path.is_none());
    assert!(kb::linked_nodes(&conn, "Архив/Проект").unwrap().is_empty());
}

/// Ждёт событие, удовлетворяющее `pred`, не дольше 5 с.
fn wait_for(rx: &mpsc::Receiver<Vec<VaultEvent>>, pred: impl Fn(&VaultEvent) -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while let Some(left) = deadline.checked_duration_since(Instant::now()) {
        match rx.recv_timeout(left) {
            Ok(batch) => {
                if batch.iter().any(&pred) {
                    return true;
                }
            }
            Err(_) => return false,
        }
    }
    false
}

#[test]
fn watcher_reports_external_changes_and_skips_own_writes() {
    let dir = vault();
    let root = dir.path().to_path_buf();
    let writes = Arc::new(SelfWrites::default());
    let (tx, rx) = mpsc::channel();
    let _w = watcher::start(root.clone(), writes.clone(), move |b| {
        let _ = tx.send(b);
    })
    .unwrap();
    std::thread::sleep(Duration::from_millis(200));

    put(&root, "Внешняя.md", "a");
    assert!(wait_for(&rx, |e| e.path == "Внешняя.md"
        && matches!(
            e.kind,
            VaultEventKind::Create | VaultEventKind::Modify
        )));

    fs::write(root.join("Внешняя.md"), "b").unwrap();
    assert!(wait_for(&rx, |e| e.path == "Внешняя.md"
        && e.kind == VaultEventKind::Modify));

    fs::create_dir(root.join("Папка")).unwrap();
    assert!(wait_for(&rx, |e| e.path == "Папка" && e.is_dir));
    // Переименование на месте — настоящее rename-событие.
    fs::rename(root.join("Внешняя.md"), root.join("Переименована.md")).unwrap();
    assert!(wait_for(&rx, |e| {
        e.kind == VaultEventKind::Rename
            && e.path == "Переименована.md"
            && e.from.as_deref() == Some("Внешняя.md")
    }));
    // Перемещение в другую папку (Windows: удалено + создано) склеивается в rename.
    fs::rename(
        root.join("Переименована.md"),
        root.join("Папка/Переименована.md"),
    )
    .unwrap();
    assert!(wait_for(&rx, |e| {
        e.kind == VaultEventKind::Rename
            && e.path == "Папка/Переименована.md"
            && e.from.as_deref() == Some("Переименована.md")
    }));
    // Перемещение папки целиком.
    fs::create_dir(root.join("Архив")).unwrap();
    fs::rename(root.join("Папка"), root.join("Архив/Папка")).unwrap();
    assert!(wait_for(&rx, |e| {
        e.kind == VaultEventKind::Rename
            && e.path == "Архив/Папка"
            && e.from.as_deref() == Some("Папка")
            && e.is_dir
    }));

    // Своя запись (через реестр) не возвращается эхом; чужая — возвращается.
    let (abs, mtime) = ops::write(&root, "Архив/Папка/Переименована.md", "своя").unwrap();
    writes.record(abs, mtime);
    put(&root, "маркер.md", "x");
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut echo = false;
    let mut marker = false;
    while !marker && Instant::now() < deadline {
        if let Ok(batch) = rx.recv_timeout(Duration::from_millis(500)) {
            echo |= batch
                .iter()
                .any(|e| e.path == "Архив/Папка/Переименована.md");
            marker |= batch.iter().any(|e| e.path == "маркер.md");
        }
    }
    assert!(marker, "событие внешнего файла не пришло");
    assert!(!echo, "эхо собственной записи не должно уходить во фронт");

    // Скрытые папки и не-.md файлы игнорируются.
    put(&root, ".obsidian/workspace.json", "{}");
    put(&root, "pic.png", "x");
    fs::remove_file(root.join("маркер.md")).unwrap();
    assert!(wait_for(&rx, |e| e.path == "маркер.md"
        && e.kind == VaultEventKind::Remove));
    // Хвост: никаких событий про .obsidian/png не должно было прийти до удаления маркера,
    // и не приходит после.
    while let Ok(batch) = rx.recv_timeout(Duration::from_millis(600)) {
        assert!(batch
            .iter()
            .all(|e| !e.path.starts_with(".obsidian") && !e.path.ends_with(".png")));
    }
}
