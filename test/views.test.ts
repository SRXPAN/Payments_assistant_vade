import { describe, expect, it } from "vitest";
import type { Payment } from "../src/db";
import { canUndo, cardView, chunkLines, editListView, listMessages, truncate } from "../src/views";

const TODAY = "2026-11-12"; // четверг

function payment(id: number, name: string, due: string, period: Payment["period"] = "monthly"): Payment {
  return { id, name, due_date: due, period, remind_hour: null, note: null };
}

/** Плоский список кнопок клавиатуры: [текст, callback_data]. */
function buttons(view: { keyboard: { inline_keyboard: unknown[][] } }): [string, string][] {
  return view.keyboard.inline_keyboard.flat().map((b) => {
    const btn = b as { text: string; callback_data: string };
    return [btn.text, btn.callback_data];
  });
}

describe("список", () => {
  it("заголовок с количеством и строки со статусами", () => {
    const messages = listMessages(
      [payment(1, "site.com.ua", "2026-11-10"), payment(2, "Интернет", "2026-11-20")],
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
    const many = Array.from({ length: 150 }, (_, i) => payment(i, `Платёж номер ${i} ${"я".repeat(40)}`, "2026-12-01"));
    const messages = listMessages(many, TODAY, 4);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(m.length).toBeLessThanOrEqual(4096);
    expect(messages.join("\n").split("\n")).toHaveLength(151);
  });
  it("chunkLines не теряет строки", () => {
    expect(chunkLines(["aaa", "bbb", "ccc"], 7)).toEqual(["aaa\nbbb", "ccc"]);
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
    const view = editListView([payment(7, "Аренда", "2026-11-15"), payment(8, "Интернет", "2026-11-20")], TODAY, 4);
    expect(buttons(view)).toEqual([
      ["🟡 Аренда", "p:open:7"],
      ["🗑", "p:del:7:l"],
      ["🟢 Интернет", "p:open:8"],
      ["🗑", "p:del:8:l"],
    ]);
  });
  it("больше 40 платежей — постраничный список", () => {
    const many = Array.from({ length: 45 }, (_, i) => payment(i, `П${i}`, "2026-12-01"));
    const first = buttons(editListView(many, TODAY, 4, 0));
    expect(first).toHaveLength(81);
    expect(first.at(-1)).toEqual(["Дальше ›", "e:list:1"]);
    expect(buttons(editListView(many, TODAY, 4, 1))).toHaveLength(11);
  });
});

describe("карточка", () => {
  it("текст и кнопка оплаты со следующей датой", () => {
    const view = cardView(
      payment(3, "Интернет", "2026-11-12"),
      { user_name: "Сеня", created_at: "2026-10-12 09:30:00" },
      [],
      "Europe/Warsaw",
    );
    expect(view.text).toBe(
      "Интернет — оплата до 12.11.2026 (ежемесячно)\nПоследняя оплата: 12.10.2026, отметил Сеня\nЧто сделать?",
    );
    expect(buttons(view)[0]).toEqual(["✅ Оплатил → до 12.12.2026", "p:pay:3:2026-11-12"]);
    expect(buttons(view).map(([text]) => text)).toEqual([
      "✅ Оплатил → до 12.12.2026",
      "📅 +1 месяц",
      "📅 +1 квартал",
      "📅 +1 год",
      "✏️ Изменить дату",
      "🔤 Переименовать",
      "🔁 Период",
      "⏰ Время",
      "📝 Заметка",
      "🗑 Удалить",
      "↩️ Отмена",
    ]);
  });
  it("заметка и история видны в карточке", () => {
    const view = cardView(
      { ...payment(3, "Интернет", "2026-12-12"), note: "Договор 15, платит Сеня" },
      { user_name: "Сеня", created_at: "2026-11-12 09:30:00" },
      [
        { user_name: "Сеня", action: "paid", old_date: "2026-11-12", new_date: "2026-12-12", undone: 0, created_at: "2026-11-12 09:30:00" },
        { user_name: "Оля", action: "edit_date", old_date: "2026-11-10", new_date: "2026-11-12", undone: 0, created_at: "2026-11-01 08:00:00" },
      ],
      "Europe/Warsaw",
    );
    expect(view.text).toContain("📝 Договор 15, платит Сеня");
    expect(view.text).toContain("• 12.11.2026 Сеня: оплата, срок 12.11.2026 → 12.12.2026");
    expect(view.text).toContain("• 01.11.2026 Оля: срок изменён 10.11.2026 → 12.11.2026");
  });
  it("«Отменить оплату» есть, только пока после оплаты платёж не меняли", () => {
    const p = payment(3, "Интернет", "2026-12-12");
    const paid = { user_name: "Сеня", action: "paid" as const, old_date: "2026-11-12", new_date: "2026-12-12", undone: 0, created_at: "2026-11-12 09:30:00" };
    const labels = (history: Parameters<typeof cardView>[2], pay = p) =>
      buttons(cardView(pay, null, history, "Europe/Warsaw")).map(([text]) => text);

    expect(labels([paid])).toContain("↩️ Отменить оплату");
    expect(buttons(cardView(p, null, [paid], "Europe/Warsaw"))[1]).toEqual(["↩️ Отменить оплату", "p:undo:3"]);
    expect(labels([])).not.toContain("↩️ Отменить оплату");
    expect(labels([{ ...paid, undone: 1 }])).not.toContain("↩️ Отменить оплату"); // уже отменена
    expect(labels([paid], { ...p, due_date: "2026-12-20" })).not.toContain("↩️ Отменить оплату"); // срок потом меняли
    expect(labels([{ ...paid, action: "edit_date" }])).not.toContain("↩️ Отменить оплату");
    expect(canUndo(p, [paid])).toBe(true);
  });
  it("разовый платёж уходит в архив", () => {
    const view = cardView(payment(4, "Ремонт", "2026-11-20", "once"), null, [], "Europe/Warsaw");
    expect(buttons(view)[0]![0]).toBe("✅ Оплатил → в архив");
    expect(view.text).toContain("Последняя оплата: ещё не отмечали");
  });
  it("callback_data укладывается в лимит Telegram 64 байта", () => {
    const view = cardView(payment(123456789, "X", "2026-11-12"), null, [], "Europe/Warsaw");
    for (const [, data] of buttons(view)) expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
  });
});
