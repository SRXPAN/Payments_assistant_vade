// Тексты и клавиатуры всех экранов бота. Без обращений к базе и Telegram — только отрисовка.
import { InlineKeyboard } from "grammy";
import {
  addPeriod,
  COLOR_EMOJI,
  formatDate,
  type ISODate,
  listLine,
  localNow,
  paymentStatus,
  type PaymentStatus,
  type Period,
  PERIOD_LABELS,
  periodLabel,
} from "./dates";
import type { HistoryItem, LastPaid, Payment, Person, TrashItem, UserRow } from "./db";

export interface View {
  text: string;
  keyboard: InlineKeyboard;
}

export const MESSAGE_LIMIT = 4096;
const PAGE_SIZE = 40; // 2 кнопки в строке, лимит Telegram — 100 кнопок на сообщение
const BUTTON_NAME_MAX = 28;
export const PERIODS: Period[] = ["monthly", "quarterly", "yearly", "biweekly", "semimonthly", "once"];
export const HOUR_CHOICES = [9, 10, 12];
/** Общий запас дней в настройках. */
export const WARN_CHOICES = [3, 4, 5, 7];
/** Свой запас дней у платежа: от мелкой подписки до аренды. */
export const PAYMENT_WARN_CHOICES = [1, 2, 3, 5, 7, 10, 14];
export const CATEGORIES = ["Подписки", "Зарплаты", "Аренда", "Коммунальные", "Налоги", "Прочее"];
export const CANCEL = "↩️ Отмена";
const BACK = "↩️ Назад";

export function truncate(text: string, max = BUTTON_NAME_MAX): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const withNote = (note: string, body: string) => (note ? `${note}\n\n${body}` : body);

/** Статус платежа с учётом его собственного запаса дней и автосписания. */
export function statusOf(p: Payment, today: ISODate, warnDays: number): PaymentStatus {
  return paymentStatus(p.due_date, today, p.warn_days ?? warnDays, !p.autopay);
}

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

// ---------- 📋 Список ----------

/** «📋 Список»: одно сообщение, при длине больше лимита — несколько. */
export function listMessages(payments: Payment[], today: ISODate, warnDays: number, title = "📋 Платежи"): string[] {
  if (payments.length === 0) return [title === "📋 Платежи" ? "📋 Платежей пока нет." : `${title}: платежей нет.`];
  return chunkLines([
    `${title} (${payments.length}):`,
    ...payments.map((p) => listLine(p.name, p.due_date, today, p.warn_days ?? warnDays, Boolean(p.autopay))),
  ]);
}

/** Кнопка под списком появляется, когда хотя бы у одного платежа есть категория. */
export function listKeyboard(payments: Payment[]): InlineKeyboard | undefined {
  return payments.some((p) => p.category) ? new InlineKeyboard().text("🏷 По категориям", "l:cats") : undefined;
}

/** Выбор категории для просмотра: только категории, в которых есть платежи. */
export function categoriesView(payments: Payment[]): View {
  const keyboard = new InlineKeyboard();
  CATEGORIES.forEach((category, index) => {
    const count = payments.filter((p) => p.category === category).length;
    if (count) keyboard.text(`${category} (${count})`, `l:cat:${index}`).row();
  });
  const rest = payments.filter((p) => !p.category || !CATEGORIES.includes(p.category)).length;
  if (rest) keyboard.text(`Без категории (${rest})`, "l:cat:n").row();
  keyboard.text(`Все платежи (${payments.length})`, "l:all");
  return { text: "🏷 Какую категорию показать?", keyboard };
}

/** Список одним сообщением (для показа по кнопке): лишнее обрезается с пометкой. */
export function singleListView(payments: Payment[], today: ISODate, warnDays: number, title: string, all: Payment[]): View {
  const chunks = listMessages(payments, today, warnDays, title);
  let text = chunks[0]!;
  if (chunks.length > 1) {
    const shown = text.split("\n").length - 1;
    text += `\n… и ещё ${payments.length - shown}. Весь список — кнопкой «📋 Список».`;
  }
  return { text, keyboard: listKeyboard(all) ?? new InlineKeyboard() };
}

/** Платежи выбранной категории; key — индекс в CATEGORIES или «n» (без категории). */
export function filterByCategory(payments: Payment[], key: string): { title: string; items: Payment[] } | null {
  if (key === "n") {
    return { title: "📋 Без категории", items: payments.filter((p) => !p.category || !CATEGORIES.includes(p.category)) };
  }
  const category = CATEGORIES[Number(key)];
  return category ? { title: `📋 ${category}`, items: payments.filter((p) => p.category === category) } : null;
}

/** Поиск по названию, заметке и категории. */
export function searchPayments(payments: Payment[], query: string): Payment[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return payments.filter((p) => [p.name, p.note, p.category].some((field) => field?.toLowerCase().includes(q)));
}

// ---------- ✏️ Изменить ----------

/** Строка на платёж — [статус + название] [🗑]. */
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
    const emoji = COLOR_EMOJI[statusOf(p, today, warnDays).color];
    keyboard.text(`${emoji} ${truncate(p.name)}`, `p:open:${p.id}`).text("🗑", `p:del:${p.id}:l`).row();
  }
  if (pages > 1) {
    if (current > 0) keyboard.text("‹ Назад", `e:list:${current - 1}`);
    if (current < pages - 1) keyboard.text("Дальше ›", `e:list:${current + 1}`);
  }
  const title = payments.length
    ? `✏️ Выберите платёж${pages > 1 ? ` (стр. ${current + 1} из ${pages})` : ""}:`
    : "Платежей пока нет. Добавьте первый кнопкой «➕ Добавить».";
  return { text: withNote(note, title), keyboard };
}

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

export interface CardExtras {
  last: LastPaid | null;
  history: HistoryItem[];
  timeZone: string;
  /** Имя ответственного, если он назначен и ещё есть в списке людей. */
  responsible?: string | null;
  note?: string;
}

/** Карточка платежа: главное — оплата и срок; редкие настройки спрятаны в «⚙️ Параметры». */
export function cardView(p: Payment, x: CardExtras): View {
  const lines: string[] = [];
  if (x.note) lines.push(x.note, "");
  lines.push(`${p.name} — оплата до ${formatDate(p.due_date)} (${periodLabel(p.period, p.month_days)})`);
  if (x.last) {
    lines.push(`Последняя оплата: ${logDate(x.last.created_at, x.timeZone)}, отметил ${x.last.user_name}`);
  } else {
    lines.push("Последняя оплата: ещё не отмечали");
  }
  if (p.autopay) lines.push("💳 Автосписание: после даты срок сдвигается сам");
  if (x.responsible) lines.push(`👤 Ответственный: ${x.responsible}`);
  if (p.category) lines.push(`🏷 ${p.category}`);
  if (p.remind_hour !== null) lines.push(`⏰ Напоминание в ${p.remind_hour}:00`);
  if (p.warn_days !== null) lines.push(`🔔 Предупреждать за ${p.warn_days} дн.`);
  if (p.note) lines.push(`📝 ${p.note}`);
  if (x.history.length) {
    lines.push("", "История (последние записи):", ...x.history.map((h) => historyLine(h, x.timeZone)), "");
  }
  lines.push("Что сделать?");

  const next = addPeriod(p.due_date, p.period, p.month_days);
  const due = p.due_date;
  const keyboard = new InlineKeyboard()
    .text(next ? `✅ Оплатил → до ${formatDate(next)}` : "✅ Оплатил → в архив", `p:pay:${p.id}:${due}`)
    .row();
  if (canUndo(p, x.history)) keyboard.text("↩️ Отменить оплату", `p:undo:${p.id}`).row();
  keyboard
    .text("📅 +1 месяц", `p:m1:${p.id}:${due}`)
    .text("📅 +1 квартал", `p:m3:${p.id}:${due}`)
    .text("📅 +1 год", `p:m12:${p.id}:${due}`)
    .row()
    .text("✏️ Изменить дату", `p:date:${p.id}`)
    .text("🔤 Переименовать", `p:ren:${p.id}`)
    .row()
    .text("📝 Заметка", `p:note:${p.id}`)
    .text("⚙️ Параметры", `p:params:${p.id}`)
    .row()
    .text("🗑 Удалить", `p:del:${p.id}:c`)
    .text(CANCEL, "e:list:0");
  return { text: lines.join("\n"), keyboard };
}

export interface ParamsExtras {
  /** Общие значения из настроек — показываются, когда у платежа своих нет. */
  warnDays: number;
  hour: number;
  responsible?: string | null;
  note?: string;
}

/** «⚙️ Параметры» платежа: период, время, запас дней, ответственный, автосписание, категория. */
export function paramsView(p: Payment, x: ParamsExtras): View {
  const lines = [
    `${p.name} — параметры`,
    `🔁 Период: ${periodLabel(p.period, p.month_days)}`,
    `⏰ Напоминать в: ${p.remind_hour === null ? `${x.hour}:00 (как в настройках)` : `${p.remind_hour}:00`}`,
    `🔔 Предупреждать за: ${p.warn_days === null ? `${x.warnDays} дн. (как в настройках)` : `${p.warn_days} дн.`}`,
    `👤 Ответственный: ${x.responsible ?? "не назначен"}`,
    `💳 Автосписание: ${p.autopay ? "включено — после даты срок сдвигается сам" : "выключено"}`,
    `🏷 Категория: ${p.category ?? "нет"}`,
  ];
  const keyboard = new InlineKeyboard()
    .text("🔁 Период", `p:per:${p.id}`)
    .text("⏰ Время", `p:hour:${p.id}`)
    .row()
    .text("🔔 За сколько дней", `p:warn:${p.id}`)
    .text("👤 Ответственный", `p:resp:${p.id}`)
    .row()
    .text(p.autopay ? "💳 Автосписание: вкл" : "💳 Автосписание: выкл", `p:auto:${p.id}`)
    .text("🏷 Категория", `p:cat:${p.id}`)
    .row()
    .text(BACK, `p:open:${p.id}`);
  return { text: withNote(x.note ?? "", lines.join("\n")), keyboard };
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

/** Числа месяца 1–31 для периода «дважды в месяц»; exclude — уже занятое первое число. */
export function dayKeyboard(prefix: string, cancelData: string, exclude: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  let inRow = 0;
  for (let day = 1; day <= 31; day++) {
    if (day === exclude) continue;
    kb.text(String(day), `${prefix}${day}`);
    if (++inRow % 6 === 0) kb.row();
  }
  return kb.row().text(CANCEL, cancelData);
}

export function hourKeyboard(p: Payment): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const hour of HOUR_CHOICES) kb.text(`${hour}:00`, `p:sethour:${p.id}:${hour}`);
  return kb.row().text("Как в настройках", `p:sethour:${p.id}:d`).row().text(BACK, `p:params:${p.id}`);
}

export function warnKeyboard(p: Payment): InlineKeyboard {
  const kb = new InlineKeyboard();
  PAYMENT_WARN_CHOICES.forEach((days, i) => {
    kb.text(`${days} дн.`, `p:setwarn:${p.id}:${days}`);
    if (i === 3) kb.row();
  });
  return kb.row().text("Как в настройках", `p:setwarn:${p.id}:d`).row().text(BACK, `p:params:${p.id}`);
}

export function responsibleKeyboard(p: Payment, people: Map<number, Person>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const [id, person] of people) {
    kb.text(`${id === p.responsible_id ? "✅ " : ""}${truncate(person.name)}`, `p:setresp:${p.id}:${id}`).row();
  }
  return kb.text("Никто", `p:setresp:${p.id}:0`).row().text(BACK, `p:params:${p.id}`);
}

export function categoryKeyboard(p: Payment): InlineKeyboard {
  const kb = new InlineKeyboard();
  CATEGORIES.forEach((category, i) => {
    kb.text(`${category === p.category ? "✅ " : ""}${category}`, `p:setcat:${p.id}:${i}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text("Без категории", `p:setcat:${p.id}:n`).row().text(BACK, `p:params:${p.id}`);
}

// ---------- ⚙️ Настройки ----------

export function settingsView(s: Record<string, string | undefined>, note = ""): View {
  const warn = Number(s.warn_days) || 4;
  const hour = Number(s.check_hour) || 12;
  const quiet = s.quiet_weekends !== "0";
  const mark = (on: boolean, label: string) => (on ? `✅ ${label}` : label);

  const keyboard = new InlineKeyboard();
  for (const days of WARN_CHOICES) keyboard.text(mark(days === warn, `${days} дн.`), `s:days:${days}`);
  keyboard.row();
  for (const h of HOUR_CHOICES) keyboard.text(mark(h === hour, `${h}:00`), `s:hour:${h}`);
  keyboard.row();
  keyboard.text(quiet ? "🔕 Выходные: не беспокоить" : "🔔 Выходные: напоминать", "s:quiet").row();
  if (s.group_chat_id) {
    keyboard.text("Отвязать группу", "s:unbind");
    if (s.group_thread_id) keyboard.text("Сбросить тему", "s:notopic");
    keyboard.row();
  }
  keyboard.text("🧪 Проверить сейчас", "s:test").text("📤 Экспорт CSV", "s:csv").row().text("🗑 Корзина", "s:trash");

  let group = "Группа: не привязана — напоминания приходят вам в личку. Чтобы привязать, добавьте бота в группу.";
  if (s.group_chat_id) {
    group = `Группа: ${s.group_title || "привязана"}${s.group_thread_id ? ", пишу в выбранную тему" : ""}`;
  }
  const lines = [
    "⚙️ Настройки",
    `Предупреждать за: ${warn} дн.`,
    `Время проверки: ${hour}:00`,
    quiet
      ? "В выходные и праздники: не беспокою (кроме автосписаний)"
      : "В выходные и праздники: напоминаю как обычно",
    group,
    "",
    "Верхний ряд кнопок — за сколько дней предупреждать, второй — время проверки.",
  ];
  return { text: withNote(note, lines.join("\n")), keyboard };
}

/** Корзина: удалённые и архивные платежи, нажатие возвращает платёж в список. */
export function trashView(items: TrashItem[], note = ""): View {
  const keyboard = new InlineKeyboard();
  for (const item of items) {
    const kind = item.deleted ? "удалён" : "архив";
    keyboard.text(`♻️ ${truncate(item.name, 24)} — ${kind}`, `s:restore:${item.id}`).row();
  }
  keyboard.text(BACK, "s:back");
  const body = items.length
    ? "🗑 Корзина\nУдалённые и архивные (оплаченные разовые) платежи. Нажмите на платёж, чтобы вернуть его в список:"
    : "🗑 Корзина пуста.";
  return { text: withNote(note, body), keyboard };
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
  return { text: withNote(note, body), keyboard };
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
  keyboard.text(BACK, "u:list");
  return { text: withNote(note, `${userTitle(u)}\nРоль: ${USER_ROLE_LABELS[u.role]}`), keyboard };
}

export function cancelKeyboard(data = "a:cancel"): InlineKeyboard {
  return new InlineKeyboard().text(CANCEL, data);
}
