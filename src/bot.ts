import { Bot, type Context, GrammyError, InlineKeyboard, Keyboard } from "grammy";
import { BULK_MAX_LINES, parseBulk } from "./bulk";
import { buildReminder, reminderKeyboard, runCheck, sendCsv, targetOf } from "./check";
import { type Env, getConfig } from "./config";
import { addMonths, addPeriod, formatDate, localNow, parseDateInput, type Period, periodLabel } from "./dates";
import {
  type Actor,
  changeDueDate,
  clearState,
  createPayments,
  deletePayment,
  deleteSetting,
  deleteUser,
  getHistory,
  getLastPaid,
  getPayment,
  getRole,
  getSetting,
  getSettings,
  getState,
  getUser,
  getWarnDays,
  listPayments,
  listPeople,
  listTrash,
  listUsers,
  type Payment,
  restorePayment,
  type Role,
  saveAccessRequest,
  setSetting,
  setState,
  setUserRole,
  undoLastPayment,
  updatePaymentField,
  updatePeriod,
} from "./db";
import { groupHelp, helpText } from "./help";
import { reminderText } from "./reminders";
import {
  accessListView,
  cancelKeyboard,
  cardView,
  CATEGORIES,
  categoriesView,
  categoryKeyboard,
  dayKeyboard,
  editListView,
  filterByCategory,
  HOUR_CHOICES,
  hourKeyboard,
  listKeyboard,
  listMessages,
  paramsView,
  PAYMENT_WARN_CHOICES,
  periodKeyboard,
  PERIODS,
  responsibleKeyboard,
  searchPayments,
  settingsView,
  singleListView,
  trashView,
  truncate,
  userCardView,
  type View,
  WARN_CHOICES,
  warnKeyboard,
} from "./views";

export const MENU = {
  list: "📋 Список",
  add: "➕ Добавить",
  edit: "✏️ Изменить",
  access: "👥 Доступ",
  settings: "⚙️ Настройки",
  help: "❓ Помощь",
} as const;

const ROLE_LABELS: Record<Role, string> = { owner: "владелец", admin: "админ", viewer: "наблюдатель" };
const NO_ACCESS = "Нет доступа";
const NO_PREVIEW = { link_preview_options: { is_disabled: true } } as const;
const NAME_MAX = 64;
const NOTE_MAX = 200;
const ASK_NAME = `Введите название платежа (до ${NAME_MAX} символов).`;
const ASK_DATE = "До какой даты оплачено? Например 25.11.2026";
const ASK_BULK = [
  "Пришлите список одним сообщением — по одному платежу в строке:",
  "Название; дата; период",
  "",
  "Например:",
  "Интернет; 25.11; ежемесячно",
  "Аренда; 01.12.2026; ежемесячно",
  "Домен site.com.ua; 14.03.2027; ежегодно",
  "",
  `Период можно не писать — будет «ежемесячно». Варианты: ежемесячно, раз в квартал, ежегодно, каждые 2 недели, разово. До ${BULK_MAX_LINES} строк за раз.`,
].join("\n");
const MONTH_BUTTONS: Record<string, number> = { m1: 1, m3: 3, m12: 12 };
const SEARCH_MAX = 20;

export function menuKeyboard(role: Role): Keyboard {
  const kb = new Keyboard();
  if (role === "viewer") {
    kb.text(MENU.list).text(MENU.help);
  } else {
    kb.text(MENU.list).text(MENU.add).row().text(MENU.edit).text(MENU.help);
    if (role === "owner") kb.row().text(MENU.access).text(MENU.settings);
  }
  return kb.resized().persistent();
}

/** Кто может открыть пункт меню. */
function allowed(role: Role | null, item: string): boolean {
  if (!role) return false;
  if (item === MENU.list || item === MENU.help) return true;
  if (item === MENU.add || item === MENU.edit) return role !== "viewer";
  return role === "owner";
}

const canEdit = (role: Role | null) => role === "owner" || role === "admin";

function displayName(u: { first_name?: string; name?: string; username?: string | null; id: number }): string {
  return `${u.first_name ?? u.name} (${u.username ? `@${u.username}, ` : ""}${u.id})`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Название: одна строка, не пустое, не длиннее лимита. Возвращает текст ошибки или null. */
function nameError(name: string): string | null {
  if (!name) return "Название не может быть пустым.";
  if (name.includes("\n")) return "Название должно быть в одну строку.";
  if ([...name].length > NAME_MAX) return `Слишком длинно: ${[...name].length} символов, максимум ${NAME_MAX}.`;
  return null;
}

/** В группе с темами ответ должен уйти в ту же тему, что и исходное сообщение. */
function threadOf(message: unknown): { message_thread_id?: number } {
  const m = message as { is_topic_message?: boolean; message_thread_id?: number } | undefined;
  return m?.is_topic_message && m.message_thread_id ? { message_thread_id: m.message_thread_id } : {};
}

const dayOf = (iso: string) => Number(iso.slice(8, 10));
/** Два числа месяца в порядке возрастания: «10,25». */
const monthDays = (a: number, b: number) => `${Math.min(a, b)},${Math.max(a, b)}`;

export function createBot(env: Env): Bot {
  const { ownerId, timeZone } = getConfig(env);
  const db = env.DB;
  const bot = new Bot(env.BOT_TOKEN, {
    // Ожидается JSON из /setup; всё остальное игнорируем, тогда grammY сам спросит getMe.
    botInfo: env.BOT_INFO?.trim().startsWith("{") ? JSON.parse(env.BOT_INFO) : undefined,
  });
  const dm = bot.chatType("private");
  const today = () => localNow(new Date(), timeZone).date;

  /** Редактирует сообщение, под которым нажали кнопку. */
  async function show(ctx: Context, view: View | string): Promise<void> {
    const text = typeof view === "string" ? view : view.text;
    const reply_markup = typeof view === "string" ? undefined : view.keyboard;
    try {
      await ctx.editMessageText(text, { reply_markup, ...NO_PREVIEW });
    } catch (err) {
      // Повторное нажатие той же кнопки: текст не изменился — это не ошибка.
      if (!(err instanceof GrammyError && err.description.includes("not modified"))) throw err;
    }
  }

  async function editList(page = 0, note = ""): Promise<View> {
    const [payments, warnDays] = await Promise.all([listPayments(db), getWarnDays(db)]);
    return editListView(payments, today(), warnDays, page, note);
  }

  async function responsibleName(p: Payment): Promise<string | null> {
    if (!p.responsible_id) return null;
    return (await listPeople(db, ownerId)).get(p.responsible_id)?.name ?? null;
  }

  async function card(p: Payment, note = ""): Promise<View> {
    const [last, history, responsible] = await Promise.all([
      getLastPaid(db, p.id),
      getHistory(db, p.id),
      responsibleName(p),
    ]);
    return cardView(p, { last, history, timeZone, responsible, note });
  }

  async function params(p: Payment, note = ""): Promise<View> {
    const [settings, responsible] = await Promise.all([getSettings(db), responsibleName(p)]);
    return paramsView(p, {
      warnDays: Number(settings.warn_days) || 4,
      hour: Number(settings.check_hour) || 12,
      responsible,
      note,
    });
  }

  /** Роль и справка под неё — приходит человеку при выдаче или смене доступа. */
  async function welcome(userId: number, role: "admin" | "viewer", intro: string): Promise<void> {
    await bot.api.sendMessage(userId, `${intro}\n\n${helpText(role, await getWarnDays(db))}`, {
      reply_markup: menuKeyboard(role),
      ...NO_PREVIEW,
    });
  }

  /** «✅ Сеня отметил оплату…» — в группу (в её тему), а пока группа не привязана — владельцу. */
  async function notifyGroup(actor: Actor, text: string, fromChatId?: number): Promise<void> {
    const target = targetOf(await getSettings(db), ownerId);
    // Не дублируем: владелец сам отметил в личке, или оплату отметили прямо под напоминанием в этом чате.
    if (target.chatId === actor.id || target.chatId === fromChatId) return;
    try {
      await bot.api.sendMessage(target.chatId, text, {
        ...NO_PREVIEW,
        ...(target.threadId ? { message_thread_id: target.threadId } : {}),
      });
    } catch (err) {
      console.error("Не удалось отправить уведомление в группу", err);
    }
  }

  /** Владелец узнаёт о важных действиях админов: удаление платежа, ручная смена срока. */
  async function notifyOwner(actor: Actor, text: string): Promise<void> {
    if (actor.id === ownerId) return;
    try {
      await bot.api.sendMessage(ownerId, `🔔 ${text}`, NO_PREVIEW);
    } catch (err) {
      console.error("Не удалось уведомить владельца", err);
    }
  }

  // ---------- /start и доступ ----------

  dm.command("start", async (ctx) => {
    const from = ctx.from;
    const role = await getRole(db, ownerId, from.id);
    if (role) {
      await clearState(db, ctx.chat.id, from.id);
      if (role === "owner") {
        // Имя владельца нужно, чтобы назначать его ответственным и упоминать в напоминаниях.
        await setSetting(db, "owner_name", from.first_name);
        await setSetting(db, "owner_username", from.username ?? "");
      }
      await ctx.reply(`Здравствуйте, ${from.first_name}! Ваша роль: ${ROLE_LABELS[role]}.`, {
        reply_markup: menuKeyboard(role),
      });
      return;
    }

    const existing = await getUser(db, from.id);
    if (existing?.role === "rejected") {
      // Отказ или отозванный доступ: новые запросы владельцу не уходят, пока он сам не снимет блокировку.
      await ctx.reply("Нет доступа.", { reply_markup: { remove_keyboard: true } });
      return;
    }
    await saveAccessRequest(db, from.id, from.first_name, from.username ?? null);
    await ctx.reply("Нет доступа, запрос отправлен владельцу.", { reply_markup: { remove_keyboard: true } });
    if (existing?.role === "pending") return; // запрос уже у владельца, не дублируем

    const kb = new InlineKeyboard()
      .text("Админ", `acc:admin:${from.id}`)
      .text("Наблюдатель", `acc:viewer:${from.id}`)
      .text("Отклонить", `acc:deny:${from.id}`);
    try {
      await ctx.api.sendMessage(ownerId, `${displayName(from)} просит доступ`, { reply_markup: kb });
    } catch (err) {
      // Владелец ещё не нажал /start у бота — запрос останется в базе.
      console.error("Не удалось отправить запрос владельцу", err);
    }
  });

  // Решение владельца по запросу доступа.
  bot.callbackQuery(/^acc:(admin|viewer|deny):(\d+)$/, async (ctx) => {
    if (ctx.from.id !== ownerId) {
      await ctx.answerCallbackQuery({ text: NO_ACCESS, show_alert: true });
      return;
    }
    const action = ctx.match[1] as "admin" | "viewer" | "deny";
    const userId = Number(ctx.match[2]);
    const user = await getUser(db, userId);
    if (!user) {
      await ctx.answerCallbackQuery({ text: "Пользователь не найден" });
      return;
    }
    await setUserRole(db, userId, action === "deny" ? "rejected" : action);
    await ctx.answerCallbackQuery();

    try {
      if (action === "deny") {
        await ctx.editMessageText(`❌ Отклонено: ${displayName(user)}`);
        await ctx.api.sendMessage(userId, "В доступе отказано.");
      } else {
        await ctx.editMessageText(`✅ ${displayName(user)} — ${ROLE_LABELS[action]}`);
        await welcome(userId, action, `Доступ открыт. Ваша роль: ${ROLE_LABELS[action]}.`);
      }
    } catch (err) {
      console.error("Не удалось сообщить о решении по доступу", err);
    }
  });

  // ---------- Нижнее меню ----------

  dm.hears(Object.values(MENU), async (ctx) => {
    const item = ctx.message.text ?? "";
    const role = await getRole(db, ownerId, ctx.from.id);
    if (!role || !allowed(role, item)) {
      await ctx.reply(
        NO_ACCESS,
        role ? { reply_markup: menuKeyboard(role) } : { reply_markup: { remove_keyboard: true } },
      );
      return;
    }
    // Нажатие пункта меню прерывает незаконченный ввод.
    await clearState(db, ctx.chat.id, ctx.from.id);

    if (item === MENU.list) {
      const [payments, warnDays] = await Promise.all([listPayments(db), getWarnDays(db)]);
      const chunks = listMessages(payments, today(), warnDays);
      const keyboard = listKeyboard(payments);
      for (const [i, text] of chunks.entries()) {
        const last = i === chunks.length - 1;
        await ctx.reply(text, { ...NO_PREVIEW, ...(last && keyboard ? { reply_markup: keyboard } : {}) });
      }
    } else if (item === MENU.add) {
      await setState(db, ctx.chat.id, ctx.from.id, "add:name");
      await ctx.reply(ASK_NAME, {
        reply_markup: new InlineKeyboard().text("📋 Добавить списком", "a:bulk").row().text("↩️ Отмена", "a:cancel"),
      });
    } else if (item === MENU.edit) {
      const view = await editList();
      await ctx.reply(view.text, { reply_markup: view.keyboard, ...NO_PREVIEW });
    } else if (item === MENU.help) {
      // Заодно обновляет нижнее меню, если оно изменилось после обновления бота.
      await ctx.reply(helpText(role, await getWarnDays(db)), { reply_markup: menuKeyboard(role), ...NO_PREVIEW });
    } else {
      const view = item === MENU.settings ? settingsView(await getSettings(db)) : accessListView(await listUsers(db));
      await ctx.reply(view.text, { reply_markup: view.keyboard, ...NO_PREVIEW });
    }
  });

  // ---------- Список по категориям: доступно всем, у кого есть роль ----------

  bot.callbackQuery(/^l:(cats|all|cat)(?::(\w+))?$/, async (ctx) => {
    if (!(await getRole(db, ownerId, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: NO_ACCESS, show_alert: true });
      return;
    }
    const [payments, warnDays] = await Promise.all([listPayments(db), getWarnDays(db)]);
    await ctx.answerCallbackQuery();
    if (ctx.match[1] === "cats") {
      await show(ctx, categoriesView(payments));
    } else if (ctx.match[1] === "all") {
      await show(ctx, singleListView(payments, today(), warnDays, "📋 Платежи", payments));
    } else {
      const filtered = filterByCategory(payments, ctx.match[2] ?? "");
      if (filtered) await show(ctx, singleListView(filtered.items, today(), warnDays, filtered.title, payments));
    }
  });

  // ---------- «👥 Доступ» и «⚙️ Настройки»: только владелец, проверка на каждом нажатии ----------

  const ownerOnly = bot.on("callback_query:data").filter(async (ctx) => {
    if (!/^[su]:/.test(ctx.callbackQuery.data)) return false;
    if (ctx.from.id === ownerId) return true;
    await ctx.answerCallbackQuery({ text: NO_ACCESS, show_alert: true });
    return false;
  });

  ownerOnly.callbackQuery("u:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx, accessListView(await listUsers(db)));
  });

  ownerOnly.callbackQuery(/^u:(open|set|revoke|forget):(\d+)(?::(admin|viewer))?$/, async (ctx) => {
    const action = ctx.match[1];
    const userId = Number(ctx.match[2]);
    const user = userId === ownerId ? null : await getUser(db, userId);
    if (!user) {
      await ctx.answerCallbackQuery({
        text: userId === ownerId ? "Владельца изменить нельзя." : "Этого человека уже нет в списке.",
      });
      await show(ctx, accessListView(await listUsers(db)));
      return;
    }

    if (action === "open") {
      await ctx.answerCallbackQuery();
      await show(ctx, userCardView(user));
      return;
    }

    const role = ctx.match[3] as "admin" | "viewer" | undefined;
    if (action === "set" && role) {
      await setUserRole(db, userId, role);
      await ctx.answerCallbackQuery({ text: "Роль изменена" });
      await show(ctx, userCardView({ ...user, role }, `✅ ${user.name} теперь ${ROLE_LABELS[role]}`));
      // Новая роль действует сразу; человеку приходит уведомление, справка и подходящее меню.
      await welcome(userId, role, `Ваша роль: ${ROLE_LABELS[role]}.`).catch((err) =>
        console.error("Не удалось сообщить о смене роли", err),
      );
      return;
    }

    if (action === "forget") {
      await deleteUser(db, userId);
      await ctx.answerCallbackQuery({ text: "Удалён из списка" });
      await show(
        ctx,
        accessListView(await listUsers(db), `${user.name} удалён из списка и может снова отправить запрос через Start.`),
      );
      return;
    }

    if (action === "revoke") {
      const wasPending = user.role === "pending";
      // Запись остаётся с пометкой «нет доступа»: повторные Start от этого человека вас не побеспокоят.
      await setUserRole(db, userId, "rejected");
      await clearState(db, userId, userId);
      await ctx.answerCallbackQuery({ text: wasPending ? "Отклонено" : "Доступ закрыт" });
      await show(
        ctx,
        accessListView(await listUsers(db), wasPending ? `❌ Отклонено: ${user.name}` : `🚫 Доступ закрыт: ${user.name}`),
      );
      await ctx.api
        .sendMessage(userId, wasPending ? "В доступе отказано." : "Доступ к боту закрыт.", {
          reply_markup: { remove_keyboard: true },
        })
        .catch((err) => console.error("Не удалось сообщить о закрытии доступа", err));
      return;
    }
    await ctx.answerCallbackQuery();
  });

  ownerOnly.callbackQuery(/^s:(days|hour):(\d+)$/, async (ctx) => {
    const value = Number(ctx.match[2]);
    const isDays = ctx.match[1] === "days";
    if (!(isDays ? WARN_CHOICES : HOUR_CHOICES).includes(value)) {
      await ctx.answerCallbackQuery({ text: "Неизвестное значение" });
      return;
    }
    await setSetting(db, isDays ? "warn_days" : "check_hour", String(value));
    await ctx.answerCallbackQuery({ text: "Сохранено" });
    await show(ctx, settingsView(await getSettings(db)));
  });

  // Не беспокоить в выходные и праздники (по умолчанию включено).
  ownerOnly.callbackQuery("s:quiet", async (ctx) => {
    const quiet = (await getSetting(db, "quiet_weekends")) !== "0";
    await setSetting(db, "quiet_weekends", quiet ? "0" : "1");
    await ctx.answerCallbackQuery({ text: "Сохранено" });
    await show(ctx, settingsView(await getSettings(db)));
  });

  ownerOnly.callbackQuery("s:notopic", async (ctx) => {
    await deleteSetting(db, "group_thread_id");
    await ctx.answerCallbackQuery({ text: "Тема сброшена" });
    await show(ctx, settingsView(await getSettings(db), "Напоминания будут приходить в общий чат группы."));
  });

  ownerOnly.callbackQuery("s:unbind", async (ctx) => {
    const group = await getSetting(db, "group_chat_id");
    for (const key of ["group_chat_id", "group_title", "group_thread_id"]) await deleteSetting(db, key);
    await ctx.answerCallbackQuery({ text: "Группа отвязана" });
    await show(ctx, settingsView(await getSettings(db), "Группа отвязана — напоминания будут приходить вам в личку."));
    // Бот выходит из группы; чтобы привязать снова, добавьте его заново.
    if (group) await ctx.api.leaveChat(Number(group)).catch(() => {});
  });

  ownerOnly.callbackQuery("s:csv", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Готовлю файлы…" });
    await sendCsv(db, bot.api, ctx.from.id, today());
  });

  ownerOnly.callbackQuery(/^s:(trash|back)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await show(ctx, ctx.match[1] === "trash" ? trashView(await listTrash(db)) : settingsView(await getSettings(db)));
  });

  ownerOnly.callbackQuery(/^s:restore:(\d+)$/, async (ctx) => {
    const item = await restorePayment(db, Number(ctx.match[1]), { id: ctx.from.id, name: ctx.from.first_name });
    await ctx.answerCallbackQuery({ text: item ? "Восстановлено" : "Этого платежа в корзине уже нет." });
    const note = item ? `♻️ Восстановлено: ${item.name} — до ${formatDate(item.due_date)}` : "";
    await show(ctx, trashView(await listTrash(db), note));
  });

  ownerOnly.callbackQuery("s:test", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Проверяю…" });
    const result = await runCheck(env, bot.api, { force: true });
    const where = result.toGroup ? "в группу" : "вам в личку";
    let text = result.sent
      ? `🧪 Отправлено напоминаний: ${result.sent} (${where}).`
      : "🧪 Сегодня напоминать не о чем: ни один платёж не попадает в окно напоминаний.";
    if (result.error) text += `\n⚠️ Отправка прервалась, не отправлено: ${result.left}. Ответ Telegram: ${result.error}`;
    else if (result.left) text += `\nНе отправлено: ${result.left} — лимит на один запуск.`;
    await ctx.reply(text);
  });

  // ---------- Группа для напоминаний ----------

  bot.on("my_chat_member", async (ctx) => {
    const chat = ctx.chat;
    if (chat.type === "private") return;
    const inChat = (status: string) => status === "member" || status === "administrator";
    const update = ctx.myChatMember;
    const bound = await getSetting(db, "group_chat_id");
    const isBound = bound === String(chat.id);

    if (!inChat(update.new_chat_member.status)) {
      if (isBound) {
        // Бота удалили из рабочей группы.
        for (const key of ["group_chat_id", "group_title", "group_thread_id"]) await deleteSetting(db, key);
      }
      return;
    }
    if (isBound || inChat(update.old_chat_member.status)) return; // уже были здесь, сменились только права

    if (chat.type === "channel" || update.from.id !== ownerId) {
      await ctx.leaveChat().catch((err) => console.error("Не удалось выйти из чата", err));
      return;
    }
    await setSetting(db, "group_chat_id", String(chat.id));
    await setSetting(db, "group_title", chat.title ?? "");
    await deleteSetting(db, "group_thread_id");
    await ctx.reply(groupHelp(ctx.me.username));
    // Рабочая группа одна: из прежней выходим.
    if (bound) await ctx.api.leaveChat(Number(bound)).catch(() => {});
  });

  // Группу превратили в супергруппу — у неё новый chat_id.
  bot.on("message:migrate_to_chat_id", async (ctx) => {
    if ((await getSetting(db, "group_chat_id")) === String(ctx.chat.id)) {
      await setSetting(db, "group_chat_id", String(ctx.message.migrate_to_chat_id));
    }
  });

  bot.chatType(["group", "supergroup"]).on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const actor: Actor = { id: ctx.from.id, name: ctx.from.first_name };
    const thread = threadOf(ctx.message);

    // Владелец упомянул бота: напоминания будут приходить в тему, где написано это сообщение.
    if (actor.id === ownerId && ctx.message.text.includes(`@${ctx.me.username}`)) {
      if ((await getSetting(db, "group_chat_id")) !== String(chatId)) return;
      if (thread.message_thread_id) {
        await setSetting(db, "group_thread_id", String(thread.message_thread_id));
        await ctx.reply("Готово, напоминания будут приходить в эту тему.", thread);
      } else {
        await deleteSetting(db, "group_thread_id");
        await ctx.reply("Готово, напоминания будут приходить в общий чат группы.");
      }
      return;
    }

    // Ответ с новой датой на просьбу бота (кнопка «✏️ Дата» под напоминанием).
    const replyTo = ctx.message.reply_to_message?.message_id;
    if (!replyTo) return;
    const fsm = await getState(db, chatId, actor.id);
    if (fsm?.state !== "edit:date" || fsm.data.promptId !== replyTo) return;

    const p = fsm.data.id ? await getPayment(db, fsm.data.id) : null;
    if (!p || !canEdit(await getRole(db, ownerId, actor.id))) {
      await clearState(db, chatId, actor.id);
      if (!p) await ctx.reply("Платёж не найден — возможно, его уже оплатили или удалили.", thread);
      return;
    }
    const parsed = parseDateInput(ctx.message.text, today());
    if (!parsed.ok) {
      const again = await ctx.reply(`${parsed.error}\nОтветьте на это сообщение.`, {
        ...thread,
        reply_parameters: { message_id: ctx.message.message_id },
        reply_markup: { force_reply: true, selective: true, input_field_placeholder: "25.11.2026" },
      });
      await setState(db, chatId, actor.id, "edit:date", { ...fsm.data, promptId: again.message_id });
      return;
    }
    if (parsed.date !== p.due_date) await changeDueDate(db, p, parsed.date, actor, "edit_date");
    await clearState(db, chatId, actor.id);
    const done = `✏️ Срок изменён (${actor.name}): ${p.name} — до ${formatDate(parsed.date)}`;
    await ctx.reply(done, { ...thread, ...NO_PREVIEW });
    if (fsm.data.remId) {
      // Под старым напоминанием кнопки больше не нужны.
      await ctx.api.editMessageText(chatId, fsm.data.remId, done, NO_PREVIEW).catch(() => {});
    }
    if (parsed.date !== p.due_date) {
      await notifyOwner(
        actor,
        `${actor.name} изменил срок: ${p.name} — ${formatDate(p.due_date)} → ${formatDate(parsed.date)}`,
      );
    }
  });

  // ---------- Текст в личке: пошаговый ввод, а без него — поиск по платежам ----------

  dm.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const actor: Actor = { id: ctx.from.id, name: ctx.from.first_name };
    const role = await getRole(db, ownerId, actor.id);
    if (!role) {
      await ctx.reply("Нет доступа. Нажмите /start, чтобы отправить запрос владельцу.");
      return;
    }
    const text = ctx.message.text.trim();
    const fsm = canEdit(role) ? await getState(db, chatId, actor.id) : null;

    if (!fsm) {
      const [payments, warnDays] = await Promise.all([listPayments(db), getWarnDays(db)]);
      const found = text.length >= 2 ? searchPayments(payments, text) : [];
      if (found.length === 0) {
        await ctx.reply(
          `Ничего не нашлось по запросу «${truncate(text, 40)}». Напишите часть названия платежа или выберите действие в меню.`,
          { reply_markup: menuKeyboard(role), ...NO_PREVIEW },
        );
        return;
      }
      const shown = found.slice(0, SEARCH_MAX);
      let body = listMessages(shown, today(), warnDays, "🔎 Найдено")[0]!;
      if (found.length > shown.length) body += `\n… и ещё ${found.length - shown.length}. Уточните запрос.`;
      if (!canEdit(role)) {
        await ctx.reply(body, NO_PREVIEW);
        return;
      }
      // Тем, кто может менять платежи, — кнопки, чтобы сразу открыть карточку.
      const keyboard = new InlineKeyboard();
      for (const p of shown.slice(0, 10)) keyboard.text(`✏️ ${truncate(p.name)}`, `p:open:${p.id}`).row();
      await ctx.reply(body, { reply_markup: keyboard, ...NO_PREVIEW });
      return;
    }

    switch (fsm.state) {
      case "add:name": {
        const error = nameError(text);
        if (error) {
          await ctx.reply(`${error} ${ASK_NAME}`, { reply_markup: cancelKeyboard() });
          return;
        }
        const lower = text.toLowerCase();
        const duplicate = (await listPayments(db)).some((p) => p.name.toLowerCase() === lower);
        if (duplicate) {
          await setState(db, chatId, actor.id, "add:dup", { name: text });
          await ctx.reply(`Платёж «${text}» уже есть в списке.`, {
            reply_markup: new InlineKeyboard().text("Всё равно добавить", "a:dupok").text("Отмена", "a:cancel"),
            ...NO_PREVIEW,
          });
          return;
        }
        await setState(db, chatId, actor.id, "add:date", { name: text });
        await ctx.reply(ASK_DATE, { reply_markup: cancelKeyboard() });
        return;
      }

      case "add:date": {
        const parsed = parseDateInput(text, today());
        if (!parsed.ok) {
          await ctx.reply(parsed.error, { reply_markup: cancelKeyboard() });
          return;
        }
        await setState(db, chatId, actor.id, "add:period", { name: fsm.data.name, date: parsed.date });
        await ctx.reply("Как часто платится?", { reply_markup: periodKeyboard("a:per:", "a:cancel") });
        return;
      }

      case "add:bulk": {
        const existing = (await listPayments(db)).map((p) => p.name);
        const result = parseBulk(ctx.message.text, today(), existing);
        await createPayments(db, result.items, actor.id);
        const lines: string[] = [];
        if (result.items.length) {
          lines.push(`✅ Добавлено: ${result.items.length}`);
          for (const item of result.items.slice(0, 30)) {
            lines.push(`• ${item.name} — ${formatDate(item.date)} (${periodLabel(item.period)})`);
          }
          if (result.items.length > 30) lines.push(`… и ещё ${result.items.length - 30}`);
        }
        if (result.errors.length) {
          if (lines.length) lines.push("");
          lines.push(`⚠️ Не добавлено (${result.errors.length}):`);
          for (const e of result.errors.slice(0, 15)) lines.push(`• «${truncate(e.line, 50)}» — ${e.reason}`);
          if (result.errors.length > 15) lines.push(`… и ещё ${result.errors.length - 15}`);
        }
        if (result.items.length) {
          await clearState(db, chatId, actor.id);
          await ctx.reply(lines.join("\n"), NO_PREVIEW);
        } else {
          // Ничего не добавилось — остаёмся в режиме списка, чтобы можно было прислать исправленный.
          lines.push("", "Исправьте и пришлите список ещё раз.");
          await ctx.reply(lines.join("\n"), { reply_markup: cancelKeyboard(), ...NO_PREVIEW });
        }
        return;
      }

      case "add:dup":
      case "add:period":
      case "add:day":
        await ctx.reply("Выберите вариант кнопкой в сообщении выше.");
        return;

      case "edit:date":
      case "edit:name":
      case "edit:note": {
        const p = fsm.data.id ? await getPayment(db, fsm.data.id) : null;
        if (!p) {
          await clearState(db, chatId, actor.id);
          await ctx.reply("Платёж не найден — возможно, его уже удалили.");
          return;
        }
        const back = cancelKeyboard(`p:open:${p.id}`);
        let note: string;
        if (fsm.state === "edit:date") {
          const parsed = parseDateInput(text, today());
          if (!parsed.ok) {
            await ctx.reply(parsed.error, { reply_markup: back });
            return;
          }
          note = `✅ Дата изменена: ${formatDate(p.due_date)} → ${formatDate(parsed.date)}`;
          if (parsed.date !== p.due_date) {
            await changeDueDate(db, p, parsed.date, actor, "edit_date");
            await notifyOwner(
              actor,
              `${actor.name} изменил срок: ${p.name} — ${formatDate(p.due_date)} → ${formatDate(parsed.date)}`,
            );
          }
        } else if (fsm.state === "edit:note") {
          if (!text || [...text].length > NOTE_MAX) {
            await ctx.reply(`Заметка должна быть не длиннее ${NOTE_MAX} символов (сейчас ${[...text].length}).`, {
              reply_markup: back,
            });
            return;
          }
          await updatePaymentField(db, p.id, "note", text, actor.id);
          note = "✅ Заметка сохранена";
        } else {
          const error = nameError(text);
          if (error) {
            await ctx.reply(error, { reply_markup: back });
            return;
          }
          await updatePaymentField(db, p.id, "name", text, actor.id);
          note = `✅ Переименовано: ${p.name} → ${text}`;
        }
        await clearState(db, chatId, actor.id);
        const updated = await getPayment(db, p.id);
        const view = updated ? await card(updated, note) : await editList(0, note);
        await ctx.reply(view.text, { reply_markup: view.keyboard, ...NO_PREVIEW });
        return;
      }
    }
  });

  // ---------- Инлайн-кнопки: права проверяются на каждом нажатии ----------

  const work = bot.on("callback_query:data").filter(async (ctx) => {
    if (!/^[aepr]:/.test(ctx.callbackQuery.data)) return false;
    if (canEdit(await getRole(db, ownerId, ctx.from.id))) return true;
    await ctx.answerCallbackQuery({ text: NO_ACCESS, show_alert: true });
    return false;
  });

  // «➕ Добавить»: отмена, подтверждение дубля, список, выбор периода и числа месяца.
  work.callbackQuery(/^a:(cancel|dupok|bulk|per|day):?(\w*)$/, async (ctx) => {
    const chatId = ctx.chat?.id ?? ctx.from.id;
    const userId = ctx.from.id;
    const step = ctx.match[1];
    const arg = ctx.match[2] ?? "";
    const fsm = await getState(db, chatId, userId);

    if (step === "cancel") {
      await clearState(db, chatId, userId);
      await ctx.answerCallbackQuery();
      await show(ctx, "Отменено.");
      return;
    }
    if (step === "bulk" && fsm?.state === "add:name") {
      await setState(db, chatId, userId, "add:bulk");
      await ctx.answerCallbackQuery();
      await show(ctx, { text: ASK_BULK, keyboard: cancelKeyboard() });
      return;
    }
    if (step === "dupok" && fsm?.state === "add:dup") {
      await setState(db, chatId, userId, "add:date", fsm.data);
      await ctx.answerCallbackQuery();
      await show(ctx, { text: ASK_DATE, keyboard: cancelKeyboard() });
      return;
    }

    const { name, date } = fsm?.data ?? {};
    const done = async (period: Period, days: string | null) => {
      await createPayments(db, [{ name: name!, date: date!, period, monthDays: days }], userId);
      await clearState(db, chatId, userId);
      await ctx.answerCallbackQuery();
      await show(ctx, `✅ Добавлено: ${name} — ${formatDate(date!)} (${periodLabel(period, days)})`);
    };

    if (step === "per" && fsm?.state === "add:period" && name && date && PERIODS.includes(arg as Period)) {
      if (arg !== "semimonthly") return done(arg as Period, null);
      // «Дважды в месяц»: первое число берётся из даты, второе выбирается кнопкой.
      await setState(db, chatId, userId, "add:day", { name, date });
      await ctx.answerCallbackQuery();
      await show(ctx, {
        text: `Дважды в месяц: первое число — ${dayOf(date)} (из даты). Выберите второе число месяца:`,
        keyboard: dayKeyboard("a:day:", "a:cancel", dayOf(date)),
      });
      return;
    }
    const day = Number(arg);
    if (step === "day" && fsm?.state === "add:day" && name && date && day >= 1 && day <= 31 && day !== dayOf(date)) {
      return done("semimonthly", monthDays(dayOf(date), day));
    }
    await ctx.answerCallbackQuery({ text: "Действие устарело. Начните заново из меню." });
    await show(ctx, "Отменено.");
  });

  // «✏️ Изменить»: список (и возврат в него из карточки).
  work.callbackQuery(/^e:list:(\d+)$/, async (ctx) => {
    await clearState(db, ctx.chat?.id ?? ctx.from.id, ctx.from.id);
    await ctx.answerCallbackQuery();
    await show(ctx, await editList(Number(ctx.match[1])));
  });

  // Действия с платежом: p:<действие>:<id>[:<аргумент>]
  work.callbackQuery(/^p:(\w+):(\d+)(?::(.+))?$/, async (ctx) => {
    const action = ctx.match[1]!;
    const arg = ctx.match[3];
    const chatId = ctx.chat?.id ?? ctx.from.id;
    const actor: Actor = { id: ctx.from.id, name: ctx.from.first_name };

    const p = await getPayment(db, Number(ctx.match[2]));
    if (!p) {
      await clearState(db, chatId, actor.id);
      await ctx.answerCallbackQuery({ text: "Платёж не найден — возможно, его уже удалили." });
      await show(ctx, await editList());
      return;
    }
    /** Сохранить параметр и вернуться на экран параметров. */
    const saved = async (changed: Partial<Payment>, note: string) => {
      await ctx.answerCallbackQuery({ text: "Сохранено" });
      await show(ctx, await params({ ...p, ...changed }, note));
    };

    // Оплата: по периоду платежа или на другой срок (+1 месяц / квартал / год).
    if (action === "pay" || action in MONTH_BUTTONS) {
      if (arg !== p.due_date) {
        // Кнопка от старой версии карточки (двойное нажатие или кто-то уже отметил).
        await ctx.answerCallbackQuery({ text: "Срок уже изменился — карточка обновлена." });
        await show(ctx, await card(p));
        return;
      }
      const next =
        action === "pay" ? addPeriod(p.due_date, p.period, p.month_days) : addMonths(p.due_date, MONTH_BUTTONS[action]!);
      if (!(await changeDueDate(db, p, next, actor, "paid"))) {
        await ctx.answerCallbackQuery({ text: "Срок уже изменился — откройте платёж заново." });
        await show(ctx, await editList());
        return;
      }
      await ctx.answerCallbackQuery({ text: "Оплата отмечена" });
      if (next) {
        await show(ctx, await card({ ...p, due_date: next }, `✅ Оплачено, следующая ${formatDate(next)}`));
        await notifyGroup(actor, `✅ ${actor.name} отметил оплату: ${p.name} → следующая ${formatDate(next)}`);
      } else {
        await show(ctx, await editList(0, `✅ Оплачено: ${p.name} — разовый платёж перенесён в архив`));
        await notifyGroup(actor, `✅ ${actor.name} отметил оплату: ${p.name} (разовый платёж, в архив)`);
      }
      return;
    }

    switch (action) {
      case "open":
        await clearState(db, chatId, actor.id);
        await ctx.answerCallbackQuery();
        await show(ctx, await card(p));
        return;

      case "undo": {
        const restored = await undoLastPayment(db, p.id, actor);
        if (!restored) {
          await ctx.answerCallbackQuery({ text: "Отменять нечего: после оплаты платёж уже меняли." });
          await show(ctx, await card(p));
          return;
        }
        await ctx.answerCallbackQuery({ text: "Оплата отменена" });
        await show(ctx, await card(restored, `↩️ Оплата отменена, срок снова ${formatDate(restored.due_date)}`));
        await notifyGroup(
          actor,
          `↩️ ${actor.name} отменил отметку об оплате: ${p.name} — снова до ${formatDate(restored.due_date)}`,
        );
        return;
      }

      case "note": {
        await setState(db, chatId, actor.id, "edit:note", { id: p.id });
        await ctx.answerCallbackQuery();
        const keyboard = new InlineKeyboard();
        if (p.note) keyboard.text("Удалить заметку", `p:delnote:${p.id}`).row();
        keyboard.text("↩️ Отмена", `p:open:${p.id}`);
        await show(ctx, {
          text: [
            `${p.name} — заметка${p.note ? `:\n📝 ${p.note}` : " пока пустая."}`,
            "",
            `Напишите текст заметки (до ${NOTE_MAX} символов): где платить, номер договора. Она будет видна в карточке и в напоминании.`,
          ].join("\n"),
          keyboard,
        });
        return;
      }

      case "delnote":
        await updatePaymentField(db, p.id, "note", null, actor.id);
        await clearState(db, chatId, actor.id);
        await ctx.answerCallbackQuery({ text: "Заметка удалена" });
        await show(ctx, await card({ ...p, note: null }, "✅ Заметка удалена"));
        return;

      case "date":
        await setState(db, chatId, actor.id, "edit:date", { id: p.id });
        await ctx.answerCallbackQuery();
        await show(ctx, {
          text: `${p.name} — сейчас оплачено до ${formatDate(p.due_date)}.\nВведите новую дату, например 25.11.2026`,
          keyboard: cancelKeyboard(`p:open:${p.id}`),
        });
        return;

      case "ren":
        await setState(db, chatId, actor.id, "edit:name", { id: p.id });
        await ctx.answerCallbackQuery();
        await show(ctx, {
          text: `Введите новое название для «${p.name}» (до ${NAME_MAX} символов).`,
          keyboard: cancelKeyboard(`p:open:${p.id}`),
        });
        return;

      case "params":
        await ctx.answerCallbackQuery();
        await show(ctx, await params(p));
        return;

      case "per":
        await ctx.answerCallbackQuery();
        await show(ctx, {
          text: `${p.name} — сейчас: ${periodLabel(p.period, p.month_days)}.\nКак часто платится?`,
          keyboard: periodKeyboard(`p:setper:${p.id}:`, `p:params:${p.id}`),
        });
        return;

      case "setper": {
        const period = arg as Period;
        if (!PERIODS.includes(period)) break;
        if (period === "semimonthly") {
          // Второе число выбирается кнопкой; первое — число текущего срока.
          const first = dayOf(p.due_date);
          await ctx.answerCallbackQuery();
          await show(ctx, {
            text: `${p.name} — дважды в месяц: первое число — ${first} (из текущего срока). Выберите второе число месяца:`,
            keyboard: dayKeyboard(`p:setday:${p.id}:`, `p:params:${p.id}`, first),
          });
          return;
        }
        await updatePeriod(db, p.id, period, null, actor.id);
        return saved({ period, month_days: null }, `✅ Период: ${periodLabel(period)}`);
      }

      case "setday": {
        const day = Number(arg);
        const first = dayOf(p.due_date);
        if (!(day >= 1 && day <= 31) || day === first) break;
        const days = monthDays(first, day);
        await updatePeriod(db, p.id, "semimonthly", days, actor.id);
        return saved({ period: "semimonthly", month_days: days }, `✅ Период: ${periodLabel("semimonthly", days)}`);
      }

      case "hour":
        await ctx.answerCallbackQuery();
        await show(ctx, { text: `${p.name} — в котором часу напоминать?`, keyboard: hourKeyboard(p) });
        return;

      case "sethour": {
        const hour = arg === "d" ? null : Number(arg);
        if (hour !== null && !HOUR_CHOICES.includes(hour)) break;
        await updatePaymentField(db, p.id, "remind_hour", hour, actor.id);
        return saved({ remind_hour: hour }, `✅ Напоминание: ${hour === null ? "как в настройках" : `${hour}:00`}`);
      }

      case "warn":
        await ctx.answerCallbackQuery();
        await show(ctx, {
          text: `${p.name} — за сколько дней до срока начинать напоминать?\nАренду удобно за 7–10, мелкую подписку — за 1–2.`,
          keyboard: warnKeyboard(p),
        });
        return;

      case "setwarn": {
        const days = arg === "d" ? null : Number(arg);
        if (days !== null && !PAYMENT_WARN_CHOICES.includes(days)) break;
        await updatePaymentField(db, p.id, "warn_days", days, actor.id);
        return saved({ warn_days: days }, `✅ Предупреждать: ${days === null ? "как в настройках" : `за ${days} дн.`}`);
      }

      case "resp":
        await ctx.answerCallbackQuery();
        await show(ctx, {
          text: `${p.name} — кто отвечает за оплату?\nБот будет упоминать этого человека в напоминании.`,
          keyboard: responsibleKeyboard(p, await listPeople(db, ownerId)),
        });
        return;

      case "setresp": {
        const userId = Number(arg);
        const person = userId ? (await listPeople(db, ownerId)).get(userId) : undefined;
        if (userId && !person) break;
        await updatePaymentField(db, p.id, "responsible_id", userId || null, actor.id);
        return saved({ responsible_id: userId || null }, `✅ Ответственный: ${person?.name ?? "не назначен"}`);
      }

      case "auto": {
        const autopay = p.autopay ? 0 : 1;
        await updatePaymentField(db, p.id, "autopay", autopay, actor.id);
        return saved(
          { autopay },
          autopay
            ? "✅ Автосписание включено: бот напомнит проверить баланс карты, а после даты сам сдвинет срок."
            : "✅ Автосписание выключено: оплату снова нужно отмечать кнопкой.",
        );
      }

      case "cat":
        await ctx.answerCallbackQuery();
        await show(ctx, { text: `${p.name} — выберите категорию:`, keyboard: categoryKeyboard(p) });
        return;

      case "setcat": {
        const category = arg === "n" ? null : CATEGORIES[Number(arg)];
        if (category === undefined) break;
        await updatePaymentField(db, p.id, "category", category, actor.id);
        return saved({ category }, `✅ Категория: ${category ?? "нет"}`);
      }

      case "del":
        // arg: откуда пришли — «c» из карточки, «l» из списка; «Нет» возвращает туда же.
        await ctx.answerCallbackQuery();
        await show(ctx, {
          text: `Точно удалить «${p.name}» (до ${formatDate(p.due_date)})?`,
          keyboard: new InlineKeyboard()
            .text("Да", `p:delyes:${p.id}`)
            .text("Нет", arg === "c" ? `p:open:${p.id}` : "e:list:0"),
        });
        return;

      case "delyes":
        await deletePayment(db, p, actor);
        await clearState(db, chatId, actor.id);
        await ctx.answerCallbackQuery({ text: "Удалено" });
        await show(ctx, await editList(0, `🗑 Удалено: ${p.name}`));
        await notifyOwner(
          actor,
          `${actor.name} удалил платёж: ${p.name} (до ${formatDate(p.due_date)}). Вернуть: ⚙️ Настройки → 🗑 Корзина.`,
        );
        return;
    }
    await ctx.answerCallbackQuery({ text: "Неизвестное действие" });
  });

  // Кнопки под напоминанием: r:<pay|m1|date|undo>:<id>[:<срок>]
  work.callbackQuery(/^r:(pay|m1|date|undo):(\d+)(?::(.+))?$/, async (ctx) => {
    const action = ctx.match[1]!;
    const chat = ctx.chat;
    const chatId = chat?.id ?? ctx.from.id;
    const actor: Actor = { id: ctx.from.id, name: ctx.from.first_name };
    const dropButtons = () => ctx.editMessageReplyMarkup().catch(() => {});

    // Отмена оплаты: возвращает прежний срок и само напоминание с кнопками (разовый платёж — из архива).
    if (action === "undo") {
      const restored = await undoLastPayment(db, Number(ctx.match[2]), actor);
      if (!restored) {
        await ctx.answerCallbackQuery({ text: "Отменять нечего: после оплаты платёж уже меняли." });
        await dropButtons();
        return;
      }
      await ctx.answerCallbackQuery({ text: "Оплата отменена" });
      const warnDays = restored.warn_days ?? (await getWarnDays(db));
      const base =
        reminderText(restored.name, restored.due_date, today(), warnDays, Boolean(restored.autopay)) ??
        `${restored.name} — до ${formatDate(restored.due_date)}`;
      // Упоминание ответственного здесь не повторяем: он уже получил его в самом напоминании.
      await show(ctx, {
        text: `${buildReminder(base, restored).text}\n↩️ Оплата отменена (${actor.name})`,
        keyboard: reminderKeyboard(restored),
      });
      await notifyGroup(
        actor,
        `↩️ ${actor.name} отменил отметку об оплате: ${restored.name} — снова до ${formatDate(restored.due_date)}`,
        chatId,
      );
      return;
    }

    const p = await getPayment(db, Number(ctx.match[2]));
    if (!p) {
      await ctx.answerCallbackQuery({ text: "Этот платёж уже оплачен или удалён." });
      await dropButtons();
      return;
    }

    if (action === "date") {
      const message = ctx.callbackQuery.message;
      if (!chat || chat.type === "private") {
        await setState(db, chatId, actor.id, "edit:date", { id: p.id });
        await ctx.answerCallbackQuery();
        await ctx.reply(`${p.name} — сейчас оплачено до ${formatDate(p.due_date)}.\nВведите новую дату, например 25.11.2026`, {
          reply_markup: cancelKeyboard(),
          ...NO_PREVIEW,
        });
        return;
      }
      // В группе бот видит только ответы на свои сообщения, поэтому просим ответить на это.
      await ctx.answerCallbackQuery();
      const prompt = await ctx.reply(
        `<a href="tg://user?id=${actor.id}">${escapeHtml(actor.name)}</a>, ответьте на это сообщение новой датой для «${escapeHtml(p.name)}», например 25.11.2026`,
        {
          ...threadOf(message),
          parse_mode: "HTML",
          reply_markup: { force_reply: true, selective: true, input_field_placeholder: "25.11.2026" },
          ...NO_PREVIEW,
        },
      );
      await setState(db, chatId, actor.id, "edit:date", {
        id: p.id,
        promptId: prompt.message_id,
        remId: message?.message_id,
      });
      return;
    }

    if (ctx.match[3] !== p.due_date) {
      await ctx.answerCallbackQuery({ text: `Срок уже изменён: до ${formatDate(p.due_date)}.` });
      await dropButtons();
      return;
    }
    const next = action === "pay" ? addPeriod(p.due_date, p.period, p.month_days) : addMonths(p.due_date, 1);
    if (!(await changeDueDate(db, p, next, actor, "paid"))) {
      await ctx.answerCallbackQuery({ text: "Кто-то уже отметил этот платёж." });
      await dropButtons();
      return;
    }
    await ctx.answerCallbackQuery({ text: "Оплата отмечена" });
    const result = next ? `следующая ${formatDate(next)}` : "разовый платёж — в архив";
    await show(ctx, {
      text: `${p.name}\n✅ Оплачено (${actor.name}), ${result}`,
      keyboard: new InlineKeyboard().text("↩️ Отменить оплату", `r:undo:${p.id}`),
    });
    await notifyGroup(
      actor,
      next
        ? `✅ ${actor.name} отметил оплату: ${p.name} → следующая ${formatDate(next)}`
        : `✅ ${actor.name} отметил оплату: ${p.name} (разовый платёж, в архив)`,
      chatId,
    );
  });

  return bot; // ошибки обработчиков ловит и пишет в лог src/index.ts
}
