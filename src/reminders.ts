// Чистая логика «что отправить сейчас» — без Telegram и без базы.
import {
  diffDays,
  effectiveDeadline,
  formatDate,
  formatShort,
  type ISODate,
  paymentStatus,
  shiftNote,
  weekdayShort,
} from "./dates";

/** После срока напоминаем только первые дни, потом молчим (в списке платёж остаётся 🔴). */
export const OVERDUE_DAYS = 4;

export interface ReminderInput {
  id: number;
  name: string;
  due_date: ISODate;
  /** Свой час напоминания; null — общий из настроек. */
  remind_hour: number | null;
  archived?: boolean;
  deleted?: boolean;
}

export interface PlannedReminder<T extends ReminderInput = ReminderInput> {
  payment: T;
  text: string;
}

/** Текст напоминания на сегодня или null, если сегодня по этому платежу писать не нужно. */
export function reminderText(name: string, due: ISODate, today: ISODate, warnDays: number): string | null {
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
    const days = diffDays(today, effectiveDeadline(p.due_date).date);
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

/** Ключ защиты от дублей: платёж + срок (дата отправки задаётся выборкой за сегодня). */
export const sentKey = (paymentId: number, due: ISODate) => `${paymentId}:${due}`;

export interface PlanOptions {
  today: ISODate;
  /** Текущий час в часовом поясе клуба. */
  hour: number;
  /** Час проверки из настроек. */
  defaultHour: number;
  warnDays: number;
  /** Ключи sentKey уже отправленных сегодня напоминаний. */
  sent: ReadonlySet<string>;
  /** «🧪 Проверить сейчас»: не смотреть на час и на уже отправленные. */
  force?: boolean;
}

/**
 * Что отправить сейчас. Час платежа уже наступил (или прошёл — так догоняется пропущенная
 * рассылка), напоминание сегодня ещё не уходило, платёж не в архиве и не удалён.
 */
export function planReminders<T extends ReminderInput>(payments: T[], o: PlanOptions): PlannedReminder<T>[] {
  const plan: PlannedReminder<T>[] = [];
  for (const payment of payments) {
    if (payment.archived || payment.deleted) continue;
    if (!o.force) {
      if (o.hour < (payment.remind_hour ?? o.defaultHour)) continue;
      if (o.sent.has(sentKey(payment.id, payment.due_date))) continue;
    }
    const text = reminderText(payment.name, payment.due_date, o.today, o.warnDays);
    if (text) plan.push({ payment, text });
  }
  return plan;
}
