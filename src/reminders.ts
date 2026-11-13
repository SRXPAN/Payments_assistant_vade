// Чистая логика «что отправить сейчас» — без Telegram и без базы.
import {
  addDays,
  addPeriod,
  diffDays,
  effectiveDeadline,
  formatDate,
  formatShort,
  type ISODate,
  isWorkingDay,
  paymentStatus,
  type Period,
  shiftNote,
  weekdayShort,
} from "./dates";

/** После срока напоминаем только первые дни, потом — раз в неделю общей сводкой. */
export const OVERDUE_DAYS = 4;

export interface ReminderInput {
  id: number;
  name: string;
  due_date: ISODate;
  /** Свой час напоминания; null — общий из настроек. */
  remind_hour: number | null;
  /** Свой запас дней; null/undefined — общий из настроек. */
  warn_days?: number | null;
  /** Списывается с карты само: срок на рабочий день не переносится. */
  autopay?: number | boolean;
  archived?: boolean;
  deleted?: boolean;
}

export interface PlannedReminder<T extends ReminderInput = ReminderInput> {
  payment: T;
  text: string;
}

/** Срок, до которого реально нужно заплатить: для автосписания — сама дата. */
function deadlineOf(p: { due_date: ISODate; autopay?: number | boolean }): ISODate {
  return p.autopay ? p.due_date : effectiveDeadline(p.due_date).date;
}

/** Текст напоминания на сегодня или null, если сегодня по этому платежу писать не нужно. */
export function reminderText(
  name: string,
  due: ISODate,
  today: ISODate,
  warnDays: number,
  autopay = false,
): string | null {
  if (autopay) {
    const left = diffDays(today, due);
    if (left > warnDays || left < 0) return null;
    const when = left === 0 ? "Сегодня" : left === 1 ? "Завтра" : `Через ${left} дн.`;
    return `💳 ${when} автосписание: ${name} — ${formatDate(due)}. Проверьте, что на карте есть деньги.`;
  }

  const { date: deadline, reason } = effectiveDeadline(due);
  const days = diffDays(today, deadline);
  if (days > warnDays || days < -OVERDUE_DAYS) return null;

  const note = shiftNote(paymentStatus(due, today, warnDays));
  const tail = `${name} — до ${formatDate(due)}${note ? ` ${note}` : ""}`;

  if (days < 0) return `🔴 Просрочено на ${-days} дн.: ${tail}`;
  if (days === 0) {
    if (!reason) return `🟠 Сегодня последний день оплаты: ${tail}`;
    const why = reason === "weekend" ? "выходные" : "праздник";
    return `⚠️ Срок ${formatShort(due)} (${weekdayShort(due)}) выпадает на ${why} — оплатите сегодня: ${name}`;
  }
  if (days === 1) return `🟡 Завтра последний день оплаты: ${tail}`;
  return `🟡 Через ${days} дн. оплата: ${tail}`;
}

/**
 * Еженедельная сводка: платежи, просроченные так давно, что ежедневные напоминания по ним
 * уже не приходят. Возвращает строки сообщения или null, если таких платежей нет.
 */
export function overdueDigest(payments: ReminderInput[], today: ISODate): string[] | null {
  const lines: string[] = [];
  for (const p of payments) {
    if (p.archived || p.deleted) continue;
    const days = diffDays(today, deadlineOf(p));
    if (days < -OVERDUE_DAYS) lines.push(`• ${p.name} — до ${formatDate(p.due_date)}, просрочено на ${-days} дн.`);
  }
  if (lines.length === 0) return null;
  return [
    `🔴 Давно просрочено (${lines.length}):`,
    ...lines,
    "",
    "Отметьте оплату или удалите платёж: ✏️ Изменить в личном чате с ботом.",
  ];
}

/** План на неделю: что нужно оплатить с сегодняшнего дня по воскресенье, по дням. */
export function weekPlan(payments: ReminderInput[], today: ISODate): string[] | null {
  const until = addDays(today, 6);
  const rows: { deadline: ISODate; line: string }[] = [];
  for (const p of payments) {
    if (p.archived || p.deleted) continue;
    const deadline = deadlineOf(p);
    if (deadline < today || deadline > until) continue;
    let mark = "";
    if (p.autopay) mark = " 💳 авто";
    else if (deadline !== p.due_date) mark = ` (срок ${formatShort(p.due_date)}, ${weekdayShort(p.due_date)})`;
    rows.push({ deadline, line: `• ${weekdayShort(deadline)} ${formatShort(deadline)} — ${p.name}${mark}` });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.deadline.localeCompare(b.deadline));
  return [`🗓 На этой неделе платим (${rows.length}):`, ...rows.map((r) => r.line)];
}

/**
 * Автосписание: дата прошла — срок сдвигается сам. Возвращает новый срок (null — разовый
 * платёж, в архив) или undefined, если сдвигать ещё рано.
 */
export function autopayNextDue(
  p: { due_date: ISODate; period: Period; month_days?: string | null },
  today: ISODate,
): ISODate | null | undefined {
  if (p.due_date >= today) return undefined;
  let next: ISODate | null = p.due_date;
  // Бот мог не работать несколько периодов подряд — догоняем до ближайшей будущей даты.
  for (let i = 0; i < 60 && next !== null && next < today; i++) next = addPeriod(next, p.period, p.month_days);
  return next;
}

/** Ключ защиты от дублей: платёж + срок (дата отправки задаётся выборкой за сегодня). */
export const sentKey = (paymentId: number, due: ISODate) => `${paymentId}:${due}`;

export interface PlanOptions {
  today: ISODate;
  /** Текущий час в часовом поясе клуба. */
  hour: number;
  /** Час проверки из настроек. */
  defaultHour: number;
  /** Общий запас дней из настроек; у платежа может быть свой. */
  warnDays: number;
  /** Ключи sentKey уже отправленных сегодня напоминаний. */
  sent: ReadonlySet<string>;
  /** Не беспокоить в выходные и праздники: банки закрыты, платить всё равно нельзя. */
  quiet?: boolean;
  /** «🧪 Проверить сейчас»: не смотреть на час, выходные и уже отправленные. */
  force?: boolean;
}

/**
 * Что отправить сейчас. Час платежа уже наступил (или прошёл — так догоняется пропущенная
 * рассылка), напоминание сегодня ещё не уходило, платёж не в архиве и не удалён.
 */
export function planReminders<T extends ReminderInput>(payments: T[], o: PlanOptions): PlannedReminder<T>[] {
  const dayOff = Boolean(o.quiet) && !isWorkingDay(o.today);
  const plan: PlannedReminder<T>[] = [];
  for (const payment of payments) {
    if (payment.archived || payment.deleted) continue;
    if (!o.force) {
      // Автосписание случается и в выходной, поэтому о нём напоминаем в любой день.
      if (dayOff && !payment.autopay) continue;
      if (o.hour < (payment.remind_hour ?? o.defaultHour)) continue;
      if (o.sent.has(sentKey(payment.id, payment.due_date))) continue;
    }
    const text = reminderText(
      payment.name,
      payment.due_date,
      o.today,
      payment.warn_days ?? o.warnDays,
      Boolean(payment.autopay),
    );
    if (text) plan.push({ payment, text });
  }
  return plan;
}
