import { describe, expect, it } from "vitest";
import type { HistoryItem, Person } from "../src/db";
import {
  canUndo,
  cardView,
  categoriesView,
  chunkLines,
  dayKeyboard,
  editListView,
  filterByCategory,
  listKeyboard,
  listMessages,
  paramsView,
  responsibleKeyboard,
  searchPayments,
  truncate,
} from "../src/views";
import { payment } from "./helpers";

const TODAY = "2026-11-12"; // четверг
const TZ = "Europe/Warsaw";
const card = (p: ReturnType<typeof payment>, history: HistoryItem[] = [], extra = {}) =>
  cardView(p, { last: null, history, timeZone: TZ, ...extra });

/** Плоский список кнопок: [текст, callback_data]. */
function buttons(source: { keyboard: { inline_keyboard: unknown[][] } } | { inline_keyboard: unknown[][] }): [string, string][] {
  const rows = "keyboard" in source ? source.keyboard.inline_keyboard : source.inline_keyboard;
  return rows.flat().map((b) => {
    const btn = b as { text: string; callback_data: string };
    return [btn.text, btn.callback_data];
  });
}
const labels = (source: Parameters<typeof buttons>[0]) => buttons(source).map(([text]) => text);

describe("список", () => {
  it("заголовок с количеством и строки со статусами", () => {
    const messages = listMessages(
      [
        payment({ id: 1, name: "site.com.ua", due_date: "2026-11-10" }),
        payment({ id: 2, name: "Интернет", due_date: "2026-11-20" }),
      ],
      TODAY,
      4,
    );
    expect(messages).toEqual([
      "📋 Платежи (2):\n• site.com.ua — 10.11.2026 🔴 просрочено на 2 дн.\n• Интернет — 20.11.2026 🟢 через 8 дн.",
    ]);
  });
  it("пустой список", () => {
    expect(listMessages([], TODAY, 4)).toEqual(["📋 Платежей пока нет."]);
  });
  it("длинный список режется на сообщения не длиннее 4096 символов", () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      payment({ id: i, name: `Платёж номер ${i} ${"я".repeat(40)}`, due_date: "2026-12-01" }),
    );
    const messages = listMessages(many, TODAY, 4);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(m.length).toBeLessThanOrEqual(4096);
    expect(messages.join("\n").split("\n")).toHaveLength(151);
  });
  it("chunkLines не теряет строки", () => {
    expect(chunkLines(["aaa", "bbb", "ccc"], 7)).toEqual(["aaa\nbbb", "ccc"]);
  });
  it("свой запас дней платежа меняет цвет статуса", () => {
    // До срока 8 дней: при общих 4 днях — зелёный, при своих 10 — жёлтый.
    const [text] = listMessages([payment({ id: 1, name: "Аренда", due_date: "2026-11-20", warn_days: 10 })], TODAY, 4);
    expect(text).toContain("🟡 через 8 дн.");
  });
  it("автосписание: срок в выходной не переносится, в строке пометка", () => {
    // 15.11.2026 — воскресенье.
    const [text] = listMessages([payment({ id: 1, name: "Хостинг", due_date: "2026-11-15", autopay: 1 })], TODAY, 4);
    expect(text).toBe("📋 Платежи (1):\n• Хостинг — 15.11.2026 🟡 через 3 дн. 💳 авто");
  });
});

describe("категории и поиск", () => {
  const all = [
    payment({ id: 1, name: "Netflix", due_date: "2026-11-20", category: "Подписки" }),
    payment({ id: 2, name: "Аренда зала", due_date: "2026-11-25", category: "Аренда", note: "Договор 15" }),
    payment({ id: 3, name: "Интернет", due_date: "2026-11-30" }),
  ];
  it("кнопка «По категориям» есть, только если категории заданы", () => {
    expect(listKeyboard(all)).toBeDefined();
    expect(listKeyboard([all[2]!])).toBeUndefined();
  });
  it("в выборе — только непустые категории и счётчики", () => {
    expect(buttons(categoriesView(all))).toEqual([
      ["Подписки (1)", "l:cat:0"],
      ["Аренда (1)", "l:cat:2"],
      ["Без категории (1)", "l:cat:n"],
      ["Все платежи (3)", "l:all"],
    ]);
  });
  it("фильтр по категории", () => {
    expect(filterByCategory(all, "2")).toEqual({ title: "📋 Аренда", items: [all[1]] });
    expect(filterByCategory(all, "n")?.items).toEqual([all[2]]);
    expect(filterByCategory(all, "99")).toBeNull();
  });
  it("поиск по названию, заметке и категории без учёта регистра", () => {
    expect(searchPayments(all, "ИНТЕР").map((p) => p.id)).toEqual([3]);
    expect(searchPayments(all, "NETF").map((p) => p.id)).toEqual([1]);
    expect(searchPayments(all, "договор").map((p) => p.id)).toEqual([2]);
    expect(searchPayments(all, "подписки").map((p) => p.id)).toEqual([1]);
    expect(searchPayments(all, "  ")).toEqual([]);
  });
});

describe("кнопки", () => {
  it("длинное название обрезается с «…»", () => {
    expect(truncate("Короткое")).toBe("Короткое");
    const cut = truncate("Очень длинное название платежа за аренду помещения");
    expect([...cut]).toHaveLength(28);
    expect(cut.endsWith("…")).toBe(true);
  });
  it("в списке «Изменить» у каждой строки статус, название и корзина", () => {
    const view = editListView(
      [payment({ id: 7, name: "Аренда", due_date: "2026-11-15" }), payment({ id: 8, name: "Интернет", due_date: "2026-11-20" })],
      TODAY,
      4,
    );
    expect(buttons(view)).toEqual([
      ["🟡 Аренда", "p:open:7"],
      ["🗑", "p:del:7:l"],
      ["🟢 Интернет", "p:open:8"],
      ["🗑", "p:del:8:l"],
    ]);
  });
  it("больше 40 платежей — постраничный список", () => {
    const many = Array.from({ length: 45 }, (_, i) => payment({ id: i, name: `П${i}`, due_date: "2026-12-01" }));
    const first = buttons(editListView(many, TODAY, 4, 0));
    expect(first).toHaveLength(81);
    expect(first.at(-1)).toEqual(["Дальше ›", "e:list:1"]);
    expect(buttons(editListView(many, TODAY, 4, 1))).toHaveLength(11);
  });
  it("числа месяца: 30 кнопок без уже занятого числа, callback_data в лимите", () => {
    const days = buttons(dayKeyboard("p:setday:123456789:", "p:params:123456789", 10));
    expect(days).toHaveLength(31); // 30 чисел + «Отмена»
    expect(days.map(([text]) => text)).not.toContain("10");
    for (const [, data] of days) expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
  });
});

describe("карточка", () => {
  it("текст и кнопка оплаты со следующей датой", () => {
    const view = cardView(payment({ id: 3, name: "Интернет", due_date: "2026-11-12" }), {
      last: { user_name: "Сеня", created_at: "2026-10-12 09:30:00" },
      history: [],
      timeZone: TZ,
    });
    expect(view.text).toBe(
      "Интернет — оплата до 12.11.2026 (ежемесячно)\nПоследняя оплата: 12.10.2026, отметил Сеня\nЧто сделать?",
    );
    expect(buttons(view)[0]).toEqual(["✅ Оплатил → до 12.12.2026", "p:pay:3:2026-11-12"]);
    expect(labels(view)).toEqual([
      "✅ Оплатил → до 12.12.2026",
      "📅 +1 месяц",
      "📅 +1 квартал",
      "📅 +1 год",
      "✏️ Изменить дату",
      "🔤 Переименовать",
      "📝 Заметка",
      "⚙️ Параметры",
      "🗑 Удалить",
      "↩️ Отмена",
    ]);
  });
  it("заметка, параметры и история видны в карточке", () => {
    const view = card(
      payment({
        id: 3,
        name: "Интернет",
        due_date: "2026-12-12",
        note: "Договор 15",
        warn_days: 7,
        autopay: 1,
        category: "Подписки",
        responsible_id: 5,
      }),
      [
        { user_name: "Сеня", action: "paid", old_date: "2026-11-12", new_date: "2026-12-12", undone: 0, created_at: "2026-11-12 09:30:00" },
        { user_name: "Оля", action: "edit_date", old_date: "2026-11-10", new_date: "2026-11-12", undone: 0, created_at: "2026-11-01 08:00:00" },
      ],
      { responsible: "Сеня" },
    );
    for (const line of [
      "📝 Договор 15",
      "🔔 Предупреждать за 7 дн.",
      "💳 Автосписание",
      "🏷 Подписки",
      "👤 Ответственный: Сеня",
      "• 12.11.2026 Сеня: оплата, срок 12.11.2026 → 12.12.2026",
      "• 01.11.2026 Оля: срок изменён 10.11.2026 → 12.11.2026",
    ]) {
      expect(view.text).toContain(line);
    }
  });
  it("«Отменить оплату» есть, только пока после оплаты платёж не меняли", () => {
    const p = payment({ id: 3, name: "Интернет", due_date: "2026-12-12" });
    const paid: HistoryItem = { user_name: "Сеня", action: "paid", old_date: "2026-11-12", new_date: "2026-12-12", undone: 0, created_at: "2026-11-12 09:30:00" };

    expect(buttons(card(p, [paid]))[1]).toEqual(["↩️ Отменить оплату", "p:undo:3"]);
    expect(labels(card(p, []))).not.toContain("↩️ Отменить оплату");
    expect(labels(card(p, [{ ...paid, undone: 1 }]))).not.toContain("↩️ Отменить оплату"); // уже отменена
    expect(labels(card({ ...p, due_date: "2026-12-20" }, [paid]))).not.toContain("↩️ Отменить оплату"); // срок меняли
    expect(labels(card(p, [{ ...paid, action: "edit_date" }]))).not.toContain("↩️ Отменить оплату");
    expect(canUndo(p, [paid])).toBe(true);
  });
  it("разовый платёж уходит в архив", () => {
    const view = card(payment({ id: 4, name: "Ремонт", due_date: "2026-11-20", period: "once" }));
    expect(buttons(view)[0]![0]).toBe("✅ Оплатил → в архив");
    expect(view.text).toContain("Последняя оплата: ещё не отмечали");
  });
  it("дважды в месяц: в карточке числа, кнопка оплаты ведёт к следующему числу", () => {
    const view = card(payment({ id: 5, name: "Зарплата", due_date: "2026-11-10", period: "semimonthly", month_days: "10,25" }));
    expect(view.text).toContain("(дважды в месяц (10 и 25 числа))");
    expect(buttons(view)[0]![0]).toBe("✅ Оплатил → до 25.11.2026");
  });
  it("callback_data укладывается в лимит Telegram 64 байта", () => {
    const view = card(payment({ id: 123456789, name: "X", due_date: "2026-11-12" }));
    for (const [, data] of buttons(view)) expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
  });
});

describe("параметры платежа", () => {
  it("значения по умолчанию берутся из настроек", () => {
    const view = paramsView(payment({ id: 9, name: "Интернет", due_date: "2026-11-20" }), { warnDays: 4, hour: 12 });
    expect(view.text).toBe(
      [
        "Интернет — параметры",
        "🔁 Период: ежемесячно",
        "⏰ Напоминать в: 12:00 (как в настройках)",
        "🔔 Предупреждать за: 4 дн. (как в настройках)",
        "👤 Ответственный: не назначен",
        "💳 Автосписание: выключено",
        "🏷 Категория: нет",
      ].join("\n"),
    );
    expect(buttons(view)).toEqual([
      ["🔁 Период", "p:per:9"],
      ["⏰ Время", "p:hour:9"],
      ["🔔 За сколько дней", "p:warn:9"],
      ["👤 Ответственный", "p:resp:9"],
      ["💳 Автосписание: выкл", "p:auto:9"],
      ["🏷 Категория", "p:cat:9"],
      ["↩️ Назад", "p:open:9"],
    ]);
  });
  it("свои значения платежа", () => {
    const view = paramsView(
      payment({ id: 9, name: "Аренда", due_date: "2026-11-20", warn_days: 10, remind_hour: 9, autopay: 1, category: "Аренда" }),
      { warnDays: 4, hour: 12, responsible: "Оля" },
    );
    expect(view.text).toContain("⏰ Напоминать в: 9:00");
    expect(view.text).toContain("🔔 Предупреждать за: 10 дн.");
    expect(view.text).toContain("👤 Ответственный: Оля");
    expect(view.text).toContain("💳 Автосписание: включено");
    expect(labels(view)).toContain("💳 Автосписание: вкл");
  });
  it("выбор ответственного: текущий отмечен, есть «Никто»", () => {
    const people = new Map<number, Person>([
      [1000, { name: "Влад", username: "vlad" }],
      [5, { name: "Сеня", username: null }],
    ]);
    const kb = responsibleKeyboard(payment({ id: 9, name: "X", due_date: "2026-11-20", responsible_id: 5 }), people);
    expect(buttons(kb)).toEqual([
      ["Влад", "p:setresp:9:1000"],
      ["✅ Сеня", "p:setresp:9:5"],
      ["Никто", "p:setresp:9:0"],
      ["↩️ Назад", "p:params:9"],
    ]);
  });
});
