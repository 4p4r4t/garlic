//! Файловые операции vault. Все функции принимают корень vault и относительные
//! пути (`/`), сами проверяют, что не выходят за корень (`paths::resolve`).

use std::cmp::Ordering;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::paths::{self, file_name, is_hidden, is_md, join_rel, parent_rel};
use super::{links, names, Backlink, EntryKind, NoteFile, SearchHit, SearchLine, VaultEntry};
use crate::error::{AppError, AppResult};

/// Файлы больше этого не читаются поиском/обратными ссылками.
const MAX_SCAN_BYTES: u64 = 4 * 1024 * 1024;
/// Сколько строк-совпадений показывать на файл.
const MAX_LINES_PER_FILE: usize = 6;
/// Длина сниппета вокруг совпадения, символов.
const SNIPPET_CHARS: usize = 160;

pub fn to_ms(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn mtime_ms(p: &Path) -> i64 {
    fs::metadata(p)
        .and_then(|m| m.modified())
        .map(to_ms)
        .unwrap_or(0)
}

/// Естественная сортировка без учёта регистра: «Заметка 2» < «Заметка 10».
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.to_lowercase(), b.to_lowercase());
    let mut ai = a.chars().peekable();
    let mut bi = b.chars().peekable();
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let mut na = String::new();
                while let Some(c) = ai.peek().copied().filter(char::is_ascii_digit) {
                    na.push(c);
                    ai.next();
                }
                let mut nb = String::new();
                while let Some(c) = bi.peek().copied().filter(char::is_ascii_digit) {
                    nb.push(c);
                    bi.next();
                }
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta.len().cmp(&tb.len()).then_with(|| ta.cmp(tb));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(&y);
                }
                ai.next();
                bi.next();
            }
        }
    }
}

/// Дерево vault: папки и `.md`, скрытые (`.obsidian`, `.git`, `.trash`…) и
/// симлинки пропускаются. Папки первыми, внутри — естественная сортировка по имени.
pub fn tree(root: &Path) -> AppResult<Vec<VaultEntry>> {
    let root_abs = paths::resolve(root, "")?;
    read_dir_entries(&root_abs, "")
}

fn read_dir_entries(abs: &Path, rel: &str) -> AppResult<Vec<VaultEntry>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(abs)? {
        let Ok(entry) = entry else { continue };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if is_hidden(&name) {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        let path = join_rel(rel, &name);
        if ft.is_dir() {
            let children = read_dir_entries(&entry.path(), &path).unwrap_or_default();
            out.push(VaultEntry {
                name,
                path,
                kind: EntryKind::Folder,
                mtime: mtime_ms(&entry.path()),
                children: Some(children),
            });
        } else if ft.is_file() && is_md(&name) {
            out.push(VaultEntry {
                name,
                path,
                kind: EntryKind::Note,
                mtime: mtime_ms(&entry.path()),
                children: None,
            });
        }
    }
    out.sort_by(|a, b| {
        (a.kind == EntryKind::Note)
            .cmp(&(b.kind == EntryKind::Note))
            .then_with(|| natural_cmp(&a.name, &b.name))
    });
    Ok(out)
}

/// Плоский список всех заметок (пути `.md`).
pub fn list_notes(root: &Path) -> AppResult<Vec<String>> {
    fn walk(entries: Vec<VaultEntry>, out: &mut Vec<String>) {
        for e in entries {
            match e.kind {
                EntryKind::Note => out.push(e.path),
                EntryKind::Folder => walk(e.children.unwrap_or_default(), out),
            }
        }
    }
    let mut out = Vec::new();
    walk(tree(root)?, &mut out);
    Ok(out)
}

fn ensure_note_path(rel: &str) -> AppResult<()> {
    if is_md(rel) {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("не заметка (.md): {rel}")))
    }
}

pub fn read(root: &Path, rel: &str) -> AppResult<NoteFile> {
    ensure_note_path(rel)?;
    let abs = paths::resolve(root, rel)?;
    let bytes = fs::read(&abs).map_err(|e| not_found_or(e, || format!("заметка {rel}")))?;
    let content = String::from_utf8(bytes)
        .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned());
    Ok(NoteFile {
        path: paths::normalize_rel(rel)?,
        content,
        mtime: mtime_ms(&abs),
    })
}

/// Атомарная запись: временный файл рядом (`.имя.garlic~`, скрыт от дерева и
/// watcher'а) + переименование поверх. Возвращает mtime записанного файла.
pub fn write_atomic(abs: &Path, content: &str) -> AppResult<SystemTime> {
    let dir = abs
        .parent()
        .ok_or_else(|| AppError::Invalid("нет родительской папки".into()))?;
    if !dir.is_dir() {
        return Err(AppError::NotFound(format!("папка {}", dir.display())));
    }
    let name = abs
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Invalid("некорректное имя файла".into()))?;
    let tmp = dir.join(format!(".{name}.garlic~"));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
    }
    if let Err(e) = fs::rename(&tmp, abs) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(fs::metadata(abs)?.modified()?)
}

/// Записывает заметку (создаёт, если её нет; папка должна существовать).
pub fn write(root: &Path, rel: &str, content: &str) -> AppResult<(PathBuf, SystemTime)> {
    write_checked(root, rel, content, None)
}

/// Запись с проверкой: если файл существует и его mtime (мс) не равен
/// `expected_mtime` — он изменён снаружи после нашего чтения/записи, и
/// запись отклоняется [`AppError::Conflict`] (фронт показывает конфликт,
/// вместо того чтобы молча затереть чужую правку).
pub fn write_checked(
    root: &Path,
    rel: &str,
    content: &str,
    expected_mtime: Option<i64>,
) -> AppResult<(PathBuf, SystemTime)> {
    ensure_note_path(rel)?;
    let abs = paths::resolve(root, rel)?;
    if abs.is_dir() {
        return Err(AppError::Invalid(format!("это папка: {rel}")));
    }
    if let Some(expected) = expected_mtime {
        if abs.is_file() && mtime_ms(&abs) != expected {
            return Err(AppError::Conflict(format!("«{rel}» изменён снаружи")));
        }
    }
    let t = write_atomic(&abs, content)?;
    Ok((abs, t))
}

fn ensure_dir(root: &Path, dir: &str) -> AppResult<PathBuf> {
    let abs = paths::resolve(root, dir)?;
    if !abs.is_dir() {
        return Err(AppError::NotFound(format!("папка «{dir}»")));
    }
    Ok(abs)
}

/// Новая заметка в папке `dir`: имя очищается, при занятом — ` 2`, ` 3`…
/// Возвращает относительный путь созданного файла.
pub fn create_note(root: &Path, dir: &str, name: &str, content: &str) -> AppResult<String> {
    let dir = paths::normalize_rel(dir)?;
    let dir_abs = ensure_dir(root, &dir)?;
    let stem = names::sanitize(strip_md(name));
    let file = names::unique_name(&dir_abs, &stem, ".md");
    let abs = dir_abs.join(&file);
    // create_new — не затереть файл, появившийся между проверкой и записью.
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&abs)?;
    f.write_all(content.as_bytes())?;
    Ok(join_rel(&dir, &file))
}

/// Новая папка в `dir` (имя очищается, при занятом — ` 2`…). Возвращает путь.
pub fn create_folder(root: &Path, dir: &str, name: &str) -> AppResult<String> {
    let dir = paths::normalize_rel(dir)?;
    let dir_abs = ensure_dir(root, &dir)?;
    let file = names::unique_name(&dir_abs, &names::sanitize(name), "");
    fs::create_dir(dir_abs.join(&file))?;
    Ok(join_rel(&dir, &file))
}

fn strip_md(name: &str) -> &str {
    let name = name.trim();
    if is_md(name) {
        &name[..name.len() - 3]
    } else {
        name
    }
}

/// Существующий файл/папка `rel` (не корень).
fn existing(root: &Path, rel: &str) -> AppResult<(String, PathBuf)> {
    let rel = paths::normalize_rel(rel)?;
    if rel.is_empty() {
        return Err(AppError::Invalid(
            "корень базы знаний не переименовывается".into(),
        ));
    }
    let abs = paths::resolve(root, &rel)?;
    if !abs.exists() {
        return Err(AppError::NotFound(format!("«{rel}»")));
    }
    Ok((rel, abs))
}

/// Переносит `from` в `to`. Занятое место — ошибка (кроме смены регистра того же файла).
fn move_path(from_rel: &str, from: &Path, to_rel: &str, to: &Path) -> AppResult<()> {
    if to.exists() {
        let same = from.canonicalize()? == to.canonicalize()?;
        if !same {
            return Err(AppError::Invalid(format!("«{to_rel}» уже существует")));
        }
        if from_rel == to_rel {
            return Ok(());
        }
    }
    fs::rename(from, to)?;
    Ok(())
}

/// Переименование на месте. У заметки `new_name` — без `.md` (если указано — не
/// удваивается). Имя очищается (`names::sanitize`). Возвращает новый путь.
pub fn rename(root: &Path, rel: &str, new_name: &str) -> AppResult<String> {
    let (rel, abs) = existing(root, rel)?;
    let is_note = abs.is_file();
    let name = if is_note {
        format!("{}.md", names::sanitize(strip_md(new_name)))
    } else {
        names::sanitize(new_name)
    };
    let to_rel = join_rel(parent_rel(&rel), &name);
    let to = paths::resolve(root, &to_rel)?;
    move_path(&rel, &abs, &to_rel, &to)?;
    Ok(to_rel)
}

/// Перемещение в папку `new_dir` (`""` — корень) с тем же именем. Возвращает новый путь.
pub fn move_to(root: &Path, rel: &str, new_dir: &str) -> AppResult<String> {
    let (rel, abs) = existing(root, rel)?;
    let new_dir = paths::normalize_rel(new_dir)?;
    if new_dir == rel || new_dir.starts_with(&format!("{rel}/")) {
        return Err(AppError::Invalid(
            "папку нельзя переместить в саму себя".into(),
        ));
    }
    ensure_dir(root, &new_dir)?;
    let to_rel = join_rel(&new_dir, file_name(&rel));
    if to_rel == rel {
        return Ok(rel);
    }
    let to = paths::resolve(root, &to_rel)?;
    move_path(&rel, &abs, &to_rel, &to)?;
    Ok(to_rel)
}

/// Удаление в корзину ОС (не насовсем, ТЗ §4.10).
pub fn delete(root: &Path, rel: &str) -> AppResult<()> {
    let (_, abs) = existing(root, rel)?;
    trash::delete(&abs).map_err(|e| AppError::Other(format!("не удалось удалить в корзину: {e}")))
}

fn read_small(root: &Path, rel: &str) -> Option<String> {
    let abs = paths::resolve(root, rel).ok()?;
    if fs::metadata(&abs).ok()?.len() > MAX_SCAN_BYTES {
        return None;
    }
    fs::read_to_string(abs).ok()
}

/// Нижний регистр посимвольно (1 символ → 1 символ), чтобы индексы совпадали.
fn fold(s: &str) -> Vec<char> {
    s.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

fn find_chars(hay: &[char], needle: &[char]) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| hay[i..i + needle.len()] == *needle)
}

/// Сниппет строки вокруг символа `at` (длинные строки обрезаются с «…»).
fn snippet(line: &str, at: usize) -> String {
    let chars: Vec<char> = line.trim_end().chars().collect();
    if chars.len() <= SNIPPET_CHARS {
        return chars.iter().collect::<String>().trim_start().to_owned();
    }
    let start = at.saturating_sub(SNIPPET_CHARS / 3);
    let end = (start + SNIPPET_CHARS).min(chars.len());
    let start = end.saturating_sub(SNIPPET_CHARS);
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s.insert(0, '…');
    }
    if end < chars.len() {
        s.push('…');
    }
    s
}

/// Полнотекстовый поиск (без учёта регистра) по всем заметкам: совпадения в
/// имени файла и в строках. Сначала файлы с совпадением в имени, затем по пути.
pub fn search(root: &Path, query: &str, limit: usize) -> AppResult<Vec<SearchHit>> {
    let q = fold(query.trim());
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    for path in list_notes(root)? {
        let name_match = find_chars(&fold(strip_md(file_name(&path))), &q).is_some();
        let mut lines = Vec::new();
        let mut total = 0usize;
        if let Some(content) = read_small(root, &path) {
            for (no, line) in content.lines().enumerate() {
                if let Some(at) = find_chars(&fold(line), &q) {
                    total += 1;
                    if lines.len() < MAX_LINES_PER_FILE {
                        lines.push(SearchLine {
                            line: no as u32,
                            text: snippet(line, at),
                        });
                    }
                }
            }
        }
        if name_match || total > 0 {
            hits.push(SearchHit {
                path,
                name_match,
                total: total as u32,
                lines,
            });
        }
    }
    hits.sort_by(|a, b| {
        b.name_match
            .cmp(&a.name_match)
            .then_with(|| natural_cmp(&a.path, &b.path))
    });
    hits.truncate(limit);
    Ok(hits)
}

/// Обратные ссылки: заметки, где есть ссылка (вики или markdown), которая
/// разрешается в `target` (заметку). Строки — сниппеты с этими ссылками.
pub fn backlinks(root: &Path, target: &str) -> AppResult<Vec<Backlink>> {
    let target = paths::normalize_rel(target)?;
    let notes = list_notes(root)?;
    let mut out = Vec::new();
    for source in &notes {
        if *source == target {
            continue;
        }
        let Some(content) = read_small(root, source) else {
            continue;
        };
        let lines: Vec<&str> = content.lines().collect();
        let mut found: Vec<SearchLine> = Vec::new();
        for link in links::extract(&content) {
            if links::resolve(&notes, &link.target, source).map(String::as_str)
                == Some(target.as_str())
                && !found.iter().any(|l| l.line as usize == link.line)
            {
                let line = lines.get(link.line).copied().unwrap_or("");
                found.push(SearchLine {
                    line: link.line as u32,
                    text: snippet(line, 0),
                });
            }
        }
        if !found.is_empty() {
            out.push(Backlink {
                path: source.clone(),
                lines: found,
            });
        }
    }
    Ok(out)
}

fn not_found_or(e: std::io::Error, what: impl FnOnce() -> String) -> AppError {
    if e.kind() == std::io::ErrorKind::NotFound {
        AppError::NotFound(what())
    } else {
        e.into()
    }
}
