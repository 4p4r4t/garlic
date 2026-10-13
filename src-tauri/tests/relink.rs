//! Обновление ссылок при переименовании/перемещении и картинки (M6c) на временном vault.

use std::fs;
use std::path::Path;

use garlic_lib::vault::links::{self, LinkKind};
use garlic_lib::vault::relink::{self, RelinkReport};
use garlic_lib::vault::{ops, EntryKind, Move};

fn vault() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn put(root: &Path, rel: &str, content: &str) {
    let p = root.join(rel);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

fn get(root: &Path, rel: &str) -> String {
    fs::read_to_string(root.join(rel)).unwrap()
}

/// Снимок -> операция -> переписывание, как делают команды.
fn rename_with_links(root: &Path, path: &str, new_name: &str) -> (String, RelinkReport) {
    let before = relink::snapshot(root).unwrap();
    let new = ops::rename(root, path, new_name).unwrap();
    let report = relink::rewrite(
        root,
        &before,
        &Move {
            from: path.to_owned(),
            to: new.clone(),
        },
    )
    .unwrap();
    (new, report)
}

fn move_with_links(root: &Path, path: &str, dir: &str) -> (String, RelinkReport) {
    let before = relink::snapshot(root).unwrap();
    let new = ops::move_to(root, path, dir).unwrap();
    let report = relink::rewrite(
        root,
        &before,
        &Move {
            from: path.to_owned(),
            to: new.clone(),
        },
    )
    .unwrap();
    (new, report)
}

#[test]
fn scan_gives_target_spans() {
    let text =
        "a [[Идея#Итог|алиас]] ![[pic.png|300]] [x](Другая%20заметка.md#h) ![i](<a b.png>)\n\
                [[таб\\|лица]]\n```\n[[код]]\n```\n";
    let spans = links::scan(text);
    let got: Vec<(&str, &str)> = spans
        .iter()
        .map(|l| (l.target.as_str(), &text[l.start..l.end]))
        .collect();
    assert_eq!(
        got,
        [
            ("Идея", "Идея"),
            ("pic.png", "pic.png"),
            ("Другая заметка.md", "Другая%20заметка.md"),
            ("a b.png", "a b.png"),
            ("таб", "таб"),
        ]
    );
    assert_eq!(spans[3].kind, LinkKind::Md { angle: true });
    // extract (обратные ссылки) картинки markdown-ссылкой не считает.
    let found: Vec<String> = links::extract(text).into_iter().map(|l| l.target).collect();
    assert_eq!(found, ["Идея", "pic.png", "Другая заметка.md", "таб"]);
}

#[test]
fn resolve_relative_links() {
    let files: Vec<String> = ["a/x.md", "a/b/y.md", "z.md"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let r = |t: &str, src: &str| links::resolve(&files, t, src).map(String::as_str);
    assert_eq!(r("./b/y.md", "a/s.md"), Some("a/b/y.md"));
    assert_eq!(r("../z.md", "a/s.md"), Some("z.md"));
    assert_eq!(r("../../z.md", "a/s.md"), None);
    assert_eq!(r("../x.md", "a/b/s.md"), Some("a/x.md"));
}

#[test]
fn rename_rewrites_all_link_forms_and_keeps_the_rest() {
    let dir = vault();
    let root = dir.path();
    put(root, "Старая.md", "я сам: [[Старая]]\n");
    put(
        root,
        "src.md",
        "[[Старая]] [[старая|алиас]] [[Старая#Раздел]] ![[Старая]] [[Старая#Раздел|как]]\n\
         [md](Старая.md) [md2](Старая.md#h) [[Другая]]\n\
         ```\n[[Старая]]\n```\n`[[Старая]]`\n",
    );
    put(root, "Другая.md", "без ссылок\n");
    put(
        root,
        "sub/rel.md",
        "[r](../Старая.md) [n](<../Старая.md>)\n",
    );

    let (new, report) = rename_with_links(root, "Старая.md", "Новая тема");
    assert_eq!(new, "Новая тема.md");
    assert_eq!(report.links, 10);
    let mut files = report.files.clone();
    files.sort();
    assert_eq!(files, ["src.md", "sub/rel.md", "Новая тема.md"]);

    assert_eq!(get(root, "Новая тема.md"), "я сам: [[Новая тема]]\n");
    assert_eq!(
        get(root, "src.md"),
        "[[Новая тема]] [[Новая тема|алиас]] [[Новая тема#Раздел]] ![[Новая тема]] [[Новая тема#Раздел|как]]\n\
         [md](Новая%20тема.md) [md2](Новая%20тема.md#h) [[Другая]]\n\
         ```\n[[Старая]]\n```\n`[[Старая]]`\n"
    );
    assert_eq!(
        get(root, "sub/rel.md"),
        "[r](../Новая%20тема.md) [n](<../Новая тема.md>)\n"
    );
    assert_eq!(get(root, "Другая.md"), "без ссылок\n");
}

#[test]
fn move_keeps_shortest_unique_links_and_fixes_ambiguous_ones() {
    let dir = vault();
    let root = dir.path();
    put(root, "План.md", "");
    put(root, "a/Идея.md", "");
    put(root, "src.md", "[[Идея]] [[a/Идея]] [[План]]\n");

    fs::create_dir_all(root.join("b")).unwrap();
    fs::create_dir_all(root.join("c")).unwrap();
    // Перенос в другую папку: имя по-прежнему однозначно - [[Идея]] не трогаем,
    // [[a/Идея]] (путь) больше не попадает в файл - переписываем.
    let (new, report) = move_with_links(root, "a/Идея.md", "b");
    assert_eq!(new, "b/Идея.md");
    assert_eq!(report.links, 1);
    assert_eq!(get(root, "src.md"), "[[Идея]] [[b/Идея]] [[План]]\n");

    // Появился одноимённый файл - имя неоднозначно, берётся ближайший по правилам
    // Obsidian (короче путь), поэтому перенос "b/Идея" -> "c/d" требует пути.
    put(root, "Идея.md", "корневая");
    let (_, report) = move_with_links(root, "b/Идея.md", "c");
    // [[Идея]] разрешался в корневую (короче), [[b/Идея]] - в перенесённую.
    assert_eq!(report.links, 1);
    assert_eq!(get(root, "src.md"), "[[Идея]] [[c/Идея]] [[План]]\n");
}

#[test]
fn folder_rename_rewrites_path_links_and_moved_notes_links() {
    let dir = vault();
    let root = dir.path();
    put(
        root,
        "Проект/Задачи/один.md",
        "[[два]] [[Проект/Задачи/два]] [[../внешняя]]\n",
    );
    put(root, "Проект/Задачи/два.md", "[[один]]\n");
    put(
        root,
        "Проект/внешняя.md",
        "[[Задачи/один]] [[Проект/Задачи/один|псевдоним]]\n",
    );
    put(root, "вне.md", "[[Проект/Задачи/два]] [[один]]\n");

    let before = relink::snapshot(root).unwrap();
    let new = ops::rename(root, "Проект", "Работа").unwrap();
    let report = relink::rewrite(
        root,
        &before,
        &Move {
            from: "Проект".into(),
            to: new,
        },
    )
    .unwrap();
    assert_eq!(report.links, 3, "{report:?}");
    // Имена остались однозначными - не трогаем; пути с именем папки - переписаны.
    assert_eq!(
        get(root, "Работа/Задачи/один.md"),
        "[[два]] [[Работа/Задачи/два]] [[../внешняя]]\n"
    );
    assert_eq!(get(root, "Работа/Задачи/два.md"), "[[один]]\n");
    assert_eq!(
        get(root, "Работа/внешняя.md"),
        "[[Задачи/один]] [[Работа/Задачи/один|псевдоним]]\n"
    );
    assert_eq!(get(root, "вне.md"), "[[Работа/Задачи/два]] [[один]]\n");
}

#[test]
fn moved_note_keeps_its_relative_links() {
    let dir = vault();
    let root = dir.path();
    put(root, "a/x.md", "[r](./y.md) [[y]]\n");
    put(root, "a/y.md", "");
    put(root, "b/y.md", "");
    // x переехала в b: [[y]] разрешался в a/y (рядом), теперь был бы b/y -> переписать;
    // относительная ссылка ./y.md в b указала бы на b/y.md -> тоже на a/y.md.
    let (_, report) = move_with_links(root, "a/x.md", "b");
    assert_eq!(report.links, 2);
    assert_eq!(get(root, "b/x.md"), "[r](../a/y.md) [[a/y]]\n");
}

#[test]
fn image_rename_rewrites_embeds() {
    let dir = vault();
    let root = dir.path();
    put(root, "Вложения/кот.png", "png");
    put(
        root,
        "n.md",
        "![[кот.png]] ![[кот.png|300]] ![alt](Вложения/кот.png) [[кот]]\n",
    );
    let (new, report) = rename_with_links(root, "Вложения/кот.png", "собака");
    assert_eq!(new, "Вложения/собака.png");
    assert_eq!(report.links, 3);
    assert_eq!(
        get(root, "n.md"),
        "![[собака.png]] ![[собака.png|300]] ![alt](Вложения/собака.png) [[кот]]\n"
    );
    // С расширением в имени - не удваивается.
    let (new, _) = rename_with_links(root, "Вложения/собака.png", "лиса.PNG");
    assert_eq!(new, "Вложения/лиса.png");
    assert_eq!(
        get(root, "n.md").lines().next().unwrap().split(' ').next(),
        Some("![[лиса.png]]")
    );
}

#[test]
fn disabled_or_unrelated_changes_leave_files_alone() {
    let dir = vault();
    let root = dir.path();
    put(root, "a.md", "[[b]]\n");
    put(root, "b.md", "");
    // Без снимка (опция выключена) команды relink не вызывают - файл тот же.
    ops::rename(root, "b.md", "c").unwrap();
    assert_eq!(get(root, "a.md"), "[[b]]\n");
    // Ссылки, не указывавшие в перенесённый файл, не затрагиваются.
    put(root, "d.md", "[[несуществующая]]\n");
    let (_, report) = rename_with_links(root, "c.md", "e");
    assert_eq!(report.links, 0);
    assert_eq!(get(root, "d.md"), "[[несуществующая]]\n");
}

#[test]
fn tree_images_and_attachments() {
    let dir = vault();
    let root = dir.path();
    put(root, "note.md", "");
    put(root, "pic.PNG", "x");
    put(root, "doc.pdf", "x");
    let tree = ops::tree(root).unwrap();
    let kinds: Vec<(&str, EntryKind)> = tree.iter().map(|e| (e.name.as_str(), e.kind)).collect();
    assert_eq!(
        kinds,
        [("note.md", EntryKind::Note), ("pic.PNG", EntryKind::Image)]
    );
    assert_eq!(ops::list_notes(root).unwrap(), ["note.md"]);
    assert_eq!(ops::list_linkable(root).unwrap().len(), 2);

    // Вложение: папка создаётся на лету, занятое имя - суффикс.
    let a =
        ops::save_attachment(root, "Вложения", "Pasted image 20261014120000.png", b"1").unwrap();
    let b =
        ops::save_attachment(root, "Вложения", "Pasted image 20261014120000.png", b"2").unwrap();
    assert_eq!(a, "Вложения/Pasted image 20261014120000.png");
    assert_eq!(b, "Вложения/Pasted image 20261014120000 2.png");
    assert_eq!(ops::read_image(root, &a).unwrap(), b"1");
    // Не картинка / выход из vault / пустое - отказ.
    assert!(ops::save_attachment(root, "Вложения", "x.exe", b"1").is_err());
    assert!(ops::save_attachment(root, "..", "x.png", b"1").is_err());
    assert!(ops::save_attachment(root, "В", "x.png", b"").is_err());
    assert!(ops::read_image(root, "note.md").is_err());
    assert!(ops::read_image(root, "../x.png").is_err());
}
