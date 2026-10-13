//! Garlic — точка входа Tauri.

pub mod commands;
pub mod db;
pub mod error;
pub mod kblink;
pub mod model;
pub mod repo;
pub mod vault;

use std::sync::Mutex;

use tauri::Manager;

/// Имя файла БД в app data dir.
pub const DB_FILE: &str = "garlic.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // GARLIC_DATA_DIR — переопределение каталога данных (тесты, отладка).
            let dir = match std::env::var_os("GARLIC_DATA_DIR") {
                Some(d) => std::path::PathBuf::from(d),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&dir)?;
            let conn = db::open(&dir.join(DB_FILE))?;
            // Первый запуск: пространство по умолчанию с корневым холстом.
            repo::spaces::ensure_default(&conn)?;
            // База знаний: путь из app_state, иначе «Документы/Garlic Vault».
            let vault_root = match repo::app_state::get(&conn, vault::VAULT_PATH_KEY)? {
                Some(p) if !p.trim().is_empty() => std::path::PathBuf::from(p.trim()),
                _ => vault::default_root(&app.path().document_dir()?),
            };
            if let Err(e) = std::fs::create_dir_all(&vault_root) {
                eprintln!("[garlic] vault {}: {e}", vault_root.display());
            } else if let Err(e) = kblink::migrate_note_bodies(&conn, &vault_root) {
                // Флаг не поставлен — повторится при следующем запуске.
                eprintln!("[garlic] миграция заметок в .md: {e}");
            }
            app.manage(commands::Db(Mutex::new(conn)));
            let vault = vault::Vault::new(vault_root.clone());
            vault.restart_watcher(commands::vault_events_handler(app.handle().clone()));
            app.manage(vault);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_spaces,
            commands::create_space,
            commands::rename_space,
            commands::delete_space,
            commands::load_canvas,
            commands::load_subtree,
            commands::get_or_create_child_canvas,
            commands::save_viewport,
            commands::create_node,
            commands::update_node,
            commands::set_status_many,
            commands::move_nodes,
            commands::delete_nodes,
            commands::count_descendants,
            commands::create_edge,
            commands::delete_edges,
            commands::snapshot_graph,
            commands::restore_graph,
            commands::get_app_state,
            commands::set_app_state,
            commands::list_space_tasks,
            commands::list_graph_nodes,
            commands::list_all_tasks,
            commands::reorder_tasks,
            commands::vault_info,
            commands::vault_set_path,
            commands::vault_tree,
            commands::vault_read,
            commands::vault_write,
            commands::vault_create_note,
            commands::vault_create_folder,
            commands::vault_rename,
            commands::vault_move,
            commands::vault_delete,
            commands::vault_search,
            commands::vault_backlinks,
            commands::vault_abs_path,
            commands::kb_linked_nodes,
            commands::kb_result_links,
            commands::kb_create_target,
            commands::kb_note_to_folder,
            commands::kb_stat,
            commands::vault_read_image,
            commands::vault_save_attachment,
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска приложения Garlic");
}
