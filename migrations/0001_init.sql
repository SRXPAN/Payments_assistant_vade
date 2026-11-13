-- Пользователи с доступом и запросы на доступ. Владелец задаётся через OWNER_ID и здесь не хранится как роль.
CREATE TABLE users (
  id         INTEGER PRIMARY KEY,            -- Telegram user id
  name       TEXT    NOT NULL,
  username   TEXT,
  role       TEXT    NOT NULL CHECK (role IN ('admin', 'viewer', 'pending', 'rejected')),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL CHECK (length(name) <= 64),
  due_date    TEXT    NOT NULL,              -- YYYY-MM-DD, фактический срок (без сдвига на рабочий день)
  period      TEXT    NOT NULL DEFAULT 'monthly'
              CHECK (period IN ('monthly', 'quarterly', 'yearly', 'biweekly', 'once')),
  remind_hour INTEGER CHECK (remind_hour BETWEEN 0 AND 23), -- NULL = как в настройках
  archived    INTEGER NOT NULL DEFAULT 0,    -- разовый платёж оплачен
  deleted     INTEGER NOT NULL DEFAULT 0,    -- мягкое удаление
  created_by  INTEGER NOT NULL,
  updated_by  INTEGER NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payments_active ON payments (archived, deleted, due_date);

-- Журнал: кто, когда, старая дата -> новая дата.
CREATE TABLE payments_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments (id),
  user_id    INTEGER NOT NULL,
  user_name  TEXT    NOT NULL,               -- имя на момент действия
  action     TEXT    NOT NULL CHECK (action IN ('paid', 'edit_date', 'delete')),
  old_date   TEXT,
  new_date   TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_log_payment ON payments_log (payment_id, created_at);

-- Настройки: warn_days, check_hour, group_chat_id.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO settings (key, value) VALUES ('warn_days', '4'), ('check_hour', '12');

-- Состояние пошагового ввода.
CREATE TABLE fsm (
  chat_id    INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  state      TEXT    NOT NULL,
  data       TEXT    NOT NULL DEFAULT '{}',  -- JSON
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, user_id)
);

-- Защита от дублей: одно напоминание на платёж, срок и день.
CREATE TABLE sent_reminders (
  payment_id  INTEGER NOT NULL REFERENCES payments (id),
  due_date    TEXT    NOT NULL,              -- срок, по которому напоминали
  remind_date TEXT    NOT NULL,              -- локальная дата отправки
  chat_id     INTEGER NOT NULL,
  message_id  INTEGER NOT NULL,
  sent_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (payment_id, due_date, remind_date)
);
