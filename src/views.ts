// Тексты и клавиатуры разделов «Список», «Добавить», «Изменить».
import { InlineKeyboard } from "grammy";
import {
  addPeriod,
  COLOR_EMOJI,
  formatDate,
  type ISODate,
  listLine,
  localNow,
  paymentStatus,
  type Period,
  PERIOD_LABELS,
} from "./dates";
import type { HistoryItem, LastPaid, Payment, TrashItem, UserRow } from "./db";

export interface View {
  text: string;
  keyboard: InlineKeyboard;
}

export const MESSAGE_LIMIT = 4096;
const PAGE_SIZE = 40; // 2 кнопки в строке, лимит Telegram — 100 кнопок на сообщение
const BUTTON_NAME_MAX = 28;
export const PERIODS: Period[] = ["monthly", "quarterly", "yearly", "biweekly", "once"];
export const HOUR_CHOICES = [9, 10, 12];
export const CANCEL = "↩️ Отмена";

export function truncate(text: string, max = BUTTON_NAME_MAX): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Собирает строки в сообщения не длиннее лимита Telegram. */
export function chunkLines(lines: string[], limit = MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + 1 + line.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** «📋 Список»: одно сообщение, при длине больше лимита — несколько. */
export function listMessages(payments: Payment[], today: ISODate, warnDays: number): string[] {
  if (payments.length === 0) return ["📋 Платежей пока нет."];
  return chunkLines([
    `📋 Платежи (${payments.length}):`,
    ...payments.map((p) => listLine(p.name, p.due_date, today, warnDays)),
  ]);
}

/** «✏️ Изменить»: строка на платёж — [статус + название] [🗑]. */
export function editListView(
  payments: Payment[],
  today: ISODate,
  warnDays: number,
  page = 0,
  note = "",
): View {
  const pages = Math.max(1, Math.ceil(payments.length / PAGE_SIZE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const keyboard = new InlineKeyboard();
  for (const p of payments.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)) {
    const emoji = COLOR_EMOJI[paymentStatus(p.due_date, today, warnDays).color];
    keyboard.text(`${emoji} ${truncate(p.name)}`, `p:open:${p.id}`).text("🗑", `p:del:${p.id}:l`).row();
  }
  if (pages > 1) {
    if (current > 0) keyboard.text("‹ Назад", `e:list:${current - 1}`);
    if (current < pages - 1) keyboard.text("Дальше ›", `e:list:${current + 1}`);
  }
  const title = payments.length
    ? `✏️ Выберите платёж${pages > 1 ? ` (стр. ${current + 1} из ${pages})` : ""}:`
    : "Платежей пока нет. Добавьте первый кнопкой «➕ Добавить».";
  return { text: note ? `${note}\n\n${title}` : title, keyboard };
}

/** Карточка платежа со всеми действиями. */
const logDate = (createdAt: string, timeZone: string) =>
  formatDate(localNow(new Date(`${createdAt.replace(" ", "T")}Z`), timeZone).date);

function historyLine(h: HistoryItem, timeZone: string): string {
  const fmt = (d: ISODate | null) => (d ? formatDate(d) : "—");
  let what: string;
  switch (h.action) {
    case "paid":
      what = `оплата, срок ${fmt(h.old_date)} → ${h.new_date ? fmt(h.new_date) : "архив"}${h.undone ? " (отменена)" : ""}`;
      break;
    case "edit_date":
      what = `срок изменён ${fmt(h.old_date)} → ${fmt(h.new_date)}`;
      break;
    case "undo":
      what = `оплата отменена, срок снова ${fmt(h.new_date)}`;
      break;
    case "restore":
      what = "восстановлен из корзины";
      break;
    case "delete":
      what = "удалён";
      break;
  }
  return `• ${logDate(h.created_at, timeZone)} ${h.user_name}: ${what}`;
}

/** Последнюю оплату можно отменить, пока после неё с платежом ничего не делали. */
export function canUndo(p: Payment, history: HistoryItem[]): boolean {
  const last = history[0];
  return Boolean(last && last.action === "paid" && !last.undone && last.new_date === p.due_date);
}

export function cardView(
  p: Payment,
  last: LastPaid | null,
  history: HistoryItem[],
  timeZone: string,
  note = "",
): View {
  const lines: string[] = [];
  if (note) lines.push(note, "");
  lines.push(`${p.name} — оплата до ${formatDate(p.due_date)} (${PERIOD_LABELS[p.period]})`);
  if (last) {
    lines.push(`Последняя оплата: ${logDate(last.created_at, timeZone)}, отметил ${last.user_name}`);
  } else {
    lines.push("Последняя оплата: ещё не отмечали");
  }
  if (p.remind_hour !== null) lines.push(`Напоминание в ${p.remind_hour}:00`);
  if (p.note) lines.push(`📝 ${p.note}`);
  if (history.length) lines.push("", "История (последние записи):", ...history.map((h) => historyLine(h, timeZone)), "");
  lines.push("Что сделать?");

  const next = addPeriod(p.due_date, p.period);
  const due = p.due_date;
  const keyboard = new InlineKeyboard()
    .text(next ? `✅ Оплатил → до ${formatDate(next)}` : "✅ Оплатил → в архив", `p:pay:${p.id}:${due}`)
    .row();
  if (canUndo(p, history)) keyboard.text("↩️ Отменить оплату", `p:undo:${p.id}`).row();
  keyboard
    .text("📅 +1 месяц", `p:m1:${p.id}:${due}`)
    .text("📅 +1 квартал", `p:m3:${p.id}:${due}`)
    .text("📅 +1 год", `p:m12:${p.id}:${due}`)
    .row()
    .text("✏️ Изменить дату", `p:date:${p.id}`)
    .text("🔤 Переименовать", `p:ren:${p.id}`)
    .row()
    .text("🔁 Период", `p:per:${p.id}`)
    .text("⏰ Время", `p:hour:${p.id}`)
    .row()
    .text("📝 Заметка", `p:note:${p.id}`)
    .text("🗑 Удалить", `p:del:${p.id}:c`)
    .row()
    .text(CANCEL, "e:list:0");
  return { text: lines.join("\n"), keyboard };
}

/** Кнопки периодов: prefix + код периода, внизу «Отмена». */
export function periodKeyboard(prefix: string, cancelData: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  PERIODS.forEach((period, i) => {
    kb.text(capitalize(PERIOD_LABELS[period]), `${prefix}${period}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text(CANCEL, cancelData);
}

export function hourKeyboard(p: Payment): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const hour of HOUR_CHOICES) kb.text(`${hour}:00`, `p:sethour:${p.id}:${hour}`);
  return kb.row().text("Как в настройках", `p:sethour:${p.id}:d`).row().text(CANCEL, `p:open:${p.id}`);
}

// ---------- ⚙️ Настройки ----------

export const WARN_CHOICES = [3, 4, 5, 7];

export function settingsView(s: Record<string, string | undefined>, note = ""): View {
  const warn = Number(s.warn_days) || 4;
  const hour = Number(s.check_hour) || 12;
  const mark = (on: boolean, label: string) => (on ? `✅ ${label}` : label);

  const keyboard = new InlineKeyboard();
  for (const days of WARN_CHOICES) keyboard.text(mark(days === warn, `${days} дн.`), `s:days:${days}`);
  keyboard.row();
  for (const h of HOUR_CHOICES) keyboard.text(mark(h === hour, `${h}:00`), `s:hour:${h}`);
  keyboard.row();
  if (s.group_chat_id) keyboard.text("Отвязать группу", "s:unbind").row();
  keyboard.text("🧪 Проверить сейчас", "s:test").text("📤 Экспорт CSV", "s:csv").row().text("🗑 Корзина", "s:trash");

  const group = s.group_chat_id
    ? `Группа: ${s.group_title || "привязана"}`
    : "Группа: не привязана — напоминания приходят вам в личку. Чтобы привязать, добавьте бота в группу.";
  const lines = [
    "⚙️ Настройки",
    `Предупреждать за: ${warn} дн.`,
    `Время проверки: ${hour}:00`,
    group,
    "",
    "Верхний ряд кнопок — за сколько дней предупреждать, второй — время проверки.",
  ];
  return { text: note ? `${note}\n\n${lines.join("\n")}` : lines.join("\n"), keyboard };
}

/** Корзина: удалённые и архивные платежи, нажатие возвращает платёж в список. */
export function trashView(items: TrashItem[], note = ""): View {
  const keyboard = new InlineKeyboard();
  for (const item of items) {
    const kind = item.deleted ? "удалён" : "архив";
    keyboard.text(`♻️ ${truncate(item.name, 24)} — ${kind}`, `s:restore:${item.id}`).row();
  }
  keyboard.text("↩️ Назад", "s:back");
  const body = items.length
    ? "🗑 Корзина\nУдалённые и архивные (оплаченные разовые) платежи. Нажмите на платёж, чтобы вернуть его в список:"
    : "🗑 Корзина пуста.";
  return { text: note ? `${note}\n\n${body}` : body, keyboard };
}

// ---------- 👥 Доступ ----------

const USER_ROLE_LABELS: Record<UserRow["role"], string> = {
  admin: "админ",
  viewer: "наблюдатель",
  pending: "ждёт решения",
  rejected: "нет доступа",
};

export function userTitle(u: { name: string; username: string | null; id: number }): string {
  return `${u.name} (${u.username ? `@${u.username}, ` : ""}${u.id})`;
}

export function accessListView(users: UserRow[], note = ""): View {
  const keyboard = new InlineKeyboard();
  for (const u of users) {
    const icon = u.role === "pending" ? "⏳ " : u.role === "rejected" ? "🚫 " : "";
    keyboard.text(`${icon}${truncate(u.name)} — ${USER_ROLE_LABELS[u.role]}`, `u:open:${u.id}`).row();
  }
  const body = users.length
    ? "👥 Доступ\nВладелец — вы. Выберите человека, чтобы изменить роль:"
    : "👥 Доступ\nВладелец — вы. Больше ни у кого доступа нет: человек должен нажать Start у бота, и вам придёт запрос.";
  return { text: note ? `${note}\n\n${body}` : body, keyboard };
}

export function userCardView(u: UserRow, note = ""): View {
  const keyboard = new InlineKeyboard();
  if (u.role !== "admin") keyboard.text("Сделать админом", `u:set:${u.id}:admin`).row();
  if (u.role !== "viewer") keyboard.text("Сделать наблюдателем", `u:set:${u.id}:viewer`).row();
  if (u.role === "rejected") {
    // «Удалить из списка» снимает блокировку: человек сможет снова отправить запрос.
    keyboard.text("Удалить из списка", `u:forget:${u.id}`).row();
  } else {
    keyboard.text(u.role === "pending" ? "Отклонить" : "Забрать доступ", `u:revoke:${u.id}`).row();
  }
  keyboard.text("↩️ Назад", "u:list");
  const body = `${userTitle(u)}\nРоль: ${USER_ROLE_LABELS[u.role]}`;
  return { text: note ? `${note}\n\n${body}` : body, keyboard };
}

export function cancelKeyboard(data = "a:cancel"): InlineKeyboard {
  return new InlineKeyboard().text(CANCEL, data);
}
