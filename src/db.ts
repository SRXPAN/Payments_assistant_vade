import { effectiveDeadline, type ISODate, type Period } from "./dates";

/** «owner» в таблице — совладелец; главный владелец задан в конфигурации и в таблице не хранится. */
export type StoredRole = "owner" | "admin" | "viewer" | "pending" | "rejected";
export type Role = "owner" | "admin" | "viewer";

export interface UserRow {
  id: number;
  name: string;
  username: string | null;
  role: StoredRole;
}

/** Кто выполняет действие: id и имя из Telegram на этот момент. */
export interface Actor {
  id: number;
  name: string;
}

// ---------- Пользователи ----------

export function getUser(db: D1Database, id: number): Promise<UserRow | null> {
  return db.prepare("SELECT id, name, username, role FROM users WHERE id = ?").bind(id).first<UserRow>();
}

/** Роль с доступом или null (нет записи, запрос ждёт решения или отклонён). */
export async function getRole(db: D1Database, ownerIds: number[], userId: number): Promise<Role | null> {
  if (ownerIds.includes(userId)) return "owner";
  const user = await getUser(db, userId);
  return user && (user.role === "owner" || user.role === "admin" || user.role === "viewer") ? user.role : null;
}

/** Все владельцы: из конфигурации и совладельцы из таблицы. Им приходят запросы доступа и уведомления. */
export async function listOwnerIds(db: D1Database, ownerIds: number[]): Promise<number[]> {
  const res = await db.prepare("SELECT id FROM users WHERE role = 'owner'").all<{ id: number }>();
  return [...new Set([...ownerIds, ...res.results.map((r) => r.id)])];
}

export async function saveAccessRequest(
  db: D1Database,
  id: number,
  name: string,
  username: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, name, username, role) VALUES (?, ?, ?, 'pending')
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, username = excluded.username,
         role = 'pending', updated_at = datetime('now')`,
    )
    .bind(id, name, username)
    .run();
}

/** Возвращает false, если пользователя нет в таблице. */
export async function setUserRole(db: D1Database, id: number, role: StoredRole): Promise<boolean> {
  const res = await db
    .prepare("UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(role, id)
    .run();
  return res.meta.changes > 0;
}

/** Все: кто ждёт решения, у кого есть доступ и кому отказано. */
export async function listUsers(db: D1Database): Promise<UserRow[]> {
  const res = await db
    .prepare(
      `SELECT id, name, username, role FROM users
       ORDER BY CASE role WHEN 'pending' THEN 0 WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'viewer' THEN 3 ELSE 4 END, name`,
    )
    .all<UserRow>();
  return res.results;
}

export async function deleteUser(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM users WHERE id = ?").bind(id),
    db.prepare("DELETE FROM fsm WHERE user_id = ?").bind(id),
  ]);
}

// ---------- Экспорт ----------

export interface ExportPayment {
  id: number;
  name: string;
  due_date: ISODate;
  period: Period;
  month_days: string | null;
  remind_hour: number | null;
  warn_days: number | null;
  responsible: string | null;
  autopay: number;
  category: string | null;
  note: string | null;
  archived: number;
  deleted: number;
  created_at: string;
  updated_at: string;
}

export type LogAction = "paid" | "edit_date" | "delete" | "undo" | "restore";

export interface ExportLog {
  id: number;
  payment_id: number;
  name: string;
  user_name: string;
  user_id: number;
  action: LogAction;
  old_date: ISODate | null;
  new_date: ISODate | null;
  undone: number;
  created_at: string;
}

/** Все платежи, включая архивные и удалённые. */
export async function exportPayments(db: D1Database): Promise<ExportPayment[]> {
  const res = await db
    .prepare(
      `SELECT p.id, p.name, p.due_date, p.period, p.month_days, p.remind_hour, p.warn_days,
              CASE WHEN p.responsible_id IS NULL THEN NULL
                   ELSE COALESCE(u.name, 'id ' || p.responsible_id) END AS responsible, p.autopay, p.category, p.note, p.archived, p.deleted, p.created_at, p.updated_at
       FROM payments p LEFT JOIN users u ON u.id = p.responsible_id
       ORDER BY p.deleted, p.archived, p.due_date, p.name`,
    )
    .all<ExportPayment>();
  return res.results;
}

export async function exportLog(db: D1Database): Promise<ExportLog[]> {
  const res = await db
    .prepare(
      `SELECT l.id, l.payment_id, p.name, l.user_name, l.user_id, l.action, l.old_date, l.new_date, l.undone, l.created_at
       FROM payments_log l JOIN payments p ON p.id = l.payment_id ORDER BY l.id`,
    )
    .all<ExportLog>();
  return res.results;
}

// ---------- Настройки ----------

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function getSettings(db: D1Database): Promise<Record<string, string | undefined>> {
  const res = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  return Object.fromEntries(res.results.map((r) => [r.key, r.value]));
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export async function deleteSetting(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

// ---------- Отправленные напоминания ----------

/** Ключи «платёж:срок» напоминаний, уже отправленных в этот день. */
export async function getSentKeys(db: D1Database, remindDate: ISODate): Promise<Set<string>> {
  const res = await db
    .prepare("SELECT payment_id, due_date FROM sent_reminders WHERE remind_date = ?")
    .bind(remindDate)
    .all<{ payment_id: number; due_date: string }>();
  return new Set(res.results.map((r) => `${r.payment_id}:${r.due_date}`));
}

export async function recordSent(
  db: D1Database,
  paymentId: number,
  due: ISODate,
  remindDate: ISODate,
  chatId: number,
  messageId: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT OR REPLACE INTO sent_reminders (payment_id, due_date, remind_date, chat_id, message_id) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(paymentId, due, remindDate, chatId, messageId)
    .run();
}

/** Уборка: старые записи об отправке и брошенный пошаговый ввод больше не нужны. */
export async function cleanup(db: D1Database, today: ISODate): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM sent_reminders WHERE remind_date < date(?, '-60 days')").bind(today),
    db.prepare("DELETE FROM fsm WHERE updated_at < datetime('now', '-7 days')"),
  ]);
}

export async function getWarnDays(db: D1Database): Promise<number> {
  return Number(await getSetting(db, "warn_days")) || 4;
}

// ---------- Платежи ----------

export interface Payment {
  id: number;
  name: string;
  due_date: ISODate;
  period: Period;
  /** Для периода «дважды в месяц»: два числа, например «10,25». */
  month_days: string | null;
  remind_hour: number | null;
  /** Свой запас дней до срока; null — общий из настроек. */
  warn_days: number | null;
  /** Telegram id ответственного. */
  responsible_id: number | null;
  /** 1 — списывается с карты само. */
  autopay: number;
  category: string | null;
  note: string | null;
}

const COLS =
  "id, name, due_date, period, month_days, remind_hour, warn_days, responsible_id, autopay, category, note";
const ACTIVE = "archived = 0 AND deleted = 0";

/** Активные платежи по сроку, ближайшие сверху. */
export async function listPayments(db: D1Database): Promise<Payment[]> {
  const res = await db.prepare(`SELECT ${COLS} FROM payments WHERE ${ACTIVE} ORDER BY due_date, name`).all<Payment>();
  // Срок на выходной считается от предыдущего рабочего дня — сортируем по нему же.
  const key = new Map(res.results.map((p) => [p.id, effectiveDeadline(p.due_date).date]));
  return res.results.sort((a, b) => key.get(a.id)!.localeCompare(key.get(b.id)!));
}

export function getPayment(db: D1Database, id: number): Promise<Payment | null> {
  return db.prepare(`SELECT ${COLS} FROM payments WHERE id = ? AND ${ACTIVE}`).bind(id).first<Payment>();
}

export interface NewPayment {
  name: string;
  date: ISODate;
  period: Period;
  monthDays?: string | null;
}

/** Добавляет один или несколько платежей одной транзакцией. */
export async function createPayments(db: D1Database, items: NewPayment[], userId: number): Promise<void> {
  if (items.length === 0) return;
  const insert = db.prepare(
    "INSERT INTO payments (name, due_date, period, month_days, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)",
  );
  await db.batch(items.map((i) => insert.bind(i.name, i.date, i.period, i.monthDays ?? null, userId, userId)));
}

/** Период меняется вместе с числами месяца: они нужны только периоду «дважды в месяц». */
export async function updatePeriod(
  db: D1Database,
  id: number,
  period: Period,
  monthDays: string | null,
  userId: number,
): Promise<void> {
  await db
    .prepare("UPDATE payments SET period = ?, month_days = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(period, monthDays, userId, id)
    .run();
}

export interface Person {
  name: string;
  username: string | null;
}

/** Все, кого можно назначить ответственным: владелец и люди с доступом. */
export async function listPeople(db: D1Database, ownerId: number): Promise<Map<number, Person>> {
  const [users, settings] = await Promise.all([listUsers(db), getSettings(db)]);
  const people = new Map<number, Person>();
  people.set(ownerId, { name: settings.owner_name || "Владелец", username: settings.owner_username || null });
  for (const u of users) {
    if (u.role === "owner" || u.role === "admin" || u.role === "viewer") people.set(u.id, { name: u.name, username: u.username });
  }
  return people;
}

/**
 * Меняет срок и пишет в журнал. newDate = null — разовый платёж оплачен, уходит в архив.
 * Условие по старой дате защищает от двойного нажатия: вернёт false, если срок уже другой.
 */
export async function changeDueDate(
  db: D1Database,
  p: Payment,
  newDate: ISODate | null,
  actor: Actor,
  action: "paid" | "edit_date",
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE payments SET due_date = ?, archived = ?, updated_by = ?, updated_at = datetime('now')
       WHERE id = ? AND due_date = ? AND ${ACTIVE}`,
    )
    .bind(newDate ?? p.due_date, newDate ? 0 : 1, actor.id, p.id, p.due_date)
    .run();
  if (res.meta.changes === 0) return false;
  await addLog(db, p.id, actor, action, p.due_date, newDate);
  return true;
}

export async function deletePayment(db: D1Database, p: Payment, actor: Actor): Promise<void> {
  await db
    .prepare("UPDATE payments SET deleted = 1, updated_by = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(actor.id, p.id)
    .run();
  await addLog(db, p.id, actor, "delete", p.due_date, null);
}

/**
 * Отменяет последнюю отметку об оплате: срок возвращается к прежнему, разовый платёж — из архива.
 * Работает, только если после оплаты с платежом больше ничего не делали. Возвращает платёж
 * в восстановленном виде или null, если отменять нечего.
 */
export async function undoLastPayment(db: D1Database, paymentId: number, actor: Actor): Promise<Payment | null> {
  const p = await db
    .prepare(`SELECT ${COLS}, archived FROM payments WHERE id = ? AND deleted = 0`)
    .bind(paymentId)
    .first<Payment & { archived: number }>();
  const last = await db
    .prepare("SELECT id, action, old_date, new_date, undone FROM payments_log WHERE payment_id = ? ORDER BY id DESC LIMIT 1")
    .bind(paymentId)
    .first<{ id: number; action: LogAction; old_date: ISODate | null; new_date: ISODate | null; undone: number }>();
  if (!p || !last || last.action !== "paid" || last.undone || !last.old_date) return null;
  const consistent = last.new_date === null ? p.archived === 1 : p.archived === 0 && last.new_date === p.due_date;
  if (!consistent) return null;

  const res = await db
    .prepare(
      `UPDATE payments SET due_date = ?, archived = 0, updated_by = ?, updated_at = datetime('now')
       WHERE id = ? AND due_date = ? AND deleted = 0`,
    )
    .bind(last.old_date, actor.id, p.id, p.due_date)
    .run();
  if (res.meta.changes === 0) return null;
  await db.prepare("UPDATE payments_log SET undone = 1 WHERE id = ?").bind(last.id).run();
  await addLog(db, p.id, actor, "undo", last.new_date, last.old_date);
  const { archived: _archived, ...payment } = p;
  return { ...payment, due_date: last.old_date };
}

// ---------- Корзина: удалённые и архивные платежи ----------

export interface TrashItem {
  id: number;
  name: string;
  due_date: ISODate;
  archived: number;
  deleted: number;
}

export async function listTrash(db: D1Database): Promise<TrashItem[]> {
  const res = await db
    .prepare(
      `SELECT id, name, due_date, archived, deleted FROM payments
       WHERE archived = 1 OR deleted = 1 ORDER BY updated_at DESC LIMIT 30`,
    )
    .all<TrashItem>();
  return res.results;
}

/** Возвращает платёж в список. false — такого в корзине нет. */
export async function restorePayment(db: D1Database, id: number, actor: Actor): Promise<TrashItem | null> {
  const item = await db
    .prepare("SELECT id, name, due_date, archived, deleted FROM payments WHERE id = ? AND (archived = 1 OR deleted = 1)")
    .bind(id)
    .first<TrashItem>();
  if (!item) return null;
  await db
    .prepare("UPDATE payments SET archived = 0, deleted = 0, updated_by = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(actor.id, id)
    .run();
  await addLog(db, id, actor, "restore", null, item.due_date);
  return item;
}

/** Меняет одно поле платежа. Имя поля подставляется в SQL, поэтому список полей закрытый. */
export async function updatePaymentField(
  db: D1Database,
  id: number,
  field: "name" | "remind_hour" | "note" | "warn_days" | "responsible_id" | "autopay" | "category",
  value: string | number | null,
  userId: number,
): Promise<void> {
  await db
    .prepare(`UPDATE payments SET ${field} = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?`)
    .bind(value, userId, id)
    .run();
}

async function addLog(
  db: D1Database,
  paymentId: number,
  actor: Actor,
  action: LogAction,
  oldDate: ISODate | null,
  newDate: ISODate | null,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO payments_log (payment_id, user_id, user_name, action, old_date, new_date) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(paymentId, actor.id, actor.name, action, oldDate, newDate)
    .run();
}

export interface LastPaid {
  user_name: string;
  /** UTC, формат SQLite: YYYY-MM-DD HH:MM:SS */
  created_at: string;
}

/** Последняя оплата, которую не отменили. */
export function getLastPaid(db: D1Database, paymentId: number): Promise<LastPaid | null> {
  return db
    .prepare(
      `SELECT user_name, created_at FROM payments_log
       WHERE payment_id = ? AND action = 'paid' AND undone = 0 ORDER BY id DESC LIMIT 1`,
    )
    .bind(paymentId)
    .first<LastPaid>();
}

export interface HistoryItem {
  user_name: string;
  action: LogAction;
  old_date: ISODate | null;
  new_date: ISODate | null;
  undone: number;
  created_at: string;
}

/** Последние записи журнала по платежу, новые сверху. */
export async function getHistory(db: D1Database, paymentId: number, limit = 5): Promise<HistoryItem[]> {
  const res = await db
    .prepare(
      `SELECT user_name, action, old_date, new_date, undone, created_at FROM payments_log
       WHERE payment_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .bind(paymentId, limit)
    .all<HistoryItem>();
  return res.results;
}

// ---------- Состояние пошагового ввода ----------

export type FsmState =
  | "add:name"
  | "add:dup"
  | "add:date"
  | "add:period"
  | "add:day"
  | "add:bulk"
  | "edit:date"
  | "edit:name"
  | "edit:note";

export interface Fsm {
  state: FsmState;
  /** promptId — сообщение бота в группе, на которое ждём ответ с датой; remId — само напоминание. */
  data: {
    name?: string;
    date?: ISODate;
    period?: Period;
    id?: number;
    promptId?: number;
    remId?: number;
    threadId?: number;
  };
}

export async function getState(db: D1Database, chatId: number, userId: number): Promise<Fsm | null> {
  const row = await db
    .prepare("SELECT state, data FROM fsm WHERE chat_id = ? AND user_id = ?")
    .bind(chatId, userId)
    .first<{ state: FsmState; data: string }>();
  return row ? { state: row.state, data: JSON.parse(row.data) } : null;
}

export async function setState(
  db: D1Database,
  chatId: number,
  userId: number,
  state: FsmState,
  data: Fsm["data"] = {},
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fsm (chat_id, user_id, state, data) VALUES (?, ?, ?, ?)
       ON CONFLICT (chat_id, user_id) DO UPDATE SET state = excluded.state, data = excluded.data,
         updated_at = datetime('now')`,
    )
    .bind(chatId, userId, state, JSON.stringify(data))
    .run();
}

export async function clearState(db: D1Database, chatId: number, userId: number): Promise<void> {
  await db.prepare("DELETE FROM fsm WHERE chat_id = ? AND user_id = ?").bind(chatId, userId).run();
}
