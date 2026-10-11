//! Встроенные миграции. Индекс в массиве + 1 = значение `PRAGMA user_version`
//! после применения миграции. Существующие миграции не редактировать —
//! только добавлять новые в конец.

pub const MIGRATIONS: &[&str] = &[
    // v1 — базовая схема (ТЗ §6)
    r#"
CREATE TABLE spaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  root_canvas TEXT NOT NULL REFERENCES canvases(id),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE canvases (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL,
  owner_node  TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  viewport_x  REAL NOT NULL DEFAULT 0,
  viewport_y  REAL NOT NULL DEFAULT 0,
  zoom        REAL NOT NULL DEFAULT 1
);

CREATE TABLE nodes (
  id          TEXT PRIMARY KEY,
  canvas_id   TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('task','note')),
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT CHECK (status IN ('todo','in_progress','done')),
  color       TEXT,
  x           REAL NOT NULL,
  y           REAL NOT NULL,
  width       REAL,
  height      REAL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE edges (
  id            TEXT PRIMARY KEY,
  canvas_id     TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
  source        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target        TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source_handle TEXT,
  target_handle TEXT,
  label         TEXT
);

CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE INDEX idx_canvases_space ON canvases(space_id);
CREATE UNIQUE INDEX idx_canvases_owner ON canvases(owner_node) WHERE owner_node IS NOT NULL;
CREATE INDEX idx_nodes_canvas ON nodes(canvas_id);
CREATE INDEX idx_edges_canvas ON edges(canvas_id);
CREATE INDEX idx_edges_source ON edges(source);
CREATE INDEX idx_edges_target ON edges(target);
"#,
];
