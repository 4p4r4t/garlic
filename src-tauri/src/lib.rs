//! Garlic — точка входа Tauri.

pub mod commands;
pub mod db;
pub mod error;
pub mod model;
pub mod repo;

use std::sync::Mutex;

use tauri::Manager;

/// Имя файла БД в app data dir.
pub const DB_FILE: &str = "garlic.db";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            app.manage(commands::Db(Mutex::new(conn)));
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
            commands::move_nodes,
            commands::delete_nodes,
            commands::count_descendants,
            commands::create_edge,
            commands::delete_edges,
            commands::get_app_state,
            commands::set_app_state,
            commands::list_space_tasks,
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска приложения Garlic");
}
