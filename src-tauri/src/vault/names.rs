//! Имена файлов и папок: очистка под Windows/Obsidian и подбор свободного имени.

use std::path::Path;

/// Имя по умолчанию, если после очистки ничего не осталось.
pub const UNTITLED: &str = "Без названия";

/// Максимальная длина имени (без расширения), символов.
const MAX_NAME_CHARS: usize = 120;

/// Зарезервированные имена устройств Windows (без учёта регистра и расширения).
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Очищает имя заметки/папки (без расширения): убирает символы, запрещённые
/// в Windows (`<>:"/\|?*`, управляющие) и ломающие вики-ссылки Obsidian
/// (`#^[]|`), схлопывает пробелы, обрезает точки/пробелы по краям и длину,
/// обходит зарезервированные имена (`CON` → `CON_`). Пустое → «Без названия».
pub fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control()
                || matches!(
                    c,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' | '#' | '^' | '[' | ']'
                )
            {
                ' '
            } else {
                c
            }
        })
        .collect();
    let mut out = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.chars().count() > MAX_NAME_CHARS {
        out = out.chars().take(MAX_NAME_CHARS).collect();
    }
    let out = out
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .to_owned();
    if out.is_empty() {
        return UNTITLED.to_owned();
    }
    let stem = out.split('.').next().unwrap_or("");
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        return format!("{out}_");
    }
    out
}

/// Свободное имя в папке `dir`: `base{ext}`, затем `base 2{ext}`, `base 3{ext}`…
/// Занятость проверяется без учёта регистра (как в файловой системе Windows).
/// `ext` — `".md"` для заметки, `""` для папки.
pub fn unique_name(dir: &Path, base: &str, ext: &str) -> String {
    let taken: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| e.file_name().to_str().map(str::to_lowercase))
                .collect()
        })
        .unwrap_or_default();
    let free = |n: &str| !taken.contains(&n.to_lowercase());
    let first = format!("{base}{ext}");
    if free(&first) {
        return first;
    }
    (2..)
        .map(|i| format!("{base} {i}{ext}"))
        .find(|n| free(n))
        .expect("бесконечный итератор")
}
