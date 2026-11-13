// Тестовые платежи, чтобы сразу увидеть все статусы.
//   npm run seed          — в локальную базу (для `npm run dev`)
//   npm run seed:remote   — в базу на Cloudflare
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const TZ = "Europe/Warsaw";
const DAY_MS = 86_400_000;

// Сегодняшняя дата в часовом поясе клуба, как полночь UTC — так удобно прибавлять дни.
const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const today = new Date(`${todayIso}T00:00:00Z`);
const plus = (days) => new Date(today.getTime() + days * DAY_MS).toISOString().slice(0, 10);

// Ближайшая суббота после сегодняшнего дня.
const toSaturday = ((6 - today.getUTCDay() + 7) % 7) || 7;

const payments = [
  ["Тест: вчера", plus(-1), "monthly"],
  ["Тест: сегодня", plus(0), "monthly"],
  ["Тест: через 3 дня", plus(3), "biweekly"],
  ["Тест: суббота", plus(toSaturday), "quarterly"],
  ["Тест: через 40 дней", plus(40), "once"],
];

const sql = payments
  .map(
    ([name, due, period]) =>
      `INSERT INTO payments (name, due_date, period, created_by, updated_by) VALUES ('${name}', '${due}', '${period}', 0, 0);`,
  )
  .join("\n");

mkdirSync(".wrangler", { recursive: true });
writeFileSync(".wrangler/seed.sql", sql);

const target = process.argv.includes("--remote") ? "--remote" : "--local";
execSync(`npx wrangler d1 execute club-payments ${target} --file=.wrangler/seed.sql`, { stdio: "inherit" });
console.log(`\nДобавлено ${payments.length} тестовых платежей (${target}):`);
for (const [name, due] of payments) console.log(`  ${due}  ${name}`);
