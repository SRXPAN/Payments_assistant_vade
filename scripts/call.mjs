// Вызов служебных маршрутов воркера с секретом в заголовке (секрет не попадает в адрес и на экран).
//   npm run bot:setup    — зарегистрировать вебхук и команды
//   npm run bot:status   — что Telegram думает о вебхуке
//   npm run bot:check    — запустить проверку напоминаний как Cron
//   npm run bot:check:force — прислать сегодняшние напоминания заново
// Берёт WORKER_URL и WEBHOOK_SECRET из файла .dev.vars.
import { readFileSync } from "node:fs";

const route = process.argv[2];
if (!route?.startsWith("/")) {
  console.error("Укажите маршрут, например: node scripts/call.mjs /status");
  process.exit(1);
}

const vars = {};
for (const line of readFileSync(".dev.vars", "utf8").split(/\r?\n/)) {
  const eq = line.indexOf("=");
  if (eq > 0 && !line.startsWith("#")) vars[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
}
if (!vars.WORKER_URL || !vars.WEBHOOK_SECRET) {
  console.error("В .dev.vars должны быть строки WORKER_URL=https://... и WEBHOOK_SECRET=...");
  process.exit(1);
}

const res = await fetch(vars.WORKER_URL.replace(/\/$/, "") + route, {
  headers: { "X-Telegram-Bot-Api-Secret-Token": vars.WEBHOOK_SECRET },
});
const body = await res.text();
console.log(`${res.status} ${res.statusText}`);
try {
  console.log(JSON.stringify(JSON.parse(body), null, 2));
} catch {
  console.log(body);
}
process.exit(res.ok ? 0 : 1);
