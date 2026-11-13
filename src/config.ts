export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  OWNER_ID: string;
  TZ: string;
  BOT_INFO: string;
}

export interface Config {
  ownerId: number;
  timeZone: string;
}

export function getConfig(env: Env): Config {
  const ownerId = Number(env.OWNER_ID);
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new Error("OWNER_ID не задан: укажите Telegram ID владельца в wrangler.toml или .dev.vars");
  }
  return { ownerId, timeZone: env.TZ || "Europe/Warsaw" };
}
