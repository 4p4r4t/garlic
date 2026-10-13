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

/// Вид ссылки.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkKind {
    /// `[[цель]]`, `![[цель]]`.
    Wiki,
    /// `[текст](путь)`, `![альт](путь)`; `angle` — путь в `<…>`.
    Md { angle: bool },
}

/// Ссылка с позицией цели в тексте (для переписывания).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkSpan {
    /// Цель как её читает Obsidian (у markdown-ссылок — без `%20`).
    pub target: String,
    pub line: usize,
    /// Байтовый диапазон цели в тексте (без `#заголовка`, `|псевдонима`, `<>`).
    pub start: usize,
    pub end: usize,
    pub kind: LinkKind,
}

/// Расширения картинок, которые показывает база (проводник, `![[…]]`).
pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg"];

/// Файл-картинка по расширению (без учёта регистра).
pub fn is_image(name: &str) -> bool {
    name.rsplit_once('.').is_some_and(|(stem, ext)| {
        !stem.is_empty() && IMAGE_EXTS.iter().any(|e| ext.eq_ignore_ascii_case(e))
    })
}

/// Все ссылки заметки. Содержимое fenced-блоков кода и `инлайн-кода` пропускается.
/// Markdown-ссылки — только на `.md` (обратные ссылки); вики-ссылки — любые.
pub fn extract(content: &str) -> Vec<FoundLink> {
    scan(content)
        .into_iter()
        .filter(|l| l.kind == LinkKind::Wiki || crate::vault::paths::is_md(&l.target))
        .map(|l| FoundLink {
            target: l.target,
            line: l.line,
        })
        .collect()
}

/// Все ссылки заметки с позициями цели: вики, markdown на `.md` и на картинки.
pub fn scan(content: &str) -> Vec<LinkSpan> {
    let mut out = Vec::new();
    let mut fence: Option<&str> = None;
    let mut base = 0usize;
    for (line_no, raw) in content.split_inclusive('\n').enumerate() {
        let line = raw.trim_end_matches(['\n', '\r']);
        let off = base;
        base += raw.len();
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
        scan_line(line, line_no, off, &mut out);
    }
    out
}

fn scan_line(line: &str, line_no: usize, off: usize, out: &mut Vec<LinkSpan>) {
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
                            push_wiki(inner, line_no, off + start, out);
                        }
                        i = start + len + 2;
                    }
                    None => i += 2,
                }
            }
            b']' if b.get(i + 1) == Some(&b'(') => {
                // `[текст](путь)` — локальные ссылки на заметки и картинки.
                let start = i + 2;
                match line[start..].find(')') {
                    Some(len) => {
                        push_md(&line[start..start + len], line_no, off + start, out);
                        i = start + len + 1;
                    }
                    None => i += 2,
                }
            }
            _ => i += 1,
        }
    }
}

fn push_wiki(inner: &str, line_no: usize, at: usize, out: &mut Vec<LinkSpan>) {
    let left = inner.split('|').next().unwrap_or("");
    let left = left.split('#').next().unwrap_or("");
    let lead = left.len() - left.trim_start().len();
    let mut target = left.trim();
    // `[[цель\|псевдоним]]` в таблицах: слэш экранирует `|`.
    if let Some(t) = target.strip_suffix('\\') {
        target = t.trim_end();
    }
    if target.is_empty() {
        return;
    }
    out.push(LinkSpan {
        target: target.to_owned(),
        line: line_no,
        start: at + lead,
        end: at + lead + target.len(),
        kind: LinkKind::Wiki,
    });
}

fn push_md(raw: &str, line_no: usize, at: usize, out: &mut Vec<LinkSpan>) {
    let lead = raw.len() - raw.trim_start().len();
    let url = raw.trim();
    let (angle, body, skip) = match url.strip_prefix('<') {
        Some(rest) => (true, rest.split('>').next().unwrap_or(""), 1),
        None => (false, url, 0),
    };
    // `путь.md "заголовок"` — заголовок ссылки отбрасываем.
    let body = if angle {
        body
    } else {
        body.find(" \"").map_or(body, |p| &body[..p])
    };
    let path = body.split('#').next().unwrap_or("");
    let lower = path.to_ascii_lowercase();
    if path.is_empty()
        || path.contains("://")
        || lower.starts_with("mailto:")
        || lower.starts_with("data:")
    {
        return;
    }
    let decoded = percent_decode(path);
    if !crate::vault::paths::is_md(&decoded) && !is_image(&decoded) {
        return;
    }
    out.push(LinkSpan {
        target: decoded,
        line: line_no,
        start: at + lead + skip,
        end: at + lead + skip + path.len(),
        kind: LinkKind::Md { angle },
    });
}

/// Применяет правки `(start, end, текст)` (непересекающиеся) к тексту.
pub fn apply_edits(content: &str, edits: &[(usize, usize, String)]) -> String {
    let mut sorted: Vec<&(usize, usize, String)> = edits.iter().collect();
    sorted.sort_by_key(|e| e.0);
    let mut out = String::with_capacity(content.len());
    let mut at = 0;
    for (start, end, text) in sorted {
        if *start < at {
            continue;
        }
        out.push_str(&content[at..*start]);
        out.push_str(text);
        at = *end;
    }
    out.push_str(&content[at..]);
    out
}

/// `%20` и прочие экранирования в markdown-ссылках.
pub fn percent_decode(s: &str) -> String {
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

/// Склеивает относительный путь `rel` (`./x`, `../x`) с папкой `dir`; `None` —
/// выход выше корня.
fn join_relative(dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = dir.split('/').filter(|p| !p.is_empty()).collect();
    for p in rel.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

/// Разрешает цель ссылки `target` из заметки `source` среди `notes` (пути файлов
/// vault: заметки `.md` и вложения).
///
/// Порядок (как в Obsidian):
/// - `./…` и `../…` — путь относительно папки источника;
/// - путь относительно папки источника;
/// - точный путь от корня vault;
/// - совпадение по имени файла / хвосту пути — при нескольких кандидатах приоритет
///   у файла из папки источника, затем самый короткий путь, затем по алфавиту.
pub fn resolve<'a>(notes: &'a [String], target: &str, source: &str) -> Option<&'a String> {
    let raw = target.trim();
    let src_dir = crate::vault::paths::parent_rel(source).to_lowercase();
    if raw.starts_with("./") || raw.starts_with("../") {
        let joined = key(&join_relative(&src_dir, raw)?);
        return notes.iter().find(|n| key(n) == joined);
    }
    let t = key(raw.trim_start_matches('/'));
    if t.is_empty() {
        return None;
    }
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

/// Путь `to` относительно папки `from_dir` (`../x/y.md`).
fn relative_path(from_dir: &str, to: &str) -> String {
    let a: Vec<&str> = from_dir.split('/').filter(|p| !p.is_empty()).collect();
    let b: Vec<&str> = to.split('/').collect();
    let common = a
        .iter()
        .zip(b.iter().take(b.len().saturating_sub(1)))
        .take_while(|(x, y)| x == y)
        .count();
    let mut parts: Vec<&str> = vec![".."; a.len() - common];
    parts.extend(&b[common..]);
    parts.join("/")
}

/// Текст цели ссылки на файл `new_path` из заметки `source` (после переноса):
/// кратчайший вид, который разрешается именно в этот файл, — имя, затем хвосты
/// пути подлиннее (но не короче `min_segments` сегментов). `keep_ext` — оставить
/// `.md` (у файлов-не-заметок расширение остаётся всегда). `relative` —
/// относительный путь от папки источника (`./x`, `../x`).
pub fn link_target_for(
    files: &[String],
    new_path: &str,
    source: &str,
    min_segments: usize,
    keep_ext: bool,
    relative: bool,
) -> String {
    let is_note = crate::vault::paths::is_md(new_path);
    let strip = |p: &str| -> String {
        if is_note && !keep_ext {
            p[..p.len() - 3].to_owned()
        } else {
            p.to_owned()
        }
    };
    if relative {
        let rel = relative_path(crate::vault::paths::parent_rel(source), new_path);
        let rel = if rel.starts_with("../") {
            rel
        } else {
            format!("./{rel}")
        };
        return strip(&rel);
    }
    let segs: Vec<&str> = new_path.split('/').collect();
    for k in min_segments.max(1)..=segs.len() {
        let cand = strip(&segs[segs.len() - k..].join("/"));
        if resolve(files, &cand, source).map(String::as_str) == Some(new_path) {
            return cand;
        }
    }
    strip(new_path)
}

/// `%`-кодирование пробелов и скобок в markdown-ссылке (Obsidian пишет `%20`).
pub fn encode_md_path(p: &str) -> String {
    p.replace(' ', "%20")
        .replace('(', "%28")
        .replace(')', "%29")
}
