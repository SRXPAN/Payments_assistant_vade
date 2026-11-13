// Тестовый стенд: бот работает на настоящей SQLite (встроена в Node) с теми же миграциями,
// что и в Cloudflare D1, а запросы к Telegram перехватываются и складываются в список.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Bot } from "grammy";
import { createBot } from "../src/bot";
import type { Env } from "../src/config";
import type { Payment } from "../src/db";

export const OWNER = 1000;
export const BOT_USERNAME = "test_club_bot";
const BOT_USER = { id: 42, is_bot: true, first_name: "Бот", username: BOT_USERNAME };

/** Платёж со значениями по умолчанию — для тестов отрисовки. */
export function payment(overrides: Partial<Payment> & { id: number; name: string; due_date: string }): Payment {
  return {
    period: "monthly",
    month_days: null,
    remind_hour: null,
    warn_days: null,
    responsible_id: null,
    autopay: 0,
    category: null,
    note: null,
    ...overrides,
  };
}

/** Минимальная реализация интерфейса D1 поверх node:sqlite. */
function fakeD1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    first: async () => sqlite.prepare(sql).get(...(args as never[])) ?? null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as never[])) }),
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...(args as never[])).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: { run: () => Promise<unknown> }[]) => {
      const results = [];
      for (const s of statements) results.push(await s.run());
      return results;
    },
  } as unknown as D1Database;
}

export interface ApiCall {
  method: string;
  payload: Record<string, any>;
}

export interface Harness {
  env: Env;
  bot: Bot;
  calls: ApiCall[];
  /** Текстовое сообщение боту. chat по умолчанию — личка с этим пользователем. */
  send(userId: number, text: string, opts?: { name?: string; username?: string; chat?: object; extra?: object }): Promise<void>;
  /** Нажатие инлайн-кнопки. */
  click(userId: number, data: string, opts?: { name?: string; chat?: object; message?: object }): Promise<void>;
  /** Произвольное обновление (например, my_chat_member). */
  update(body: object): Promise<void>;
  /** Запрос к базе: SELECT возвращает строки, остальное выполняется. */
  sql<T = Record<string, any>>(query: string, ...args: unknown[]): T[];
  /** Вызовы Telegram с заданным методом (и чатом, если указан). */
  sent(method: string, chatId?: number): ApiCall[];
  /** Текст последнего сообщения или правки сообщения. */
  lastText(): string;
  /** Подписи кнопок последнего сообщения с клавиатурой. */
  lastButtons(): [string, string][];
  /** Всплывающие ответы на нажатия кнопок. */
  alerts(): string[];
  /** Забыть накопленные вызовы. */
  reset(): void;
}

export function harness(): Harness {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("migrations").sort()) {
    // D1 применяет каждую миграцию одной транзакцией — повторяем это.
    sqlite.exec(`BEGIN;\n${readFileSync(`migrations/${file}`, "utf8")}\nCOMMIT;`);
  }
  const env: Env = {
    DB: fakeD1(sqlite),
    BOT_TOKEN: "42:test",
    WEBHOOK_SECRET: "secret",
    OWNER_ID: String(OWNER),
    TZ: "Europe/Warsaw",
    BOT_INFO: JSON.stringify({ ...BOT_USER, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false }),
  };
  const bot = createBot(env);
  const calls: ApiCall[] = [];
  let messageId = 500;
  let updateId = 0;

  bot.api.config.use(async (_prev, method, payload) => {
    const body = payload as Record<string, any>;
    calls.push({ method, payload: body });
    const isMessage = ["sendMessage", "editMessageText", "sendDocument"].includes(method);
    const result = isMessage ? { message_id: ++messageId, date: 0, chat: { id: body.chat_id, type: "private" } } : true;
    return { ok: true, result } as never;
  });

  const user = (id: number, name = `User${id}`, username?: string) => ({
    id,
    is_bot: false,
    first_name: name,
    ...(username ? { username } : {}),
  });
  const privateChat = (id: number) => ({ id, type: "private", first_name: `User${id}` });
  const texts = () => calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText");

  return {
    env,
    bot,
    calls,
    async send(userId, text, opts = {}) {
      await bot.handleUpdate({
        update_id: ++updateId,
        message: {
          message_id: ++messageId,
          date: 0,
          chat: opts.chat ?? privateChat(userId),
          from: user(userId, opts.name, opts.username),
          text,
          ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.length }] } : {}),
          ...opts.extra,
        },
      } as never);
    },
    async click(userId, data, opts = {}) {
      await bot.handleUpdate({
        update_id: ++updateId,
        callback_query: {
          id: String(updateId),
          from: user(userId, opts.name),
          chat_instance: "1",
          data,
          message: { message_id: 1, date: 0, chat: opts.chat ?? privateChat(userId), ...opts.message },
        },
      } as never);
    },
    async update(body) {
      await bot.handleUpdate({ update_id: ++updateId, ...body } as never);
    },
    sql(query, ...args) {
      const prepared = sqlite.prepare(query);
      if (/^\s*select/i.test(query)) return prepared.all(...(args as never[])) as never;
      prepared.run(...(args as never[]));
      return [];
    },
    sent: (method, chatId) =>
      calls.filter((c) => c.method === method && (chatId === undefined || c.payload.chat_id === chatId)),
    lastText: () => texts().at(-1)?.payload.text ?? "",
    lastButtons: () => {
      const withKeyboard = texts().filter((c) => c.payload.reply_markup?.inline_keyboard);
      const rows: any[][] = withKeyboard.at(-1)?.payload.reply_markup.inline_keyboard ?? [];
      return rows.flat().map((b) => [b.text, b.callback_data]);
    },
    alerts: () => calls.filter((c) => c.method === "answerCallbackQuery" && c.payload.text).map((c) => c.payload.text),
    reset: () => {
      calls.length = 0;
    },
  };
}

export const botUser = BOT_USER;
