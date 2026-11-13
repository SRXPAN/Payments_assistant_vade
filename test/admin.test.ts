import { describe, expect, it } from "vitest";
import { logCsv, paymentsCsv, toCsv } from "../src/csv";
import type { UserRow } from "../src/db";
import { helpText } from "../src/help";
import { accessListView, settingsView, trashView, userCardView } from "../src/views";

describe("справка", () => {
  it("наблюдателю — только про список и статусы", () => {
    const text = helpText("viewer", 4);
    expect(text).toContain("📋 Список");
    expect(text).toContain("🟡 — осталось 4 дн. или меньше");
    expect(text).toContain("наблюдатель");
    expect(text).not.toContain("➕ Добавить");
    expect(text).not.toContain("👥 Доступ");
  });
  it("админу — ещё про добавление, карточку и напоминания, но не про доступ", () => {
    const text = helpText("admin", 7);
    expect(text).toContain("➕ Добавить");
    expect(text).toContain("↩️ Отменить оплату");
    expect(text).toContain("за 7 дн. до срока");
    expect(text).not.toContain("👥 Доступ");
  });
  it("владельцу — всё, включая доступ, настройки и корзину", () => {
    const text = helpText("owner", 4);
    expect(text).toContain("👥 Доступ");
    expect(text).toContain("🗑 Корзина");
    expect(text.length).toBeLessThanOrEqual(4096);
  });
});

function buttons(view: { keyboard: { inline_keyboard: unknown[][] } }): [string, string][] {
  return view.keyboard.inline_keyboard.flat().map((b) => {
    const btn = b as { text: string; callback_data: string };
    return [btn.text, btn.callback_data];
  });
}

const user = (id: number, name: string, role: UserRow["role"], username: string | null = null): UserRow => ({
  id,
  name,
  username,
  role,
});

describe("настройки", () => {
  it("значения по умолчанию: 4 дня, 12:00, группы нет", () => {
    const view = settingsView({});
    expect(view.text).toContain("Предупреждать за: 4 дн.");
    expect(view.text).toContain("Время проверки: 12:00");
    expect(view.text).toContain("Группа: не привязана");
    expect(buttons(view)).toEqual([
      ["3 дн.", "s:days:3"],
      ["✅ 4 дн.", "s:days:4"],
      ["5 дн.", "s:days:5"],
      ["7 дн.", "s:days:7"],
      ["9:00", "s:hour:9"],
      ["10:00", "s:hour:10"],
      ["✅ 12:00", "s:hour:12"],
      ["🧪 Проверить сейчас", "s:test"],
      ["📤 Экспорт CSV", "s:csv"],
      ["🗑 Корзина", "s:trash"],
    ]);
  });
  it("корзина: удалённые и архивные платежи с кнопкой восстановления", () => {
    const view = trashView([
      { id: 5, name: "Старый хостинг", due_date: "2026-10-01", archived: 0, deleted: 1 },
      { id: 6, name: "Ремонт", due_date: "2026-11-20", archived: 1, deleted: 0 },
    ]);
    expect(buttons(view)).toEqual([
      ["♻️ Старый хостинг — удалён", "s:restore:5"],
      ["♻️ Ремонт — архив", "s:restore:6"],
      ["↩️ Назад", "s:back"],
    ]);
    expect(trashView([]).text).toContain("Корзина пуста");
  });
  it("привязанная группа: название и кнопка «Отвязать»", () => {
    const view = settingsView({ warn_days: "7", check_hour: "9", group_chat_id: "-100123", group_title: "Клуб" });
    expect(view.text).toContain("Группа: Клуб");
    const labels = buttons(view).map(([text]) => text);
    expect(labels).toContain("Отвязать группу");
    expect(labels).toContain("✅ 7 дн.");
    expect(labels).toContain("✅ 9:00");
  });
});

describe("доступ", () => {
  it("список людей с ролями", () => {
    const view = accessListView([user(1, "Сеня", "admin"), user(2, "Оля", "viewer"), user(3, "Макс", "pending")]);
    expect(buttons(view)).toEqual([
      ["Сеня — админ", "u:open:1"],
      ["Оля — наблюдатель", "u:open:2"],
      ["⏳ Макс — ждёт решения", "u:open:3"],
    ]);
  });
  it("карточка админа: нельзя «сделать админом» повторно", () => {
    const view = userCardView(user(1, "Сеня", "admin", "senya"));
    expect(view.text).toBe("Сеня (@senya, 1)\nРоль: админ");
    expect(buttons(view)).toEqual([
      ["Сделать наблюдателем", "u:set:1:viewer"],
      ["Забрать доступ", "u:revoke:1"],
      ["↩️ Назад", "u:list"],
    ]);
  });
  it("человек без доступа виден в списке; из карточки можно вернуть роль или снять блокировку", () => {
    const blocked = user(4, "Гость", "rejected");
    expect(buttons(accessListView([blocked]))).toEqual([["🚫 Гость — нет доступа", "u:open:4"]]);
    expect(buttons(userCardView(blocked))).toEqual([
      ["Сделать админом", "u:set:4:admin"],
      ["Сделать наблюдателем", "u:set:4:viewer"],
      ["Удалить из списка", "u:forget:4"],
      ["↩️ Назад", "u:list"],
    ]);
  });
  it("карточка ожидающего: обе роли и «Отклонить»", () => {
    expect(buttons(userCardView(user(3, "Макс", "pending"))).map(([text]) => text)).toEqual([
      "Сделать админом",
      "Сделать наблюдателем",
      "Отклонить",
      "↩️ Назад",
    ]);
  });
});

describe("CSV", () => {
  it("BOM, разделитель «;», экранирование кавычек и точек с запятой", () => {
    expect(toCsv(["a", "b"], [["x;y", 'он сказал "да"'], [1, null]])).toBe(
      '﻿a;b\r\n"x;y";"он сказал ""да"""\r\n1;\r\n',
    );
  });
  it("название, похожее на формулу, не выполняется в Excel", () => {
    expect(toCsv(["n"], [["=2+2"]])).toContain("'=2+2");
    expect(toCsv(["n"], [[-5]])).toContain("\r\n-5\r\n"); // числа не трогаем
  });
  it("платежи: статус и период по-русски", () => {
    const csv = paymentsCsv([
      {
        id: 1,
        name: "Интернет",
        due_date: "2026-12-12",
        period: "monthly",
        remind_hour: 9,
        note: "Договор 15; платит Сеня",
        archived: 0,
        deleted: 0,
        created_at: "2026-11-01 10:00:00",
        updated_at: "2026-11-12 10:00:00",
      },
      {
        id: 2,
        name: "Ремонт",
        due_date: "2026-11-20",
        period: "once",
        remind_hour: null,
        note: null,
        archived: 1,
        deleted: 0,
        created_at: "2026-11-01 10:00:00",
        updated_at: "2026-11-12 10:00:00",
      },
    ]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe(
      '1;Интернет;2026-12-12;ежемесячно;9:00;активен;2026-11-01 10:00:00;2026-11-12 10:00:00;"Договор 15; платит Сеня"',
    );
    expect(lines[2]).toContain(";разово;как в настройках;архив;");
  });
  it("журнал: кто, действие, старая и новая дата", () => {
    const csv = logCsv([
      {
        id: 5,
        payment_id: 1,
        name: "Интернет",
        user_name: "Сеня",
        user_id: 42,
        action: "paid",
        old_date: "2026-11-12",
        new_date: "2026-12-12",
        undone: 0,
        created_at: "2026-11-12 09:30:00",
      },
      {
        id: 6,
        payment_id: 1,
        name: "Интернет",
        user_name: "Сеня",
        user_id: 42,
        action: "paid",
        old_date: "2026-12-12",
        new_date: "2027-01-12",
        undone: 1,
        created_at: "2026-11-12 09:31:00",
      },
    ]);
    const lines = csv.trim().split("\r\n");
    expect(lines[1]).toBe("5;1;Интернет;Сеня;42;оплата;2026-11-12;2026-12-12;2026-11-12 09:30:00");
    expect(lines[2]).toContain(";оплата (отменена);");
  });
});
