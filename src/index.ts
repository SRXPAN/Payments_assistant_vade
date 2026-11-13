import { Api, webhookCallback } from "grammy";
import { createBot } from "./bot";
import { alertOwner, runCheck } from "./check";
import type { Env } from "./config";

const ALLOWED_UPDATES = ["message", "callback_query", "my_chat_member"] as const;
const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/**
 * Секрет принимается только в заголовке: в адресе он остался бы в истории браузера и в логах.
 * Служебные маршруты удобно вызывать командами `npm run bot:...` (см. README).
 */
function authorized(request: Request, env: Env): boolean {
  return Boolean(env.WEBHOOK_SECRET) && request.headers.get(SECRET_HEADER) === env.WEBHOOK_SECRET;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const known = ["/webhook", "/setup", "/status", "/run-check"].includes(url.pathname);
    if (!known) return new Response("Not found", { status: 404 });
    if (!authorized(request, env)) return new Response("Unauthorized", { status: 401 });

    if (url.pathname === "/webhook") {
      if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
      try {
        return await webhookCallback(createBot(env), "cloudflare-mod")(request);
      } catch (err) {
        // На ошибку Telegram получил бы 500 и присылал то же обновление снова и снова.
        // Отвечаем 200, а причину оставляем в логах.
        console.error("Ошибка обработки обновления", err);
        return new Response("ok");
      }
    }

    // Регистрация вебхука и команд бота.
    if (url.pathname === "/setup") {
      const bot = createBot(env);
      await bot.api.setWebhook(`${url.origin}/webhook`, {
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ALLOWED_UPDATES,
      });
      await bot.api.setMyCommands([{ command: "start", description: "Запуск и меню" }]);
      const me = await bot.api.getMe();
      return Response.json({
        ok: true,
        webhook: `${url.origin}/webhook`,
        // Скопируйте в BOT_INFO в wrangler.toml, чтобы бот не вызывал getMe на каждый запрос.
        bot_info: JSON.stringify(me),
      });
    }

    // Состояние вебхука со стороны Telegram.
    if (url.pathname === "/status") {
      const info = await new Api(env.BOT_TOKEN).getWebhookInfo();
      return Response.json({
        url: info.url,
        pending_update_count: info.pending_update_count,
        last_error_date: info.last_error_date ?? null,
        last_error_message: info.last_error_message ?? null,
        allowed_updates: info.allowed_updates ?? null,
      });
    }

    // Ручной запуск той же проверки, что делает Cron.
    // С ?force=1 — не смотреть на час и на уже отправленные (как «🧪 Проверить сейчас»).
    const force = url.searchParams.get("force") === "1";
    return Response.json(await runCheck(env, new Api(env.BOT_TOKEN), { force }));
  },

  // Запускается каждый час; нужный час по часовому поясу клуба проверяется внутри.
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const api = new Api(env.BOT_TOKEN);
    try {
      const result = await runCheck(env, api);
      if (result.sent || result.left) console.log("Напоминания:", JSON.stringify(result));
    } catch (err) {
      console.error("Проверка напоминаний упала", err);
      const reason = err instanceof Error ? err.message : String(err);
      await alertOwner(env, api, `⚠️ Проверка напоминаний завершилась ошибкой: ${reason}\nПодробности — в логах воркера.`);
    }
  },
} satisfies ExportedHandler<Env>;
