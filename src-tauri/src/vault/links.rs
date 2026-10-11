//! Вики-ссылки `[[…]]` и markdown-ссылки на `.md`: извлечение и разрешение
//! по правилам Obsidian. TS-зеркало разрешения: `src/kb/links.ts`.

/// Ссылка, найденная в тексте заметки.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundLink {
    /// Цель без `#заголовка` и `|псевдонима`: `Заметка`, `папка/Заметка`, `Заметка.md`.
    pub target: String,
    /// Номер строки (с 0).
    pub line: usize,
}

/// Все ссылки заметки. Содержимое fenced-блоков кода и `инлайн-кода` пропускается.
pub fn extract(content: &str) -> Vec<FoundLink> {
    let mut out = Vec::new();
    let mut fence: Option<&str> = None;
    for (line_no, line) in content.lines().enumerate() {
        let trimmed = line.trim_start();
        if let Some(f) = fence {
            if trimmed.starts_with(f) {
                fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            fence = Some("```");
            continue;
        }
        if trimmed.starts_with("~~~") {
            fence = Some("~~~");
            continue;
        }
        scan_line(line, line_no, &mut out);
    }
    out
}

fn scan_line(line: &str, line_no: usize, out: &mut Vec<FoundLink>) {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'`' => {
                // Инлайн-код: пропускаем до такой же последовательности обратных кавычек.
                let run = b[i..].iter().take_while(|&&c| c == b'`').count();
                let fence = &line[i..i + run];
                match line[i + run..].find(fence) {
                    Some(end) => i += run + end + run,
                    None => i += run,
                }
            }
            b'[' if b.get(i + 1) == Some(&b'[') => {
                let start = i + 2;
                match line[start..].find("]]") {
                    Some(len) => {
                        let inner = &line[start..start + len];
                        if !inner.contains('[') {
                            push_target(inner, line_no, out);
                        }
                        i = start + len + 2;
                    }
                    None => i += 2,
                }
            }
            b']' if b.get(i + 1) == Some(&b'(') => {
                // `[текст](путь.md)` — только локальные ссылки на заметки.
                let start = i + 2;
                match line[start..].find(')') {
                    Some(len) => {
                        let url = line[start..start + len].trim();
                        let url = url.trim_start_matches('<').trim_end_matches('>');
                        let path = url.split('#').next().unwrap_or("");
                        if !url.contains("://") && crate::vault::paths::is_md(path) {
                            out.push(FoundLink {
                                target: percent_decode(path),
                                line: line_no,
                            });
                        }
                        i = start + len + 1;
                    }
                    None => i += 2,
                }
            }
            _ => i += 1,
        }
    }
}

fn push_target(inner: &str, line_no: usize, out: &mut Vec<FoundLink>) {
    let target = inner.split('|').next().unwrap_or("");
    let target = target.split('#').next().unwrap_or("").trim();
    if !target.is_empty() {
        out.push(FoundLink {
            target: target.to_owned(),
            line: line_no,
        });
    }
}

/// `%20` и прочие экранирования в markdown-ссылках.
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && b[i + 1].is_ascii_hexdigit()
            && b[i + 2].is_ascii_hexdigit()
        {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_owned())
}

/// Путь заметки без `.md`, в нижнем регистре — ключ сравнения.
fn key(path: &str) -> String {
    let p = if crate::vault::paths::is_md(path) {
        &path[..path.len() - 3]
    } else {
        path
    };
    p.to_lowercase()
}

/// Разрешает цель ссылки `target` из заметки `source` среди `notes` (пути `.md`).
///
/// Порядок (как в Obsidian): 1) путь относительно папки источника; 2) точный
/// путь от корня vault; 3) совпадение по имени файла / хвосту пути — при нескольких
/// кандидатах приоритет у заметки из папки источника, затем самый короткий путь,
/// затем по алфавиту.
pub fn resolve<'a>(notes: &'a [String], target: &str, source: &str) -> Option<&'a String> {
    let t = key(target.trim().trim_start_matches('/'));
    if t.is_empty() {
        return None;
    }
    let src_dir = crate::vault::paths::parent_rel(source).to_lowercase();
    if !src_dir.is_empty() {
        let rel = format!("{src_dir}/{t}");
        if let Some(n) = notes.iter().find(|n| key(n) == rel) {
            return Some(n);
        }
    }
    if let Some(n) = notes.iter().find(|n| key(n) == t) {
        return Some(n);
    }
    let suffix = format!("/{t}");
    notes
        .iter()
        .filter(|n| key(n).ends_with(&suffix))
        .min_by(|a, b| {
            let same_a = crate::vault::paths::parent_rel(a).to_lowercase() == src_dir;
            let same_b = crate::vault::paths::parent_rel(b).to_lowercase() == src_dir;
            same_b
                .cmp(&same_a)
                .then(a.len().cmp(&b.len()))
                .then_with(|| a.cmp(b))
        })
}
