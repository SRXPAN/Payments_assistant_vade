import { describe, expect, it } from "vitest";
import { parseBulk, parsePeriodWord } from "../src/bulk";

const TODAY = "2026-11-13";

describe("массовое добавление", () => {
  it("разбирает строки «Название; дата; период»", () => {
    const result = parseBulk(
      ["Интернет; 25.11; ежемесячно", "Аренда;01.12.2026", "Домен site.com.ua ; 14.03.2027 ; ежегодно", "", "Ремонт | 20.11 | разово"].join("\n"),
      TODAY,
    );
    expect(result.errors).toEqual([]);
    expect(result.items).toEqual([
      { name: "Интернет", date: "2026-11-25", period: "monthly" },
      { name: "Аренда", date: "2026-12-01", period: "monthly" },
      { name: "Домен site.com.ua", date: "2027-03-14", period: "yearly" },
      { name: "Ремонт", date: "2026-11-20", period: "once" },
    ]);
  });
  it("хорошие строки добавляются, плохие возвращаются с причиной", () => {
    const result = parseBulk(
      ["Интернет; 25.11", "Без даты", "Хостинг; 32.13.2026", "Налог; 20.12; иногда", "Зарплата; 10.12; дважды в месяц", "интернет; 26.11"].join("\n"),
      TODAY,
    );
    expect(result.items.map((i) => i.name)).toEqual(["Интернет"]);
    expect(result.errors.map((e) => e.line)).toEqual([
      "Без даты",
      "Хостинг; 32.13.2026",
      "Налог; 20.12; иногда",
      "Зарплата; 10.12; дважды в месяц",
      "интернет; 26.11",
    ]);
    expect(result.errors[0]!.reason).toContain("Название; дата");
    expect(result.errors[1]!.reason).toContain("не понял дату");
    expect(result.errors[2]!.reason).toContain("не понял период");
    expect(result.errors[3]!.reason).toContain("в карточке");
    expect(result.errors[4]!.reason).toContain("уже есть"); // повтор внутри самого списка
  });
  it("не дублирует уже существующие платежи", () => {
    const result = parseBulk("Аренда; 01.12", TODAY, ["аренда"]);
    expect(result.items).toEqual([]);
    expect(result.errors[0]!.reason).toContain("уже есть");
  });
  it("слишком длинное название и больше 50 строк", () => {
    expect(parseBulk(`${"я".repeat(65)}; 01.12`, TODAY).errors[0]!.reason).toContain("длиннее 64");
    const many = Array.from({ length: 52 }, (_, i) => `Платёж ${i}; 01.12`).join("\n");
    const result = parseBulk(many, TODAY);
    expect(result.items).toHaveLength(50);
    expect(result.errors).toHaveLength(2);
  });
  it("период словами — по-русски и по-украински", () => {
    expect(parsePeriodWord("")).toBe("monthly");
    expect(parsePeriodWord("Ежемесячно")).toBe("monthly");
    expect(parsePeriodWord("щомісяця")).toBe("monthly");
    expect(parsePeriodWord("раз в квартал")).toBe("quarterly");
    expect(parsePeriodWord("ежегодно")).toBe("yearly");
    expect(parsePeriodWord("раз на рік")).toBe("yearly");
    expect(parsePeriodWord("каждые 2 недели")).toBe("biweekly");
    expect(parsePeriodWord("кожні 2 тижні")).toBe("biweekly");
    expect(parsePeriodWord("разово")).toBe("once");
    expect(parsePeriodWord("когда-нибудь")).toBeNull();
  });
});
