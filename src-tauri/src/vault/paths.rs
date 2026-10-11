//! Относительные пути vault: нормализация, проверка, перевод в абсолютные.
//!
//! Путь в vault — строка с разделителем `/` относительно корня (`""` — сам корень).
//! Всё, что приходит от фронта, проходит через [`normalize_rel`] и [`resolve`]:
//! никаких `..`, абсолютных путей, дисков и выхода за корень через симлинки.

use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Символы, недопустимые в именах файлов Windows (и в путях vault).
pub const FORBIDDEN_CHARS: &[char] = &['<', '>', ':', '"', '|', '?', '*', '\\'];

/// Приводит относительный путь к каноническому виду `a/b/c.md`.
/// `\` → `/`, лишние `/` по краям и двойные убираются. Ошибка — `.`/`..`,
/// недопустимые символы, абсолютный путь.
pub fn normalize_rel(rel: &str) -> AppResult<String> {
    let rel = rel.trim().replace('\\', "/");
    let mut parts = Vec::new();
    for part in rel.split('/') {
        if part.is_empty() {
            continue;
        }
        if part == "." || part == ".." {
            return Err(AppError::Invalid(format!(
                "недопустимый путь в базе знаний: {rel}"
            )));
        }
        if part
            .chars()
            .any(|c| FORBIDDEN_CHARS.contains(&c) || c.is_control())
        {
            return Err(AppError::Invalid(format!(
                "недопустимые символы в пути: {rel}"
            )));
        }
        parts.push(part);
    }
    Ok(parts.join("/"))
}

/// Абсолютный путь для относительного `rel` внутри `root`.
///
/// Кроме синтаксической проверки, ближайший существующий предок пути
/// канонизируется и должен лежать внутри канонического корня — так
/// симлинк/junction внутри vault не выводит наружу.
pub fn resolve(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let rel = normalize_rel(rel)?;
    let mut abs = root.to_path_buf();
    for part in rel.split('/').filter(|p| !p.is_empty()) {
        abs.push(part);
    }
    // Paranoia: после join не должно появиться ничего кроме обычных компонентов.
    let tail = abs.strip_prefix(root).map_err(|_| outside(&rel))?;
    if tail
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(outside(&rel));
    }
    let root_canon = root
        .canonicalize()
        .map_err(|e| AppError::Other(format!("папка базы знаний недоступна: {e}")))?;
    let mut probe = abs.as_path();
    loop {
        if probe.exists() {
            let canon = probe.canonicalize()?;
            if !canon.starts_with(&root_canon) {
                return Err(outside(&rel));
            }
            break;
        }
        match probe.parent() {
            Some(p) => probe = p,
            None => return Err(outside(&rel)),
        }
    }
    Ok(abs)
}

/// Относительный путь (`/`) для абсолютного `abs` внутри `root`; `None` — снаружи.
pub fn to_rel(root: &Path, abs: &Path) -> Option<String> {
    let tail = abs.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for c in tail.components() {
        match c {
            Component::Normal(s) => parts.push(s.to_str()?.to_owned()),
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

/// Родительская папка относительного пути (`"a/b.md"` → `"a"`, `"b.md"` → `""`).
pub fn parent_rel(rel: &str) -> &str {
    rel.rfind('/').map_or("", |i| &rel[..i])
}

/// Последний компонент пути.
pub fn file_name(rel: &str) -> &str {
    rel.rfind('/').map_or(rel, |i| &rel[i + 1..])
}

/// `dir` + `/` + `name` (без ведущего `/` для корня).
pub fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

/// Файл заметки: расширение `.md` (без учёта регистра).
pub fn is_md(name: &str) -> bool {
    name.len() > 3 && name.as_bytes()[name.len() - 3..].eq_ignore_ascii_case(b".md")
}

/// Скрытые служебные папки/файлы (`.obsidian`, `.git`, `.trash`, наши временные).
pub fn is_hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn outside(rel: &str) -> AppError {
    AppError::Invalid(format!("путь вне базы знаний: {rel}"))
}
