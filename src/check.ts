// Ежедневная рассылка напоминаний: вызывается из Cron Trigger каждый час и кнопкой «🧪 Проверить сейчас».
import { type Api, GrammyError, InlineKeyboard, InputFile } from "grammy";
import { type Env, getConfig } from "./config";
import { logCsv, paymentsCsv } from "./csv";
import { type ISODate, localNow, weekday } from "./dates";
import {
  cleanup,
  exportLog,
  exportPayments,
  getSentKeys,
  getSetting,
  getSettings,
  listPayments,
  type Payment,
  recordSent,
  setSetting,
} from "./db";
import { overdueDigest, planReminders } from "./reminders";
import { chunkLines } from "./views";

/**
 * Сколько напоминаний уходит за один запуск. На бесплатном плане Workers — 50 внешних
 * запросов на вызов; остаток досылается следующим почасовым запуском.
 */
const MAX_PER_RUN = 20;
const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const;
const MONDAY = 1;

export interface CheckResult {
  sent: number;
  /** Сколько напоминаний осталось на следующий запуск (лимит или ошибка отправки). */
  left: number;
  toGroup: boolean;
  /** Почему отправка прервалась, если прервалась. */
  error?: string;
}

export function reminderKeyboard(p: Payment): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Оплатил", `r:pay:${p.id}:${p.due_date}`)
    .text("📅 +1 мес", `r:m1:${p.id}:${p.due_date}`)
    .text("✏️ Дата", `r:date:${p.id}`);
}

/** Текст напоминания с заметкой платежа (где платить, номер договора). */
export function withNote(text: string, p: { note: string | null }): string {
  return p.note ? `${text}\n📝 ${p.note}` : text;
}

function describe(err: unknown): string {
  if (err instanceof GrammyError) return err.description;
  return err instanceof Error ? err.message : String(err);
}

/** Сообщение владельцу о сбое — не чаще одного раза в день. */
export async function alertOwner(env: Env, api: Api, text: string, now = new Date()): Promise<void> {
  const { ownerId, timeZone } = getConfig(env);
  const today = localNow(now, timeZone).date;
  try {
    if ((await getSetting(env.DB, "alert_sent")) === today) return;
    await api.sendMessage(ownerId, text, NO_PREVIEW);
    await setSetting(env.DB, "alert_sent", today);
  } catch (err) {
    console.error("Не удалось предупредить владельца о сбое", err);
  }
}

/** Два файла CSV: платежи (включая архивные и удалённые) и журнал. */
export async function sendCsv(db: D1Database, api: Api, chatId: number, stamp: ISODate, caption = ""): Promise<void> {
  const [payments, log] = await Promise.all([exportPayments(db), exportLog(db)]);
  const encoder = new TextEncoder();
  await api.sendDocument(chatId, new InputFile(encoder.encode(paymentsCsv(payments)), `payments_${stamp}.csv`), {
    caption: `${caption}Платежи: ${payments.length}`,
  });
  await api.sendDocument(chatId, new InputFile(encoder.encode(logCsv(log)), `payments_log_${stamp}.csv`), {
    caption: `Журнал: ${log.length} записей`,
  });
}

export async function runCheck(env: Env, api: Api, opts: { force?: boolean; now?: Date } = {}): Promise<CheckResult> {
  const { ownerId, timeZone } = getConfig(env);
  const db = env.DB;
  const now = opts.now ?? new Date();
  const { date: today, hour } = localNow(now, timeZone);

  const [payments, settings, sent] = await Promise.all([
    listPayments(db),
    getSettings(db),
    opts.force ? Promise.resolve(new Set<string>()) : getSentKeys(db, today),
  ]);
  const defaultHour = Number(settings.check_hour) || 12;
  const plan = planReminders(payments, {
    today,
    hour,
    defaultHour,
    warnDays: Number(settings.warn_days) || 4,
    sent,
    force: opts.force,
  });

  if (!opts.force && hour === defaultHour) {
    await cleanup(db, today).catch((err) => console.error("Уборка не удалась", err));
  }

  // Группа не привязана — напоминания идут владельцу в личку.
  const toGroup = Boolean(settings.group_chat_id);
  let target = toGroup ? Number(settings.group_chat_id) : ownerId;
  let sentCount = 0;
  let error: string | undefined;

  for (const { payment, text } of plan.slice(0, MAX_PER_RUN)) {
    const send = () =>
      api.sendMessage(target, withNote(text, payment), { reply_markup: reminderKeyboard(payment), ...NO_PREVIEW });
    try {
      let message;
      try {
        message = await send();
      } catch (err) {
        // Группу превратили в супергруппу: Telegram сообщает новый chat_id.
        const migrated = err instanceof GrammyError ? err.parameters.migrate_to_chat_id : undefined;
        if (!migrated || !toGroup) throw err;
        target = migrated;
        await setSetting(db, "group_chat_id", String(migrated));
        message = await send();
      }
      // Пробная рассылка в журнал отправленных не пишется, чтобы не отменить настоящую.
      if (!opts.force) await recordSent(db, payment.id, payment.due_date, today, target, message.message_id);
      sentCount++;
    } catch (err) {
      console.error("Не удалось отправить напоминание", err);
      error = describe(err);
      break; // чат недоступен — остальные попробуем в следующий запуск
    }
  }

  if (!opts.force) {
    if (error && toGroup) {
      await alertOwner(
        env,
        api,
        [
          `⚠️ Не удалось отправить напоминания в группу (${plan.length - sentCount} шт.).`,
          `Ответ Telegram: ${error}`,
          "Проверьте, что бот состоит в группе и может писать. Если группы больше нет — ⚙️ Настройки → Отвязать группу, тогда напоминания пойдут вам в личку.",
        ].join("\n"),
        now,
      );
    }

    // Раз в неделю, в понедельник: сводка давно просроченных и резервная копия владельцу.
    if (weekday(today) === MONDAY && hour >= defaultHour && settings.weekly_done !== today) {
      await setSetting(db, "weekly_done", today); // сразу, чтобы сбой не вызывал повторы каждый час
      const digest = overdueDigest(payments, today);
      try {
        for (const chunk of digest ? chunkLines(digest) : []) await api.sendMessage(target, chunk, NO_PREVIEW);
      } catch (err) {
        console.error("Не удалось отправить сводку просроченных", err);
      }
      try {
        await sendCsv(db, api, ownerId, today, "💾 Еженедельная резервная копия. ");
      } catch (err) {
        console.error("Не удалось отправить резервную копию", err);
      }
    }
  }
  return { sent: sentCount, left: plan.length - sentCount, toGroup, error };
}
