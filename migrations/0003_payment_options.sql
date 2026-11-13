-- Новые свойства платежа: период «дважды в месяц», свой запас дней, ответственный,
-- автосписание, категория. Список периодов задан в CHECK, а SQLite не умеет его менять,
-- поэтому таблица пересоздаётся с переносом строк.
--
-- Журнал и отправленные напоминания ссылаются на payments по id. Проверка ссылок
-- откладывается до конца транзакции; чтобы она сошлась, строки нужно вставить обратно
-- в таблицу с тем же именем (переименование другой таблицы в payments ссылки не чинит).
PRAGMA defer_foreign_keys = true;

CREATE TABLE payments_backup AS SELECT * FROM payments;
DROP TABLE payments;

CREATE TABLE payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL CHECK (length(name) <= 64),
  due_date       TEXT    NOT NULL,              -- YYYY-MM-DD, фактический срок
  period         TEXT    NOT NULL DEFAULT 'monthly'
                 CHECK (period IN ('monthly', 'quarterly', 'yearly', 'biweekly', 'semimonthly', 'once')),
  month_days     TEXT,                          -- для «дважды в месяц»: два числа, например «10,25»
  remind_hour    INTEGER CHECK (remind_hour BETWEEN 0 AND 23), -- NULL = как в настройках
  warn_days      INTEGER CHECK (warn_days BETWEEN 1 AND 30),   -- NULL = как в настройках
  responsible_id INTEGER,                       -- Telegram id ответственного
  autopay        INTEGER NOT NULL DEFAULT 0,    -- списывается с карты само
  category       TEXT,
  note           TEXT,
  archived       INTEGER NOT NULL DEFAULT 0,
  deleted        INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER NOT NULL,
  updated_by     INTEGER NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO payments
  (id, name, due_date, period, remind_hour, note, archived, deleted, created_by, updated_by, created_at, updated_at)
  SELECT id, name, due_date, period, remind_hour, note, archived, deleted, created_by, updated_by, created_at, updated_at
  FROM payments_backup;

DROP TABLE payments_backup;
CREATE INDEX idx_payments_active ON payments (archived, deleted, due_date);
