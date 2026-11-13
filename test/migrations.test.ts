// Миграции применяются к базе, в которой уже есть платежи, журнал и отправленные напоминания:
// пересоздание таблиц не должно терять строки и рвать ссылки между таблицами.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const files = readdirSync("migrations").sort();
/** D1 выполняет каждую миграцию одной транзакцией. */
const apply = (db: DatabaseSync, file: string) =>
  db.exec(`BEGIN;\n${readFileSync(`migrations/${file}`, "utf8")}\nCOMMIT;`);

describe("миграции", () => {
  it("файлы идут по порядку номеров", () => {
    expect(files).toEqual(["0001_init.sql", "0002_note_undo.sql", "0003_payment_options.sql", "0004_co_owners.sql"]);
  });

  it("данные и ссылки сохраняются на каждом шаге", () => {
    const db = new DatabaseSync(":memory:");
    const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

    apply(db, files[0]!);
    db.exec(`
      INSERT INTO payments (id, name, due_date, period, remind_hour, created_by, updated_by)
        VALUES (1, 'Интернет', '2026-11-20', 'monthly', 9, 7, 7), (5, 'Ремонт', '2026-12-01', 'once', NULL, 7, 7);
      INSERT INTO payments_log (payment_id, user_id, user_name, action, old_date, new_date)
        VALUES (1, 7, 'Сеня', 'paid', '2026-10-20', '2026-11-20'), (5, 7, 'Сеня', 'edit_date', '2026-11-01', '2026-12-01');
      INSERT INTO sent_reminders (payment_id, due_date, remind_date, chat_id, message_id)
        VALUES (1, '2026-11-20', '2026-11-16', -100, 10);
    `);

    db.exec("INSERT INTO users (id, name, username, role) VALUES (7, 'Сеня', 'senya', 'admin'), (8, 'Оля', NULL, 'rejected')");

    apply(db, files[1]!);
    expect(count("payments_log")).toBe(2);
    db.exec("UPDATE payments SET note = 'Договор 15' WHERE id = 1");

    apply(db, files[2]!);
    expect(count("payments")).toBe(2);
    expect(count("payments_log")).toBe(2);
    expect(count("sent_reminders")).toBe(1);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT id, name, period, remind_hour, note, autopay, warn_days FROM payments ORDER BY id").all()).toEqual([
      { id: 1, name: "Интернет", period: "monthly", remind_hour: 9, note: "Договор 15", autopay: 0, warn_days: null },
      { id: 5, name: "Ремонт", period: "once", remind_hour: null, note: null, autopay: 0, warn_days: null },
    ]);

    // Люди и их роли переживают пересоздание таблицы; появляется роль «владелец».
    apply(db, files[3]!);
    expect(db.prepare("SELECT id, name, username, role FROM users ORDER BY id").all()).toEqual([
      { id: 7, name: "Сеня", username: "senya", role: "admin" },
      { id: 8, name: "Оля", username: null, role: "rejected" },
    ]);
    db.exec("UPDATE users SET role = 'owner' WHERE id = 7");
    expect(() => db.exec("UPDATE users SET role = 'boss' WHERE id = 7")).toThrow(/CHECK/);

    // Новые платежи получают следующий id, новый период разрешён, ссылки по-прежнему проверяются.
    const next = db
      .prepare("INSERT INTO payments (name, due_date, period, month_days, created_by, updated_by) VALUES ('Зарплата', '2026-12-10', 'semimonthly', '10,25', 7, 7) RETURNING id")
      .get() as { id: number };
    expect(next.id).toBe(6);
    expect(() =>
      db.exec("INSERT INTO payments_log (payment_id, user_id, user_name, action) VALUES (999, 7, 'x', 'paid')"),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      db.exec("INSERT INTO payments (name, due_date, period, created_by, updated_by) VALUES ('x', '2026-12-10', 'weekly', 7, 7)"),
    ).toThrow(/CHECK/);
  });
});
