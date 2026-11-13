-- Совладельцы: роль «owner» у людей из таблицы users. Главный владелец по-прежнему задан
-- в конфигурации (OWNER_ID) и в таблице не хранится. Список ролей задан в CHECK, поэтому
-- таблица пересоздаётся; на users никто не ссылается внешними ключами.
CREATE TABLE users_new (
  id         INTEGER PRIMARY KEY,            -- Telegram user id
  name       TEXT    NOT NULL,
  username   TEXT,
  role       TEXT    NOT NULL CHECK (role IN ('owner', 'admin', 'viewer', 'pending', 'rejected')),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO users_new (id, name, username, role, created_at, updated_at)
  SELECT id, name, username, role, created_at, updated_at FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
