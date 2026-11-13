// Разбор списка платежей для массового добавления: «Название; дата; период» в каждой строке.
import { type ISODate, parseDateInput, type Period } from "./dates";

export const BULK_MAX_LINES = 50;
const NAME_MAX = 64;

export interface BulkItem {
  name: string;
  date: ISODate;
  period: Period;
}

export interface BulkResult {
  items: BulkItem[];
  errors: { line: string; reason: string }[];
}

/** Период словами (по-русски или по-украински). Пусто — ежемесячно; null — не понял. */
export function parsePeriodWord(word: string): Period | null {
  const w = word.trim().toLowerCase();
  if (!w) return "monthly";
  if (/кварт/.test(w)) return "quarterly";
  if (/год|рік|рок|річн/.test(w)) return "yearly";
  if (/2\s*(нед|тиж)|две\s+нед|два\s+тиж/.test(w)) return "biweekly";
  if (/разов|одноразов|один раз/.test(w)) return "once";
  if (/мес|міс/.test(w)) return "monthly";
  return null;
}

export function parseBulk(text: string, today: ISODate, existingNames: string[] = []): BulkResult {
  const taken = new Set(existingNames.map((n) => n.toLowerCase()));
  const result: BulkResult = { items: [], errors: [] };
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const [index, line] of lines.entries()) {
    const fail = (reason: string) => result.errors.push({ line, reason });
    if (index >= BULK_MAX_LINES) {
      fail(`больше ${BULK_MAX_LINES} строк за раз — пришлите остаток отдельным сообщением`);
      continue;
    }
    const cells = line.split(/[;|\t]/).map((c) => c.trim());
    const [name = "", dateText = "", periodText = ""] = cells;
    if (cells.length < 2 || !name || !dateText) {
      fail("нужно «Название; дата» через точку с запятой");
      continue;
    }
    if ([...name].length > NAME_MAX) {
      fail(`название длиннее ${NAME_MAX} символов`);
      continue;
    }
    if (taken.has(name.toLowerCase())) {
      fail("платёж с таким названием уже есть");
      continue;
    }
    const date = parseDateInput(dateText, today);
    if (!date.ok) {
      fail(`не понял дату «${dateText}»`);
      continue;
    }
    if (/дважд|двічі/i.test(periodText)) {
      fail("период «дважды в месяц» задаётся в карточке платежа: там выбираются числа");
      continue;
    }
    const period = parsePeriodWord(periodText);
    if (!period) {
      fail(`не понял период «${periodText}»`);
      continue;
    }
    taken.add(name.toLowerCase());
    result.items.push({ name, date: date.date, period });
  }
  return result;
}
