// Ежедневная рассылка напоминаний: вызывается из Cron Trigger каждый час и кнопкой «🧪 Проверить сейчас».
import { type Api, GrammyError, InlineKeyboard, InputFile } from "grammy";
import type { MessageEntity } from "grammy/types";
import { type Env, getConfig } from "./config";
import { logCsv, paymentsCsv } from "./csv";
import { type ISODate, localNow, weekday } from "./dates";
import {
  type Actor,
  changeDueDate,
  cleanup,
  deleteSetting,
  exportLog,
  exportPayments,
  getSentKeys,
  getSetting,
  getSettings,
  listPayments,
  listPeople,
  type Payment,
  type Person,
  recordSent,
  setSetting,
} from "./db";
import { autopayNextDue, overdueDigest, planReminders, weekPlan } from "./reminders";
import { chunkLines } from "./views";

/**
 * Сколько напоминаний уходит за один запуск. На бесплатном плане Workers — 50 внешних
 * запросов на вызов; остаток досылается следующим почасовым запуском.
 */
const MAX_PER_RUN = 20;
const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const;
const MONDAY = 1;
/** От чьего имени в журнале записывается автоматический сдвиг срока. */
const AUTOPAY_ACTOR: Actor = { id: 0, name: "автосписание" };

export interface CheckResult {
  sent: number;
  /** Сколько напоминаний осталось на следующий запуск (лимит или ошибка отправки). */
  left: number;
  toGroup: boolean;
  /** Почему отправка прервалась, если прервалась. */
  error?: string;
}

/** Куда писать: группа (и тема в ней) или личка владельца. */
export function targetOf(settings: Record<string, string | undefined>, ownerId: number) {
  const toGroup = Boolean(settings.group_chat_id);
  return {
    toGroup,
    chatId: toGroup ? Number(settings.group_chat_id) : ownerId,
    threadId: toGroup && settings.group_thread_id ? Number(settings.group_thread_id) : undefined,
  };
}

export function reminderKeyboard(p: Payment): InlineKeyboard {
  // Автосписание отмечать не нужно: срок сдвинется сам. Остаётся только поправить дату.
  if (p.autopay) return new InlineKeyboard().text("✏️ Дата", `r:date:${p.id}`);
  return new InlineKeyboard()
    .text("✅ Оплатил", `r:pay:${p.id}:${p.due_date}`)
    .text("📅 +1 мес", `r:m1:${p.id}:${p.due_date}`)
    .text("✏️ Дата", `r:date:${p.id}`);
}

/**
 * Полный текст напоминания: заметка платежа и упоминание ответственного. У кого есть
 * @username — упоминается по нему, остальные — по имени со ссылкой на профиль.
 */
export function buildReminder(
  text: string,
  p: Payment,
  people?: Map<number, Person>,
): { text: string; entities?: MessageEntity[] } {
  let out = p.note ? `${text}\n📝 ${p.note}` : text;
  const person = p.responsible_id ? people?.get(p.responsible_id) : undefined;
  if (!person || !p.responsible_id) return { text: out };
  if (person.username) return { text: `${out}\n👤 @${person.username}` };
  out += "\n👤 ";
  return {
    text: out + person.name,
    entities: [
      {
        type: "text_mention",
        offset: out.length,
        length: person.name.length,
        user: { id: p.responsible_id, is_bot: false, first_name: person.name },
      },
    ],
  };
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

  const [all, settings, sent] = await Promise.all([
    listPayments(db),
    getSettings(db),
    opts.force ? Promise.resolve(new Set<string>()) : getSentKeys(db, today),
  ]);
  const defaultHour = Number(settings.check_hour) || 12;
  const warnDays = Number(settings.warn_days) || 4;

  // Автосписания: дата прошла — срок сдвигается сам, без нажатия «Оплатил».
  const payments: Payment[] = [];
  for (const p of all) {
    const next = opts.force || !p.autopay ? undefined : autopayNextDue(p, today);
    if (next === undefined) {
      payments.push(p);
    } else if (await changeDueDate(db, p, next, AUTOPAY_ACTOR, "paid")) {
      if (next !== null) payments.push({ ...p, due_date: next }); // разовый платёж ушёл в архив
    }
  }

  const plan = planReminders(payments, {
    today,
    hour,
    defaultHour,
    warnDays,
    sent,
    quiet: settings.quiet_weekends !== "0",
    force: opts.force,
  });

  if (!opts.force && hour === defaultHour) {
    await cleanup(db, today).catch((err) => console.error("Уборка не удалась", err));
  }

  const target = targetOf(settings, ownerId);
  const { toGroup } = target;
  let { chatId, threadId } = target;

  /** Отправка с учётом переезда группы в супергруппу и удалённой темы. */
  const post = async (text: string, extra: { reply_markup?: InlineKeyboard; entities?: MessageEntity[] } = {}) => {
    const attempt = () =>
      api.sendMessage(chatId, text, { ...extra, ...NO_PREVIEW, ...(threadId ? { message_thread_id: threadId } : {}) });
    try {
      return await attempt();
    } catch (err) {
      if (!(err instanceof GrammyError) || !toGroup) throw err;
      const migrated = err.parameters.migrate_to_chat_id;
      if (migrated) {
        chatId = migrated;
        await setSetting(db, "group_chat_id", String(migrated));
        return attempt();
      }
      if (threadId && /thread not found/i.test(err.description)) {
        // Тему удалили — пишем в общий чат группы.
        threadId = undefined;
        await deleteSetting(db, "group_thread_id");
        return attempt();
      }
      throw err;
    }
  };

  const people = plan.some((r) => r.payment.responsible_id) ? await listPeople(db, ownerId) : undefined;
  let sentCount = 0;
  let error: string | undefined;

  for (const { payment, text } of plan.slice(0, MAX_PER_RUN)) {
    try {
      const reminder = buildReminder(text, payment, people);
      const message = await post(reminder.text, {
        reply_markup: reminderKeyboard(payment),
        entities: reminder.entities,
      });
      // Пробная рассылка в журнал отправленных не пишется, чтобы не отменить настоящую.
      if (!opts.force) await recordSent(db, payment.id, payment.due_date, today, chatId, message.message_id);
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

    // Раз в неделю, в понедельник: план на неделю, давно просроченные и резервная копия владельцу.
    if (weekday(today) === MONDAY && hour >= defaultHour && settings.weekly_done !== today) {
      await setSetting(db, "weekly_done", today); // сразу, чтобы сбой не вызывал повторы каждый час
      try {
        for (const block of [weekPlan(payments, today), overdueDigest(payments, today)]) {
          for (const chunk of block ? chunkLines(block) : []) await post(chunk);
        }
      } catch (err) {
        console.error("Не удалось отправить недельную сводку", err);
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
