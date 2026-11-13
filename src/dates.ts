// Логика дат без Telegram и без библиотек. Даты — строки YYYY-MM-DD, арифметика в UTC.

export type ISODate = string;
export type Period = "monthly" | "quarterly" | "yearly" | "biweekly" | "once";
export type Color = "green" | "yellow" | "red";
export type ShiftReason = "weekend" | "holiday" | null;

const DAY_MS = 86_400_000;
const WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"] as const;

export const PERIOD_LABELS: Record<Period, string> = {
  monthly: "ежемесячно",
  quarterly: "раз в квартал",
  yearly: "ежегодно",
  biweekly: "каждые 2 недели",
  once: "разово",
};

export const COLOR_EMOJI: Record<Color, string> = { green: "🟢", yellow: "🟡", red: "🔴" };

const pad = (n: number) => String(n).padStart(2, "0");

export function fromYMD(y: number, m: number, d: number): ISODate {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function parts(iso: ISODate): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y!, m!, d!];
}

function toMs(iso: ISODate): number {
  const [y, m, d] = parts(iso);
  return Date.UTC(y, m - 1, d);
}

function fromMs(ms: number): ISODate {
  const dt = new Date(ms);
  return fromYMD(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function isValidYMD(y: number, m: number, d: number): boolean {
  return y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function addDays(iso: ISODate, n: number): ISODate {
  return fromMs(toMs(iso) + n * DAY_MS);
}

/** Сколько дней от `from` до `to` (отрицательное — `to` в прошлом). */
export function diffDays(from: ISODate, to: ISODate): number {
  return Math.round((toMs(to) - toMs(from)) / DAY_MS);
}

/** 0 = воскресенье … 6 = суббота. */
export function weekday(iso: ISODate): number {
  return new Date(toMs(iso)).getUTCDay();
}

/** Как relativedelta: 31.01 + 1 мес = 28/29.02. */
export function addMonths(iso: ISODate, n: number): ISODate {
  const [y, m, d] = parts(iso);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fromYMD(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** Следующий срок после оплаты; для «разово» — null (платёж уходит в архив). */
export function addPeriod(iso: ISODate, period: Period): ISODate | null {
  switch (period) {
    case "monthly":
      return addMonths(iso, 1);
    case "quarterly":
      return addMonths(iso, 3);
    case "yearly":
      return addMonths(iso, 12);
    case "biweekly":
      return addDays(iso, 14);
    case "once":
      return null;
  }
}

// ---------- Нерабочие дни (Польша) ----------

function easterSunday(year: number): ISODate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return fromYMD(year, month, day);
}

const FIXED_HOLIDAYS = ["01-01", "01-06", "05-01", "05-03", "08-15", "11-01", "11-11", "12-24", "12-25", "12-26"];
const holidayCache = new Map<number, Set<ISODate>>();

function holidaysOf(year: number): Set<ISODate> {
  let set = holidayCache.get(year);
  if (!set) {
    const easter = easterSunday(year);
    set = new Set(FIXED_HOLIDAYS.map((md) => `${year}-${md}`));
    // Пасха, Пасхальный понедельник, Пятидесятница, Праздник Тела Господня.
    for (const offset of [0, 1, 49, 60]) set.add(addDays(easter, offset));
    holidayCache.set(year, set);
  }
  return set;
}

export function isHoliday(iso: ISODate): boolean {
  return holidaysOf(parts(iso)[0]).has(iso);
}

export function isWeekend(iso: ISODate): boolean {
  const wd = weekday(iso);
  return wd === 0 || wd === 6;
}

export function isWorkingDay(iso: ISODate): boolean {
  return !isWeekend(iso) && !isHoliday(iso);
}

/** Последний рабочий день не позже срока — от него считаются статус и напоминания. */
export function effectiveDeadline(due: ISODate): { date: ISODate; reason: ShiftReason } {
  if (isWorkingDay(due)) return { date: due, reason: null };
  const reason: ShiftReason = isWeekend(due) ? "weekend" : "holiday";
  let date = due;
  while (!isWorkingDay(date)) date = addDays(date, -1);
  return { date, reason };
}

// ---------- Статус ----------

export interface PaymentStatus {
  /** Рабочий день, до которого реально нужно оплатить. */
  deadline: ISODate;
  reason: ShiftReason;
  /** Дней до deadline; отрицательное — просрочено. */
  days: number;
  color: Color;
}

export function paymentStatus(due: ISODate, today: ISODate, warnDays: number): PaymentStatus {
  const { date, reason } = effectiveDeadline(due);
  const days = diffDays(today, date);
  const color: Color = days < 0 ? "red" : days <= warnDays ? "yellow" : "green";
  return { deadline: date, reason, days, color };
}

export function daysLabel(days: number): string {
  if (days < 0) return `просрочено на ${-days} дн.`;
  if (days === 0) return "сегодня";
  if (days === 1) return "завтра";
  return `через ${days} дн.`;
}

// ---------- Форматирование ----------

export function formatDate(iso: ISODate): string {
  const [y, m, d] = parts(iso);
  return `${pad(d)}.${pad(m)}.${y}`;
}

export function formatShort(iso: ISODate): string {
  const [, m, d] = parts(iso);
  return `${pad(d)}.${pad(m)}`;
}

export function weekdayShort(iso: ISODate): string {
  return WEEKDAYS[weekday(iso)]!;
}

/** «⚠️ вых. — оплатить до пт 13.11» или пустая строка, если срок в рабочий день. */
export function shiftNote(status: PaymentStatus): string {
  if (!status.reason) return "";
  const why = status.reason === "weekend" ? "вых." : "праздник";
  return `⚠️ ${why} — оплатить до ${weekdayShort(status.deadline)} ${formatShort(status.deadline)}`;
}

/** Строка списка: «• Название — 20.11.2026 🟢 через 8 дн.» */
export function listLine(name: string, due: ISODate, today: ISODate, warnDays: number): string {
  const st = paymentStatus(due, today, warnDays);
  const note = shiftNote(st);
  return `• ${name} — ${formatDate(due)} ${COLOR_EMOJI[st.color]} ${daysLabel(st.days)}${note ? ` ${note}` : ""}`;
}

// ---------- Ввод даты ----------

export type ParseResult = { ok: true; date: ISODate } | { ok: false; error: string };

const DATE_HINT = "Введите дату в формате ДД.ММ.ГГГГ, например 25.11.2026.";

/** Принимает 25.11.2026, 25.11.26, 25.11 (ближайший будущий год), 25/11/2026, 25-11-2026. */
export function parseDateInput(text: string, today: ISODate): ParseResult {
  const match = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}|\d{2}))?$/.exec(text.trim());
  if (!match) return { ok: false, error: `Не понял дату. ${DATE_HINT}` };
  const d = Number(match[1]);
  const m = Number(match[2]);
  const bad: ParseResult = { ok: false, error: `Такой даты не существует. ${DATE_HINT}` };

  if (match[3] !== undefined) {
    const y = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
    return isValidYMD(y, m, d) ? { ok: true, date: fromYMD(y, m, d) } : bad;
  }

  // Год не указан: ближайшая дата не раньше сегодня (29.02 может быть через несколько лет).
  const thisYear = parts(today)[0];
  for (let y = thisYear; y <= thisYear + 8; y++) {
    if (isValidYMD(y, m, d) && fromYMD(y, m, d) >= today) return { ok: true, date: fromYMD(y, m, d) };
  }
  return bad;
}

// ---------- Часовой пояс ----------

/** Локальная дата и час в заданном часовом поясе. */
export function localNow(now: Date, timeZone: string): { date: ISODate; hour: number } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
