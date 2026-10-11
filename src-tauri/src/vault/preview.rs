//! Превью заметки для карточки ноды (ТЗ §4.10, «Нода-заметка»): первые строки
//! текста без frontmatter и разметки Markdown.

use std::io::Read;
use std::path::Path;

/// Сколько байт файла читать для превью.
const READ_BYTES: u64 = 16 * 1024;
/// Строк в превью.
pub const PREVIEW_LINES: usize = 3;
/// Символов в превью (всего).
pub const PREVIEW_CHARS: usize = 280;

/// Превью файла заметки (`None` — не прочитать).
pub fn of_file(abs: &Path) -> Option<String> {
    let f = std::fs::File::open(abs).ok()?;
    let mut buf = Vec::new();
    f.take(READ_BYTES).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    Some(preview(&text, PREVIEW_LINES, PREVIEW_CHARS))
}

/// Первые `max_lines` непустых строк текста `content` без frontmatter, служебных
/// строк (ограждения кода, `---`, разделители таблиц) и разметки; не длиннее
/// `max_chars` символов (с «…» при обрезке).
pub fn preview(content: &str, max_lines: usize, max_chars: usize) -> String {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.lines().peekable();
    // frontmatter: `---` в первой строке … `---` / `...`
    if lines.peek().map(|l| l.trim_end()) == Some("---") {
        let mut probe = content.lines().skip(1);
        if probe.any(|l| matches!(l.trim_end(), "---" | "...")) {
            lines.next();
            for l in lines.by_ref() {
                if matches!(l.trim_end(), "---" | "...") {
                    break;
                }
            }
        }
    }
    let mut out: Vec<String> = Vec::new();
    let mut chars = 0usize;
    for raw in lines {
        if out.len() >= max_lines || chars >= max_chars {
            break;
        }
        let t = raw.trim();
        if t.is_empty()
            || t.starts_with("```")
            || t.starts_with("~~~")
            || is_rule(t)
            || is_table_sep(t)
        {
            continue;
        }
        let line = strip_inline(strip_block(t));
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        chars += line.chars().count();
        out.push(line.to_owned());
    }
    let mut s = out.join("\n");
    if s.chars().count() > max_chars {
        s = s
            .chars()
            .take(max_chars)
            .collect::<String>()
            .trim_end()
            .to_owned();
        s.push('…');
    }
    s
}

/// `---`, `***`, `___` (горизонтальная линия).
fn is_rule(t: &str) -> bool {
    let c: String = t.chars().filter(|c| !c.is_whitespace()).collect();
    c.len() >= 3
        && (c.chars().all(|ch| ch == '-')
            || c.chars().all(|ch| ch == '*')
            || c.chars().all(|ch| ch == '_'))
}

/// `|---|:--:|` — разделитель шапки таблицы.
fn is_table_sep(t: &str) -> bool {
    t.contains('-') && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
}

/// Блочная разметка в начале строки: заголовки, цитаты, маркеры списков, чекбоксы.
fn strip_block(mut t: &str) -> &str {
    loop {
        let before = t;
        t = t.trim_start();
        if let Some(rest) = t.strip_prefix('>') {
            t = rest;
        } else if t.starts_with('#') {
            let rest = t.trim_start_matches('#');
            if rest.is_empty() || rest.starts_with(' ') {
                t = rest;
            }
        } else if let Some(rest) = t
            .strip_prefix("- ")
            .or_else(|| t.strip_prefix("* "))
            .or_else(|| t.strip_prefix("+ "))
        {
            t = rest;
        } else if let Some(rest) = ordered_marker(t) {
            t = rest;
        } else if let Some(rest) = t
            .strip_prefix("[ ] ")
            .or_else(|| t.strip_prefix("[x] "))
            .or_else(|| t.strip_prefix("[X] "))
        {
            t = rest;
        }
        if t == before {
            return t;
        }
    }
}

/// `1. ` / `1) ` — маркер нумерованного списка.
fn ordered_marker(t: &str) -> Option<&str> {
    let digits = t.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 9 {
        return None;
    }
    let rest = &t[digits..];
    rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))
}

/// Строчная разметка: ссылки/картинки/вики-ссылки → текст, маркеры выделения и кода убираются.
fn strip_inline(t: &str) -> String {
    let chars: Vec<char> = t.chars().collect();
    let mut out = String::with_capacity(t.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        // ![[embed]] / [[target|alias]]
        let wiki_at =
            if c == '!' && chars.get(i + 1) == Some(&'[') && chars.get(i + 2) == Some(&'[') {
                Some(i + 3)
            } else if c == '[' && chars.get(i + 1) == Some(&'[') {
                Some(i + 2)
            } else {
                None
            };
        if let Some(start) = wiki_at {
            if let Some(end) = find(&chars, start, &[']', ']']) {
                let inner: String = chars[start..end].iter().collect();
                let shown = match inner.split_once('|') {
                    Some((_, alias)) => alias.to_owned(),
                    None => inner.split('#').next().unwrap_or("").to_owned(),
                };
                out.push_str(shown.trim());
                i = end + 2;
                continue;
            }
        }
        // ![alt](url) / [text](url)
        let link_at = if c == '!' && chars.get(i + 1) == Some(&'[') {
            Some(i + 2)
        } else if c == '[' {
            Some(i + 1)
        } else {
            None
        };
        if let Some(start) = link_at {
            if let Some(close) = find(&chars, start, &[']', '(']) {
                if let Some(end) = find(&chars, close + 2, &[')']) {
                    out.extend(&chars[start..close]);
                    i = end + 1;
                    continue;
                }
            }
        }
        match c {
            '*' | '`' => {}
            '~' | '=' if chars.get(i + 1) == Some(&c) => {
                i += 1;
            }
            '_' if chars.get(i + 1) == Some(&'_') => {
                i += 1;
            }
            _ => out.push(c),
        }
        i += 1;
    }
    out
}

fn find(chars: &[char], from: usize, pat: &[char]) -> Option<usize> {
    if from > chars.len() || pat.len() > chars.len() {
        return None;
    }
    (from..=chars.len() - pat.len()).find(|&i| chars[i..i + pat.len()] == *pat)
}

#[cfg(test)]
mod tests {
    use super::preview;

    #[test]
    fn strips_frontmatter_and_markdown() {
        let md = "---\ntags: [a]\n---\n# Заголовок\n\n- [ ] **сделать** [[План|план]]\n> цитата с `кодом` и [ссылкой](http://x)\n\nчетвёртая";
        assert_eq!(
            preview(md, 3, 280),
            "Заголовок\nсделать план\nцитата с кодом и ссылкой"
        );
    }

    #[test]
    fn skips_rules_fences_tables_and_truncates() {
        let md = "```rust\nfn x() {}\n```\n---\n| a | b |\n|---|---|\n1. один";
        assert_eq!(preview(md, 3, 280), "fn x() {}\n| a | b |\nодин");
        let long = "я".repeat(400);
        let p = preview(&long, 3, 10);
        assert_eq!(p.chars().count(), 11);
        assert!(p.ends_with('…'));
        // незакрытый frontmatter — обычный текст (линия пропускается)
        assert_eq!(preview("---\nтекст", 3, 280), "текст");
        assert_eq!(
            preview("![[pic.png]] ~~old~~ ==hl== snake_case", 3, 280),
            "pic.png old hl snake_case"
        );
    }
}
