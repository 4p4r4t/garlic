//! Слежение за папкой vault (`notify` + debouncer-full). Изменения снаружи
//! (Obsidian, проводник) превращаются в [`VaultEvent`]; эхо собственных
//! записей приложения отбрасывается ([`SelfWrites`]).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};

use super::paths::{is_hidden, is_md, to_rel};
use super::{VaultEvent, VaultEventKind};
use crate::error::{AppError, AppResult};

/// Задержка debouncer'а: пачка событий уходит через столько после последнего.
pub const DEBOUNCE: Duration = Duration::from_millis(250);
/// Пачки debouncer'а, пришедшие с меньшим интервалом, склеиваются в одну.
const GROUP: Duration = Duration::from_millis(300);
/// Сколько помним собственную запись.
const SELF_WRITE_TTL: Duration = Duration::from_secs(10);

pub type VaultWatcher = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Записи, сделанные самим приложением: путь → mtime после записи. Событие
/// изменения файла, у которого mtime всё ещё тот же, — эхо нашей записи.
#[derive(Default)]
pub struct SelfWrites(Mutex<HashMap<PathBuf, (SystemTime, Instant)>>);

impl SelfWrites {
    pub fn record(&self, path: PathBuf, mtime: SystemTime) {
        if let Ok(mut m) = self.0.lock() {
            m.retain(|_, (_, at)| at.elapsed() < SELF_WRITE_TTL);
            m.insert(path, (mtime, Instant::now()));
        }
    }

    pub fn is_echo(&self, path: &Path) -> bool {
        let Ok(m) = self.0.lock() else { return false };
        let Some((mtime, at)) = m.get(path) else {
            return false;
        };
        at.elapsed() < SELF_WRITE_TTL
            && fs::metadata(path).and_then(|md| md.modified()).ok() == Some(*mtime)
    }
}

/// Интересен ли путь фронту: не скрытый, и это `.md`, папка или (для удалённого,
/// тип которого уже не узнать) что угодно.
fn relevant(root: &Path, abs: &Path) -> Option<String> {
    let rel = to_rel(root, abs)?;
    if rel.is_empty() || rel.split('/').any(is_hidden) {
        return None;
    }
    let name = rel.rsplit('/').next().unwrap_or("");
    if is_md(name) || super::links::is_image(name) || abs.is_dir() || !abs.exists() {
        Some(rel)
    } else {
        None
    }
}

fn ev(kind: VaultEventKind, path: String, from: Option<String>, abs: &Path) -> VaultEvent {
    VaultEvent {
        kind,
        path,
        from,
        is_dir: abs.is_dir(),
    }
}

/// Одно событие notify → события vault (0, 1 или 2).
pub fn map_event(root: &Path, event: &notify::Event, writes: &SelfWrites) -> Vec<VaultEvent> {
    let mut out = Vec::new();
    let first = event.paths.first();
    match &event.kind {
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) if event.paths.len() >= 2 => {
            let (from, to) = (&event.paths[0], &event.paths[1]);
            match (relevant(root, from), relevant(root, to)) {
                (Some(f), Some(t)) => out.push(ev(VaultEventKind::Rename, t, Some(f), to)),
                // Атомарная запись (временный файл → заметка): для фронта — изменение.
                (None, Some(t)) if !writes.is_echo(to) => {
                    out.push(ev(VaultEventKind::Modify, t, None, to))
                }
                (Some(f), None) => out.push(ev(VaultEventKind::Remove, f, None, from)),
                _ => {}
            }
        }
        EventKind::Modify(ModifyKind::Name(mode)) => {
            if let Some(p) = first {
                if let Some(rel) = relevant(root, p) {
                    let gone = matches!(mode, RenameMode::From) || !p.exists();
                    let kind = if gone {
                        VaultEventKind::Remove
                    } else {
                        VaultEventKind::Create
                    };
                    if gone || !writes.is_echo(p) {
                        out.push(ev(kind, rel, None, p));
                    }
                }
            }
        }
        EventKind::Create(_) => {
            if let Some(p) = first {
                if let Some(rel) = relevant(root, p) {
                    if !writes.is_echo(p) {
                        out.push(ev(VaultEventKind::Create, rel, None, p));
                    }
                }
            }
        }
        EventKind::Modify(_) => {
            if let Some(p) = first {
                // Изменение папки (её содержимого) — не событие для фронта.
                if p.is_file() && !writes.is_echo(p) {
                    if let Some(rel) = relevant(root, p) {
                        out.push(ev(VaultEventKind::Modify, rel, None, p));
                    }
                }
            }
        }
        EventKind::Remove(_) => {
            if let Some(p) = first {
                if let Some(rel) = relevant(root, p) {
                    if !p.exists() {
                        out.push(ev(VaultEventKind::Remove, rel, None, p));
                    } else if p.is_file() && !writes.is_echo(p) {
                        // Замена файла (атомарная запись снаружи: удалить + переименовать
                        // временный) — для фронта это изменение, а не удаление.
                        out.push(ev(VaultEventKind::Modify, rel, None, p));
                    }
                }
            }
        }
        _ => {}
    }
    out
}

/// Перемещение между папками Windows сообщает как «удалено + создано». Пара
/// remove/create с одинаковым именем файла в одной пачке — это перемещение
/// (`rename` с `from`), чтобы ссылки нод и вкладки шли за файлом.
pub fn pair_moves(batch: Vec<VaultEvent>) -> Vec<VaultEvent> {
    let name = |p: &str| p.rsplit('/').next().unwrap_or("").to_owned();
    let mut out: Vec<VaultEvent> = Vec::with_capacity(batch.len());
    let mut used = vec![false; batch.len()];
    for i in 0..batch.len() {
        if used[i] {
            continue;
        }
        let e = &batch[i];
        if e.kind == VaultEventKind::Remove {
            let partner = (0..batch.len()).find(|&j| {
                !used[j]
                    && j != i
                    && batch[j].kind == VaultEventKind::Create
                    && name(&batch[j].path) == name(&e.path)
                    && batch[j].path != e.path
            });
            if let Some(j) = partner {
                used[i] = true;
                used[j] = true;
                out.push(VaultEvent {
                    kind: VaultEventKind::Rename,
                    path: batch[j].path.clone(),
                    from: Some(e.path.clone()),
                    is_dir: batch[j].is_dir,
                });
                continue;
            }
        }
        if e.kind == VaultEventKind::Create {
            // Create раньше своего Remove — ищем пару дальше.
            let partner = (i + 1..batch.len()).find(|&j| {
                !used[j]
                    && batch[j].kind == VaultEventKind::Remove
                    && name(&batch[j].path) == name(&e.path)
                    && batch[j].path != e.path
            });
            if let Some(j) = partner {
                used[i] = true;
                used[j] = true;
                out.push(VaultEvent {
                    kind: VaultEventKind::Rename,
                    path: e.path.clone(),
                    from: Some(batch[j].path.clone()),
                    is_dir: e.is_dir,
                });
                continue;
            }
        }
        used[i] = true;
        out.push(e.clone());
    }
    out
}

/// Запускает рекурсивное слежение за `root`. `on_events` вызывается из потока
/// debouncer'а пачками (пустые пачки не передаются). Слежение живёт, пока жив
/// возвращённый объект.
pub fn start<F>(
    root: PathBuf,
    writes: std::sync::Arc<SelfWrites>,
    on_events: F,
) -> AppResult<VaultWatcher>
where
    F: Fn(Vec<VaultEvent>) + Send + 'static,
{
    let watch_root = root.clone();
    // Второй уровень склейки: debouncer выдаёт события каждого пути по своему
    // таймеру, и «удалено + создано» одного перемещения может прийти разными
    // пачками. Копим пачки, пока они идут чаще GROUP, потом склеиваем и отдаём.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<VaultEvent>>();
    std::thread::Builder::new()
        .name("garlic-vault-events".into())
        .spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut all = first;
                while let Ok(more) = rx.recv_timeout(GROUP) {
                    for v in more {
                        if !all.contains(&v) {
                            all.push(v);
                        }
                    }
                }
                let batch = pair_moves(all);
                if !batch.is_empty() {
                    on_events(batch);
                }
            }
        })?;
    let mut debouncer = new_debouncer(DEBOUNCE, None, move |res: DebounceEventResult| match res {
        Ok(events) => {
            let mut batch: Vec<VaultEvent> = Vec::new();
            for e in &events {
                for v in map_event(&watch_root, e, &writes) {
                    if !batch.contains(&v) {
                        batch.push(v);
                    }
                }
            }
            if !batch.is_empty() {
                let _ = tx.send(batch);
            }
        }
        Err(errs) => {
            for e in errs {
                eprintln!("[garlic] vault watcher: {e}");
            }
        }
    })
    .map_err(|e| AppError::Other(format!("не удалось запустить слежение за папкой: {e}")))?;
    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| AppError::Other(format!("не удалось следить за папкой: {e}")))?;
    Ok(debouncer)
}
