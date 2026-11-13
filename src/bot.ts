import { Bot, type Context, GrammyError, InlineKeyboard, Keyboard } from "grammy";
import { reminderKeyboard, runCheck, sendCsv, withNote } from "./check";
import { GROUP_HELP, helpText } from "./help";
import { reminderText } from "./reminders";
import { type Env, getConfig } from "./config";
import { addMonths, addPeriod, formatDate, localNow, parseDateInput, type Period, PERIOD_LABELS } from "./dates";
import {
  type Actor,
  changeDueDate,
  clearState,
  createPayment,
  deletePayment,
  deleteSetting,
  deleteUser,
  getHistory,
  getSettings,
  listTrash,
  listUsers,
  restorePayment,
  undoLastPayment,
  setSetting,
  getLastPaid,
  getPayment,
  getRole,
  getSetting,
  getState,
  getUser,
  getWarnDays,
  listPayments,
  type Payment,
  type Role,
  saveAccessRequest,
  setState,
  setUserRole,
  updatePaymentField,
} from "./db";
import {
  accessListView,
  settingsView,
  trashView,
  userCardView,
  WARN_CHOICES,
  cancelKeyboard,
  cardView,
  editListView,
  HOUR_CHOICES,
  hourKeyboard,
  listMessages,
  periodKeyboard,
  PERIODS,
  type View,
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
const MONTH_BUTTONS: Record<string, number> = { m1: 1, m3: 3, m12: 12 };

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

  async function card(p: Payment, note = ""): Promise<View> {
    const [last, history] = await Promise.all([getLastPaid(db, p.id), getHistory(db, p.id)]);
    return cardView(p, last, history, timeZone, note);
  }

  /** Роль и справка под неё — приходит человеку при выдаче или смене доступа. */
  async function welcome(userId: number, role: "admin" | "viewer", intro: string): Promise<void> {
    await bot.api.sendMessage(userId, `${intro}\n\n${helpText(role, await getWarnDays(db))}`, {
      reply_markup: menuKeyboard(role),
      ...NO_PREVIEW,
    });
  }

  /** «✅ Сеня отметил оплату…» — в группу, а пока она не привязана — владельцу. */
  async function notifyPaid(actor: Actor, text: string, fromChatId?: number): Promise<void> {
    const group = await getSetting(db, "group_chat_id");
    const target = group ? Number(group) : ownerId;
    // Не дублируем: владелец сам отметил в личке, или оплату отметили прямо под напоминанием в этом чате.
    if (target === actor.id || target === fromChatId) return;
    try {
      await bot.api.sendMessage(target, text, NO_PREVIEW);
    } catch (err) {
      console.error("Не удалось отправить уведомление об оплате", err);
    }
  }

  // ---------- /start и доступ ----------

  dm.command("start", async (ctx) => {
    const from = ctx.from;
    const role = await getRole(db, ownerId, from.id);
    if (role) {
      await clearState(db, ctx.chat.id, from.id);
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
      for (const text of listMessages(payments, today(), warnDays)) await ctx.reply(text, NO_PREVIEW);
    } else if (item === MENU.add) {
      await setState(db, ctx.chat.id, ctx.from.id, "add:name");
      await ctx.reply(ASK_NAME, { reply_markup: cancelKeyboard() });
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

  ownerOnly.callbackQuery("s:unbind", async (ctx) => {
    const group = await getSetting(db, "group_chat_id");
    await deleteSetting(db, "group_chat_id");
    await deleteSetting(db, "group_title");
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
        await deleteSetting(db, "group_chat_id");
        await deleteSetting(db, "group_title");
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
    await ctx.reply(GROUP_HELP);
    // Рабочая группа одна: из прежней выходим.
    if (bound) await ctx.api.leaveChat(Number(bound)).catch(() => {});
  });

  // Группу превратили в супергруппу — у неё новый chat_id.
  bot.on("message:migrate_to_chat_id", async (ctx) => {
    if ((await getSetting(db, "group_chat_id")) === String(ctx.chat.id)) {
      await setSetting(db, "group_chat_id", String(ctx.message.migrate_to_chat_id));
    }
  });

  // Ответ с новой датой на просьбу бота в группе (кнопка «✏️ Дата» под напоминанием).
  bot.chatType(["group", "supergroup"]).on("message:text", async (ctx) => {
    const replyTo = ctx.message.reply_to_message?.message_id;
    if (!replyTo) return;
    const chatId = ctx.chat.id;
    const actor: Actor = { id: ctx.from.id, name: ctx.from.first_name };
    const fsm = await getState(db, chatId, actor.id);
    if (fsm?.state !== "edit:date" || fsm.data.promptId !== replyTo) return;

    const p = fsm.data.id ? await getPayment(db, fsm.data.id) : null;
    if (!p || !canEdit(await getRole(db, ownerId, actor.id))) {
      await clearState(db, chatId, actor.id);
      if (!p) await ctx.reply("Платёж не найден — возможно, его уже оплатили или удалили.");
      return;
    }
    const parsed = parseDateInput(ctx.message.text, today());
    if (!parsed.ok) {
      const again = await ctx.reply(`${parsed.error}\nОтветьте на это сообщение.`, {
        reply_parameters: { message_id: ctx.message.message_id },
        reply_markup: { force_reply: true, selective: true, input_field_placeholder: "25.11.2026" },
      });
      await setState(db, chatId, actor.id, "edit:date", { ...fsm.data, promptId: again.message_id });
      return;
    }
    if (parsed.date !== p.due_date) await changeDueDate(db, p, parsed.date, actor, "edit_date");
    await clearState(db, chatId, actor.id);
    const done = `✏️ Срок изменён (${actor.name}): ${p.name} — до ${formatDate(parsed.date)}`;
    await ctx.reply(done, NO_PREVIEW);
    if (fsm.data.remId) {
      // Под старым напоминанием кнопки больше не нужны.
      await ctx.api.editMessageText(chatId, fsm.data.remId, done, NO_PREVIEW).catch(() => {});
    }
  });

  // ---------- Текстовый ввод (название и дата) ----------

  dm.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id;
    const actor: Actor = { id: ctx.from.id, name: ctx.from.first_name };
    const role = await getRole(db, ownerId, actor.id);
    if (!role) {
      await ctx.reply("Нет доступа. Нажмите /start, чтобы отправить запрос владельцу.");
      return;
    }
    const fsm = canEdit(role) ? await getState(db, chatId, actor.id) : null;
    if (!fsm) {
      await ctx.reply("Выберите действие в меню ниже.", { reply_markup: menuKeyboard(role) });
      return;
    }
    const text = ctx.message.text.trim();

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

      case "add:dup":
      case "add:period":
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
          if (parsed.date !== p.due_date) await changeDueDate(db, p, parsed.date, actor, "edit_date");
          note = `✅ Дата изменена: ${formatDate(p.due_date)} → ${formatDate(parsed.date)}`;
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

  // «➕ Добавить»: отмена, подтверждение дубля, выбор периода.
  work.callbackQuery(/^a:(cancel|dupok|per):?(\w*)$/, async (ctx) => {
    const chatId = ctx.chat?.id ?? ctx.from.id;
    const userId = ctx.from.id;
    const step = ctx.match[1];
    const fsm = await getState(db, chatId, userId);

    if (step === "cancel") {
      await clearState(db, chatId, userId);
      await ctx.answerCallbackQuery();
      await show(ctx, "Отменено.");
      return;
    }
    if (step === "dupok" && fsm?.state === "add:dup") {
      await setState(db, chatId, userId, "add:date", fsm.data);
      await ctx.answerCallbackQuery();
      await show(ctx, { text: ASK_DATE, keyboard: cancelKeyboard() });
      return;
    }
    const period = ctx.match[2] as Period;
    if (step === "per" && fsm?.state === "add:period" && fsm.data.name && fsm.data.date && PERIODS.includes(period)) {
      await createPayment(db, fsm.data.name, fsm.data.date, period, userId);
      await clearState(db, chatId, userId);
      await ctx.answerCallbackQuery();
      await show(ctx, `✅ Добавлено: ${fsm.data.name} — ${formatDate(fsm.data.date)} (${PERIOD_LABELS[period]})`);
      return;
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

    // Оплата: по периоду платежа или на другой срок (+1 месяц / квартал / год).
    if (action === "pay" || action in MONTH_BUTTONS) {
      if (arg !== p.due_date) {
        // Кнопка от старой версии карточки (двойное нажатие или кто-то уже отметил).
        await ctx.answerCallbackQuery({ text: "Срок уже изменился — карточка обновлена." });
        await show(ctx, await card(p));
        return;
      }
      const next = action === "pay" ? addPeriod(p.due_date, p.period) : addMonths(p.due_date, MONTH_BUTTONS[action]!);
      if (!(await changeDueDate(db, p, next, actor, "paid"))) {
        await ctx.answerCallbackQuery({ text: "Срок уже изменился — откройте платёж заново." });
        await show(ctx, await editList());
        return;
      }
      await ctx.answerCallbackQuery({ text: "Оплата отмечена" });
      if (next) {
        await show(ctx, await card({ ...p, due_date: next }, `✅ Оплачено, следующая ${formatDate(next)}`));
        await notifyPaid(actor, `✅ ${actor.name} отметил оплату: ${p.name} → следующая ${formatDate(next)}`);
      } else {
        await show(ctx, await editList(0, `✅ Оплачено: ${p.name} — разовый платёж перенесён в архив`));
        await notifyPaid(actor, `✅ ${actor.name} отметил оплату: ${p.name} (разовый платёж, в архив)`);
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
        await notifyPaid(
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
            `Напишите текст заметки (до ${NOTE_MAX} символов): где платить, номер договора, кто отвечает. Она будет видна в карточке и в напоминании.`,
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

      case "per":
        await ctx.answerCallbackQuery();
        await show(ctx, {
          text: `${p.name} — сейчас: ${PERIOD_LABELS[p.period]}.\nКак часто платится?`,
          keyboard: periodKeyboard(`p:setper:${p.id}:`, `p:open:${p.id}`),
        });
        return;

      case "setper": {
        const period = arg as Period;
        if (!PERIODS.includes(period)) break;
        await updatePaymentField(db, p.id, "period", period, actor.id);
        await ctx.answerCallbackQuery();
        await show(ctx, await card({ ...p, period }, `✅ Период: ${PERIOD_LABELS[period]}`));
        return;
      }

      case "hour":
        await ctx.answerCallbackQuery();
        await show(ctx, {
          text: `${p.name} — в котором часу напоминать?\nСейчас: ${p.remind_hour === null ? "как в настройках" : `${p.remind_hour}:00`}`,
          keyboard: hourKeyboard(p),
        });
        return;

      case "sethour": {
        const hour = arg === "d" ? null : Number(arg);
        if (hour !== null && !HOUR_CHOICES.includes(hour)) break;
        await updatePaymentField(db, p.id, "remind_hour", hour, actor.id);
        await ctx.answerCallbackQuery();
        await show(
          ctx,
          await card({ ...p, remind_hour: hour }, `✅ Напоминание: ${hour === null ? "как в настройках" : `${hour}:00`}`),
        );
        return;
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
        return;
    }
    await ctx.answerCallbackQuery({ text: "Неизвестное действие" });
  });

  // Кнопки под напоминанием: r:<pay|m1|date>:<id>[:<срок>]
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
      const reminder =
        reminderText(restored.name, restored.due_date, today(), await getWarnDays(db)) ??
        `${restored.name} — до ${formatDate(restored.due_date)}`;
      await show(ctx, {
        text: `${withNote(reminder, restored)}\n↩️ Оплата отменена (${actor.name})`,
        keyboard: reminderKeyboard(restored),
      });
      await notifyPaid(
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
      const remId = ctx.callbackQuery.message?.message_id;
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
          parse_mode: "HTML",
          reply_markup: { force_reply: true, selective: true, input_field_placeholder: "25.11.2026" },
          ...NO_PREVIEW,
        },
      );
      await setState(db, chatId, actor.id, "edit:date", { id: p.id, promptId: prompt.message_id, remId });
      return;
    }

    if (ctx.match[3] !== p.due_date) {
      await ctx.answerCallbackQuery({ text: `Срок уже изменён: до ${formatDate(p.due_date)}.` });
      await dropButtons();
      return;
    }
    const next = action === "pay" ? addPeriod(p.due_date, p.period) : addMonths(p.due_date, 1);
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
    await notifyPaid(
      actor,
      next
        ? `✅ ${actor.name} отметил оплату: ${p.name} → следующая ${formatDate(next)}`
        : `✅ ${actor.name} отметил оплату: ${p.name} (разовый платёж, в архив)`,
      chatId,
    );
  });

  return bot; // ошибки обработчиков ловит и пишет в лог src/index.ts
}
