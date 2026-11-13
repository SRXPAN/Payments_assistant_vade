-- Заметка к платежу: где платить, номер договора, кто отвечает.
ALTER TABLE payments ADD COLUMN note TEXT;

-- Журнал: новые действия «отмена оплаты» и «восстановление», пометка отменённой оплаты.
-- SQLite не умеет менять CHECK, поэтому таблица пересоздаётся с переносом строк.
CREATE TABLE payments_log_new (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments (id),
  user_id    INTEGER NOT NULL,
  user_name  TEXT    NOT NULL,
  action     TEXT    NOT NULL CHECK (action IN ('paid', 'edit_date', 'delete', 'undo', 'restore')),
  old_date   TEXT,
  new_date   TEXT,
  undone     INTEGER NOT NULL DEFAULT 0,     -- оплату потом отменили
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO payments_log_new (id, payment_id, user_id, user_name, action, old_date, new_date, created_at)
  SELECT id, payment_id, user_id, user_name, action, old_date, new_date, created_at FROM payments_log;
DROP TABLE payments_log;
ALTER TABLE payments_log_new RENAME TO payments_log;
CREATE INDEX idx_log_payment ON payments_log (payment_id, id);
