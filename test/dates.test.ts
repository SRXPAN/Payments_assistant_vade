import { describe, expect, it } from "vitest";
import {
  addMonths,
  addPeriod,
  daysLabel,
  effectiveDeadline,
  isHoliday,
  listLine,
  localNow,
  parseDateInput,
  paymentStatus,
  shiftNote,
} from "../src/dates";

// 12.11.2026 — четверг, 13.11 — пятница, 14.11 — суббота, 15.11 — воскресенье.
const TODAY = "2026-11-12";

describe("сдвиг на период", () => {
  it("31.01 + 1 мес = 28.02 (обычный год)", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
  });
  it("31.01 + 1 мес = 29.02 (високосный год)", () => {
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  });
  it("29.02 + 1 год = 28.02", () => {
    expect(addPeriod("2028-02-29", "yearly")).toBe("2029-02-28");
  });
  it("переход через Новый год", () => {
    expect(addPeriod("2026-12-15", "monthly")).toBe("2027-01-15");
    expect(addPeriod("2026-11-30", "quarterly")).toBe("2027-02-28");
    expect(addPeriod("2026-12-25", "biweekly")).toBe("2027-01-08");
  });
  it("разово — следующего срока нет", () => {
    expect(addPeriod("2026-11-20", "once")).toBeNull();
  });
});

describe("срок на нерабочий день", () => {
  it("суббота → пятница", () => {
    expect(effectiveDeadline("2026-11-14")).toEqual({ date: "2026-11-13", reason: "weekend" });
  });
  it("воскресенье → пятница", () => {
    expect(effectiveDeadline("2026-11-15")).toEqual({ date: "2026-11-13", reason: "weekend" });
  });
  it("рабочий день не сдвигается", () => {
    expect(effectiveDeadline("2026-11-20")).toEqual({ date: "2026-11-20", reason: null });
  });
  it("польский праздник в будний день → предыдущий рабочий день", () => {
    // 11.11.2026 — среда, День независимости.
    expect(effectiveDeadline("2026-11-11")).toEqual({ date: "2026-11-10", reason: "holiday" });
  });
  it("Пасхальный понедельник → пятница перед Пасхой", () => {
    expect(isHoliday("2026-04-05")).toBe(true); // Пасха
    expect(isHoliday("2026-06-04")).toBe(true); // Праздник Тела Господня
    expect(effectiveDeadline("2026-04-06")).toEqual({ date: "2026-04-03", reason: "holiday" });
  });
  it("суббота после праздника → последний рабочий день прошлого года", () => {
    // 02.01.2027 — суббота, 01.01 — праздник (пятница) → четверг 31.12.2026.
    expect(effectiveDeadline("2027-01-02")).toEqual({ date: "2026-12-31", reason: "weekend" });
  });
  it("в субботу платёж со сроком в субботу уже просрочен на 1 день", () => {
    const st = paymentStatus("2026-11-14", "2026-11-14", 4);
    expect(st.days).toBe(-1);
    expect(st.color).toBe("red");
  });
});

describe("статус", () => {
  it("сегодня", () => {
    const st = paymentStatus(TODAY, TODAY, 4);
    expect([st.days, st.color, daysLabel(st.days)]).toEqual([0, "yellow", "сегодня"]);
  });
  it("завтра", () => {
    const st = paymentStatus("2026-11-13", TODAY, 4);
    expect([st.days, st.color, daysLabel(st.days)]).toEqual([1, "yellow", "завтра"]);
  });
  it("вчера — просрочено на 1 дн.", () => {
    // 11.11 — праздник, поэтому «вчера» проверяем от пятницы 13.11.
    const st = paymentStatus("2026-11-12", "2026-11-13", 4);
    expect([st.days, st.color, daysLabel(st.days)]).toEqual([-1, "red", "просрочено на 1 дн."]);
  });
  it("граница зелёный/жёлтый по N", () => {
    expect(paymentStatus("2026-11-16", TODAY, 4).color).toBe("yellow"); // 4 дня
    expect(paymentStatus("2026-11-17", TODAY, 4).color).toBe("green"); // 5 дней
  });
  it("переход через Новый год", () => {
    const st = paymentStatus("2027-01-04", "2026-12-28", 4);
    expect([st.days, st.color]).toEqual([7, "green"]);
  });
  it("строка списка", () => {
    expect(listLine("Интернет", "2026-11-20", TODAY, 4)).toBe("• Интернет — 20.11.2026 🟢 через 8 дн.");
    expect(listLine("Аренда", "2026-11-15", TODAY, 4)).toBe(
      "• Аренда — 15.11.2026 🟡 завтра ⚠️ вых. — оплатить до пт 13.11",
    );
  });
  it("пометка для праздника", () => {
    expect(shiftNote(paymentStatus("2026-11-11", "2026-11-02", 4))).toBe("⚠️ праздник — оплатить до вт 10.11");
  });
});

describe("ввод даты", () => {
  const ok = (text: string, today = TODAY) => {
    const r = parseDateInput(text, today);
    return r.ok ? r.date : `ошибка: ${r.error}`;
  };

  it("все поддерживаемые форматы", () => {
    expect(ok("25.11.2026")).toBe("2026-11-25");
    expect(ok("25.11.26")).toBe("2026-11-25");
    expect(ok("25/11/2026")).toBe("2026-11-25");
    expect(ok("25-11-2026")).toBe("2026-11-25");
    expect(ok(" 5.1.2027 ")).toBe("2027-01-05");
  });
  it("«25.11» без года — ближайший будущий год", () => {
    expect(ok("25.11")).toBe("2026-11-25");
    expect(ok("12.11")).toBe("2026-11-12"); // сегодня — этот год
    expect(ok("11.11")).toBe("2027-11-11"); // уже прошло
  });
  it("«25.11» в декабре — следующий год", () => {
    expect(ok("25.11", "2026-12-10")).toBe("2027-11-25");
  });
  it("«29.02» без года — ближайший високосный", () => {
    expect(ok("29.02")).toBe("2028-02-29");
  });
  it("неверные даты", () => {
    for (const text of ["32.13.2026", "абв", "", "30.02.2026", "29.02.2027", "25.11.2026 г", "25..11"]) {
      const r = parseDateInput(text, TODAY);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.error).toContain("25.11.2026");
    }
  });
});

describe("часовой пояс", () => {
  it("Europe/Warsaw зимой (UTC+1) и летом (UTC+2)", () => {
    expect(localNow(new Date("2026-11-12T11:30:00Z"), "Europe/Warsaw")).toEqual({ date: "2026-11-12", hour: 12 });
    expect(localNow(new Date("2026-07-01T10:30:00Z"), "Europe/Warsaw")).toEqual({ date: "2026-07-01", hour: 12 });
  });
  it("ночью по UTC в Варшаве уже следующий день", () => {
    expect(localNow(new Date("2026-12-31T23:30:00Z"), "Europe/Warsaw")).toEqual({ date: "2027-01-01", hour: 0 });
  });
});
