//! Обновление ссылок при переименовании/перемещении внутри приложения (ТЗ §4.10,
//! M6c; опция Obsidian «Automatically update internal links»).
//!
//! Порядок: до операции снимается список файлов vault ([`snapshot`]), операция
//! выполняется, затем [`rewrite`] проходит по всем заметкам и переписывает
//! только те ссылки, которые раньше разрешались в перенесённый файл (или стоят
//! в перенесённой заметке) и после переноса разрешались бы не туда. Ссылка,
//! которая и после переноса указывает на тот же файл (например `[[имя]]` при
//! перемещении в другую папку), не трогается. Новая цель — кратчайшая из
//! однозначных (имя → хвосты пути), как у Obsidian; `#заголовок`, `|псевдоним`,
//! `!` встраивания и подпись markdown-ссылки сохраняются — заменяется только
//! цель. Записи атомарные ([`ops::write_atomic`]).

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::links::{self, LinkKind};
use super::paths::{self, is_md};
use super::{ops, Move};
use crate::error::AppResult;

/// Ключ app_state: «Обновлять ссылки при переименовании» (`"0"` — выключено).
pub const UPDATE_LINKS_KEY: &str = "kb.update_links";

/// Итог переписывания ссылок.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkReport {
    /// Сколько ссылок переписано.
    pub links: usize,
    /// Заметки с переписанными ссылками (пути уже после переноса).
    pub files: Vec<String>,
}

impl Move {
    /// Куда переехал путь `p` при этом переносе (сам файл/папка или вложенное).
    pub fn map(&self, p: &str) -> String {
        if p == self.from {
            self.to.clone()
        } else if let Some(rest) = p.strip_prefix(&format!("{}/", self.from)) {
            format!("{}/{rest}", self.to)
        } else {
            p.to_owned()
        }
    }
}

/// Файлы vault, на которые можно ссылаться (заметки и картинки), до операции.
pub fn snapshot(root: &Path) -> AppResult<Vec<String>> {
    ops::list_linkable(root)
}

/// Переписывает ссылки после переноса `mv`. `before` — [`snapshot`] до операции.
pub fn rewrite(root: &Path, before: &[String], mv: &Move) -> AppResult<RelinkReport> {
    let after: Vec<String> = before.iter().map(|p| mv.map(p)).collect();
    let mut report = RelinkReport::default();
    for old_src in before.iter().filter(|p| is_md(p)) {
        let new_src = mv.map(old_src);
        let Some(content) = ops::read_small(root, &new_src) else {
            continue;
        };
        let mut edits = Vec::new();
        for link in links::scan(&content) {
            let Some(old_target) = links::resolve(before, &link.target, old_src) else {
                continue;
            };
            let new_target = mv.map(old_target);
            // Не двигались ни цель, ни сама заметка — ссылка не затронута.
            if new_target == *old_target && new_src == *old_src {
                continue;
            }
            // После переноса ссылка по-прежнему попадает в тот же файл — оставляем.
            if links::resolve(&after, &link.target, &new_src) == Some(&new_target) {
                continue;
            }
            let text = new_link_text(&after, &new_target, &new_src, &link);
            if text != content[link.start..link.end] {
                edits.push((link.start, link.end, text));
            }
        }
        if edits.is_empty() {
            continue;
        }
        let updated = links::apply_edits(&content, &edits);
        let abs = paths::resolve(root, &new_src)?;
        ops::write_atomic(&abs, &updated)?;
        report.links += edits.len();
        report.files.push(new_src);
    }
    Ok(report)
}

/// Новый текст цели для ссылки `link` на файл `new_target`.
fn new_link_text(
    after: &[String],
    new_target: &str,
    source: &str,
    link: &links::LinkSpan,
) -> String {
    let orig = link.target.as_str();
    let relative = orig.starts_with("./") || orig.starts_with("../");
    let min_segments = if relative {
        1
    } else {
        orig.trim_matches('/').split('/').count()
    };
    let is_md_link = matches!(link.kind, LinkKind::Md { .. });
    let keep_ext = is_md_link || is_md(orig);
    let text = links::link_target_for(after, new_target, source, min_segments, keep_ext, relative);
    match link.kind {
        LinkKind::Wiki => text,
        // Пробелы кодируем, если автор их кодировал или в пути их не было (как Obsidian);
        // в `<…>` и в сыром виде с пробелами — оставляем как есть.
        LinkKind::Md { angle } => {
            if angle {
                text
            } else {
                links::encode_md_path(&text)
            }
        }
    }
}
