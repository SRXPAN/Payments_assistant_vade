import { describe, expect, it } from "vitest";
import { addPeriod } from "../src/dates";
import {
  overdueDigest,
  planReminders,
  type PlanOptions,
  type ReminderInput,
  reminderText,
  sentKey,
} from "../src/reminders";

// Ноябрь 2026: 11.11 ср (праздник), 12.11 чт, 13.11 пт, 14.11 сб, 15.11 вс, 16.11 пн.
const N = 4;
const text = (due: string, today: string) => reminderText("Аренда", due, today, N);

function pay(id: number, due: string, extra: Partial<ReminderInput> = {}): ReminderInput {
  return { id, name: `Платёж ${id}`, due_date: due, remind_hour: null, ...extra };
}

function opts(extra: Partial<PlanOptions> = {}): PlanOptions {
  return { today: "2026-11-13", hour: 12, defaultHour: 12, warnDays: N, sent: new Set(), ...extra };
}

describe("текст напоминания", () => {
  it("раньше чем за N дней — тишина", () => {
    expect(text("2026-11-25", "2026-11-20")).toBeNull();
  });
  it("за N, 3 и 2 дня", () => {
    expect(text("2026-11-24", "2026-11-20")).toBe("🟡 Через 4 дн. оплата: Аренда — до 24.11.2026");
    expect(text("2026-11-24", "2026-11-21")).toBe("🟡 Через 3 дн. оплата: Аренда — до 24.11.2026");
    expect(text("2026-11-24", "2026-11-22")).toBe("🟡 Через 2 дн. оплата: Аренда — до 24.11.2026");
  });
  it("за 1 день", () => {
    expect(text("2026-11-24", "2026-11-23")).toBe("🟡 Завтра последний день оплаты: Аренда — до 24.11.2026");
  });
  it("в день срока", () => {
    expect(text("2026-11-24", "2026-11-24")).toBe("🟠 Сегодня последний день оплаты: Аренда — до 24.11.2026");
  });
  it("просрочка 1 день", () => {
    expect(text("2026-11-24", "2026-11-25")).toBe("🔴 Просрочено на 1 дн.: Аренда — до 24.11.2026");
  });
  it("просрочка 4 дня — последнее напоминание, 5 и 10 дней — тишина", () => {
    expect(text("2026-11-24", "2026-11-28")).toBe("🔴 Просрочено на 4 дн.: Аренда — до 24.11.2026");
    expect(text("2026-11-24", "2026-11-29")).toBeNull();
    expect(text("2026-11-24", "2026-12-04")).toBeNull();
  });
});

describe("срок на выходных считается от пятницы", () => {
  it("срок в субботу: в пятницу — «оплатите сегодня»", () => {
    expect(text("2026-11-14", "2026-11-13")).toBe(
      "⚠️ Срок 14.11 (сб) выпадает на выходные — оплатите сегодня: Аренда",
    );
  });
  it("срок в воскресенье: в пятницу — «оплатите сегодня»", () => {
    expect(text("2026-11-15", "2026-11-13")).toBe(
      "⚠️ Срок 15.11 (вс) выпадает на выходные — оплатите сегодня: Аренда",
    );
  });
  it("срок в воскресенье: в четверг — «завтра», в субботу — уже просрочено", () => {
    expect(text("2026-11-15", "2026-11-12")).toBe(
      "🟡 Завтра последний день оплаты: Аренда — до 15.11.2026 ⚠️ вых. — оплатить до пт 13.11",
    );
    expect(text("2026-11-15", "2026-11-14")).toBe(
      "🔴 Просрочено на 1 дн.: Аренда — до 15.11.2026 ⚠️ вых. — оплатить до пт 13.11",
    );
  });
  it("срок в воскресенье: отсчёт N дней тоже от пятницы", () => {
    expect(text("2026-11-15", "2026-11-08")).toBeNull(); // до пятницы 5 дней
    expect(text("2026-11-15", "2026-11-09")).toContain("Через 4 дн.");
  });
  it("срок на польский праздник: накануне — «оплатите сегодня»", () => {
    expect(text("2026-11-11", "2026-11-10")).toBe(
      "⚠️ Срок 11.11 (ср) выпадает на праздник — оплатите сегодня: Аренда",
    );
  });
});

describe("еженедельная сводка давно просроченных", () => {
  it("берёт только платежи, по которым ежедневные напоминания уже молчат", () => {
    const digest = overdueDigest(
      [
        pay(1, "2026-10-01"), // просрочен на 43 дня
        pay(2, "2026-11-10"), // просрочен на 3 дня — ещё идут ежедневные напоминания
        pay(3, "2026-11-20"), // не просрочен
        pay(4, "2026-09-01", { deleted: true }),
      ],
      "2026-11-13",
    );
    expect(digest).toEqual([
      "🔴 Давно просрочено (1):",
      "• Платёж 1 — до 01.10.2026, просрочено на 43 дн.",
      "",
      "Отметьте оплату или удалите платёж: ✏️ Изменить в личном чате с ботом.",
    ]);
  });
  it("нет давно просроченных — сводки нет", () => {
    expect(overdueDigest([pay(2, "2026-11-10"), pay(3, "2026-11-20")], "2026-11-13")).toBeNull();
  });
});

describe("план рассылки", () => {
  it("берёт только платежи, по которым сегодня есть что сказать", () => {
    const plan = planReminders([pay(1, "2026-11-13"), pay(2, "2026-11-30"), pay(3, "2026-11-12")], opts());
    expect(plan.map((r) => r.payment.id)).toEqual([1, 3]);
  });
  it("повторный запуск в тот же день ничего не дублирует", () => {
    const payments = [pay(1, "2026-11-13"), pay(2, "2026-11-12")];
    const sent = new Set<string>();
    const first = planReminders(payments, opts({ sent }));
    expect(first).toHaveLength(2);
    for (const r of first) sent.add(sentKey(r.payment.id, r.payment.due_date));
    expect(planReminders(payments, opts({ sent, hour: 13 }))).toEqual([]);
  });
  it("до заданного часа молчит, после — догоняет пропущенное", () => {
    const payments = [pay(1, "2026-11-13")];
    expect(planReminders(payments, opts({ hour: 11 }))).toEqual([]);
    expect(planReminders(payments, opts({ hour: 12 }))).toHaveLength(1);
    expect(planReminders(payments, opts({ hour: 17 }))).toHaveLength(1); // бот был выключен в 12:00
  });
  it("у платежа свой час напоминания", () => {
    const payments = [pay(1, "2026-11-13", { remind_hour: 9 }), pay(2, "2026-11-13")];
    expect(planReminders(payments, opts({ hour: 9 })).map((r) => r.payment.id)).toEqual([1]);
    expect(planReminders(payments, opts({ hour: 12 })).map((r) => r.payment.id)).toEqual([1, 2]);
  });
  it("платёж «разово» после оплаты не напоминает", () => {
    const once = pay(1, "2026-11-13");
    expect(planReminders([once], opts())).toHaveLength(1);
    // «Оплатил» по разовому платежу: следующего срока нет, платёж уходит в архив.
    expect(addPeriod(once.due_date, "once")).toBeNull();
    expect(planReminders([{ ...once, archived: true }], opts())).toEqual([]);
  });
  it("удалённый платёж не напоминает", () => {
    expect(planReminders([pay(1, "2026-11-13", { deleted: true })], opts())).toEqual([]);
  });
  it("после оплаты срок сдвинулся — в тот же день новое напоминание не нужно", () => {
    const sent = new Set([sentKey(1, "2026-11-13")]);
    expect(planReminders([pay(1, "2026-12-13")], opts({ sent }))).toEqual([]);
  });
  it("«Проверить сейчас» не смотрит на час и на уже отправленные", () => {
    const sent = new Set([sentKey(1, "2026-11-13")]);
    expect(planReminders([pay(1, "2026-11-13")], opts({ sent, hour: 3, force: true }))).toHaveLength(1);
  });
});
