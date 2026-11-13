export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  /** Telegram ID главного владельца; можно несколько через запятую — все они неснимаемые владельцы. */
  OWNER_ID: string;
  TZ: string;
  BOT_INFO: string;
}

export interface Config {
  /** Главный владелец: ему приходят напоминания, пока группа не привязана. */
  ownerId: number;
  /** Все владельцы из конфигурации. Их роль в боте изменить нельзя. */
  ownerIds: number[];
  timeZone: string;
}

export function getConfig(env: Env): Config {
  const ownerIds = String(env.OWNER_ID ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  const ownerId = ownerIds[0];
  if (!ownerId) {
    throw new Error("OWNER_ID не задан: укажите Telegram ID владельца в wrangler.toml или .dev.vars");
  }
  return { ownerId, ownerIds, timeZone: env.TZ || "Europe/Warsaw" };
}
