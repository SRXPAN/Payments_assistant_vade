// Тесты обработчиков: бот получает обновления так же, как от Telegram, и работает с настоящей SQLite.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "../src/check";
import { botUser, BOT_USERNAME, harness, type Harness, OWNER } from "./helpers";

const ADMIN = 2001;
const VIEWER = 2002;
const STRANGER = 2003;
const GROUP = -100500;
const groupChat = { id: GROUP, type: "supergroup", title: "Клуб" };

let h: Harness;

/** Пятница 13.11.2026, 12:30 по Варшаве. */
const FRIDAY_NOON = new Date("2026-11-13T11:30:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FRIDAY_NOON);
  h = harness();
  h.sql("INSERT INTO users (id, name, username, role) VALUES (?, 'Сеня', 'senya', 'admin'), (?, 'Оля', NULL, 'viewer')", ADMIN, VIEWER);
});
afterEach(() => vi.useRealTimers());

function addPayment(name: string, due: string, extra: Record<string, unknown> = {}): number {
  const cols = ["name", "due_date", "created_by", "updated_by", ...Object.keys(extra)];
  const values = [name, due, OWNER, OWNER, ...Object.values(extra)];
  h.sql(`INSERT INTO payments (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...values);
  return h.sql<{ id: number }>("SELECT max(id) AS id FROM payments")[0]!.id;
}
const paymentRow = (id: number) => h.sql("SELECT * FROM payments WHERE id = ?", id)[0]!;
const setting = (key: string) => h.sql<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)[0]?.value;
const bindGroup = () => h.sql("INSERT INTO settings (key, value) VALUES ('group_chat_id', ?)", String(GROUP));

describe("доступ", () => {
  it("незнакомец: запрос уходит владельцу один раз", async () => {
    await h.send(STRANGER, "/start", { name: "Макс", username: "max" });
    expect(h.sent("sendMessage", STRANGER)[0]!.payload.text).toBe("Нет доступа, запрос отправлен владельцу.");
    const request = h.sent("sendMessage", OWNER)[0]!.payload;
    expect(request.text).toBe(`Макс (@max, ${STRANGER}) просит доступ`);
    expect(h.lastButtons().map(([text]) => text)).toEqual(["Админ", "Наблюдатель", "Отклонить"]);

    await h.send(STRANGER, "/start", { name: "Макс" });
    expect(h.sent("sendMessage", OWNER)).toHaveLength(1); // повторный Start не дублирует запрос
  });

  it("владелец выдаёт роль — человек сразу получает справку и меню", async () => {
    await h.send(STRANGER, "/start", { name: "Макс" });
    h.reset();
    await h.click(OWNER, `acc:admin:${STRANGER}`);
    expect(h.sql("SELECT role FROM users WHERE id = ?", STRANGER)[0]!.role).toBe("admin");
    const welcome = h.sent("sendMessage", STRANGER)[0]!.payload;
    expect(welcome.text).toContain("Доступ открыт. Ваша роль: админ.");
    expect(welcome.text).toContain("❓ Как пользоваться ботом");
    expect(welcome.reply_markup.keyboard.flat().map((b: { text: string }) => b.text)).toContain("➕ Добавить");
  });

  it("чужой человек не может нажать кнопку выдачи доступа", async () => {
    await h.send(STRANGER, "/start");
    await h.click(ADMIN, `acc:admin:${STRANGER}`);
    expect(h.alerts()).toContain("Нет доступа");
    expect(h.sql("SELECT role FROM users WHERE id = ?", STRANGER)[0]!.role).toBe("pending");
  });

  it("отклонённый больше не беспокоит владельца", async () => {
    await h.send(STRANGER, "/start");
    await h.click(OWNER, `acc:deny:${STRANGER}`);
    h.reset();
    await h.send(STRANGER, "/start");
    expect(h.lastText()).toBe("Нет доступа.");
    expect(h.sent("sendMessage", OWNER)).toEqual([]);
  });

  it("наблюдатель: меню без «Добавить», кнопки платежей и текстовые команды закрыты", async () => {
    const id = addPayment("Интернет", "2026-11-20");
    await h.send(VIEWER, "/start");
    const menu = h.sent("sendMessage", VIEWER)[0]!.payload.reply_markup.keyboard.flat().map((b: { text: string }) => b.text);
    expect(menu).toEqual(["📋 Список", "❓ Помощь"]);

    await h.send(VIEWER, "➕ Добавить");
    expect(h.lastText()).toBe("Нет доступа");
    await h.click(VIEWER, `p:pay:${id}:2026-11-20`);
    await h.click(VIEWER, `p:delyes:${id}`);
    await h.click(VIEWER, `r:pay:${id}:2026-11-20`);
    expect(h.alerts()).toEqual(["Нет доступа", "Нет доступа", "Нет доступа"]);
    expect(paymentRow(id)).toMatchObject({ due_date: "2026-11-20", deleted: 0 });
  });

  it("админ: настройки доступны, раздел «Доступ» — нет", async () => {
    await h.send(ADMIN, "/start");
    const menu = h.sent("sendMessage", ADMIN)[0]!.payload.reply_markup.keyboard.flat().map((b: { text: string }) => b.text);
    expect(menu).toEqual(["📋 Список", "➕ Добавить", "✏️ Изменить", "❓ Помощь", "⚙️ Настройки"]);

    await h.send(ADMIN, "⚙️ Настройки");
    expect(h.lastText()).toContain("⚙️ Настройки\nПредупреждать за: 4 дн.");
    await h.click(ADMIN, "s:days:7");
    await h.click(ADMIN, "s:hour:9");
    await h.click(ADMIN, "s:csv");
    expect(setting("warn_days")).toBe("7");
    expect(setting("check_hour")).toBe("9");
    expect(h.sent("sendDocument", ADMIN)).toHaveLength(2);

    h.reset();
    await h.send(ADMIN, "👥 Доступ");
    expect(h.lastText()).toBe("Нет доступа");
    await h.click(ADMIN, "u:list");
    await h.click(ADMIN, `u:set:${VIEWER}:admin`);
    await h.click(ADMIN, `u:set:${ADMIN}:owner`);
    expect(h.alerts()).toEqual(["Нет доступа", "Нет доступа", "Нет доступа"]);
    expect(h.sql("SELECT id, role FROM users ORDER BY id")).toEqual([
      { id: ADMIN, role: "admin" },
      { id: VIEWER, role: "viewer" },
    ]);
  });

  it("наблюдатель не может менять настройки", async () => {
    await h.send(VIEWER, "⚙️ Настройки");
    expect(h.lastText()).toBe("Нет доступа");
    await h.click(VIEWER, "s:days:7");
    await h.click(VIEWER, "s:unbind");
    expect(h.alerts()).toEqual(["Нет доступа", "Нет доступа"]);
    expect(setting("warn_days")).toBe("4");
  });

  it("владелец назначает второго владельца — после подтверждения", async () => {
    await h.click(OWNER, `u:own:${ADMIN}`);
    expect(h.lastText()).toContain("Точно сделать владельцем: Сеня?");
    expect(h.sql("SELECT role FROM users WHERE id = ?", ADMIN)[0]!.role).toBe("admin");

    await h.click(OWNER, `u:set:${ADMIN}:owner`);
    expect(h.sql("SELECT role FROM users WHERE id = ?", ADMIN)[0]!.role).toBe("owner");
    const welcome = h.sent("sendMessage", ADMIN).at(-1)!.payload;
    expect(welcome.text).toContain("Ваша роль: владелец.");
    expect(welcome.reply_markup.keyboard.flat().map((b: { text: string }) => b.text)).toContain("👥 Доступ");
  });

  it("второй владелец управляет доступом, но не трогает главного, себя и других владельцев", async () => {
    const SECOND = 2010;
    h.sql("INSERT INTO users (id, name, role) VALUES (?, 'Влад', 'owner')", SECOND);
    h.sql("UPDATE users SET role = 'owner' WHERE id = ?", ADMIN);

    await h.send(SECOND, "👥 Доступ");
    expect(h.lastText()).toContain("👥 Доступ");
    await h.click(SECOND, `u:set:${VIEWER}:admin`);
    expect(h.sql("SELECT role FROM users WHERE id = ?", VIEWER)[0]!.role).toBe("admin");

    await h.click(SECOND, `u:revoke:${OWNER}`); // главный владелец
    await h.click(SECOND, `u:revoke:${SECOND}`); // сам себя
    await h.click(SECOND, `u:set:${ADMIN}:viewer`); // другой владелец
    expect(h.alerts().slice(-3)).toEqual([
      "Главного владельца изменить нельзя.",
      "Свою роль изменить нельзя.",
      "Роль совладельца меняет только главный владелец.",
    ]);
    expect(h.sql("SELECT id, role FROM users WHERE role = 'owner' ORDER BY id")).toEqual([
      { id: ADMIN, role: "owner" },
      { id: SECOND, role: "owner" },
    ]);

    // Главный владелец может понизить совладельца.
    await h.click(OWNER, `u:set:${SECOND}:admin`);
    expect(h.sql("SELECT role FROM users WHERE id = ?", SECOND)[0]!.role).toBe("admin");
  });

  it("запрос доступа приходит всем владельцам; второй раз его не обработать", async () => {
    h.sql("UPDATE users SET role = 'owner' WHERE id = ?", ADMIN);
    await h.send(STRANGER, "/start", { name: "Макс" });
    expect(h.sent("sendMessage", OWNER)).toHaveLength(1);
    expect(h.sent("sendMessage", ADMIN)).toHaveLength(1);

    await h.click(ADMIN, `acc:viewer:${STRANGER}`);
    expect(h.sql("SELECT role FROM users WHERE id = ?", STRANGER)[0]!.role).toBe("viewer");
    h.reset();
    await h.click(OWNER, `acc:admin:${STRANGER}`); // кнопка под копией запроса у другого владельца
    expect(h.alerts()).toEqual(["Этот запрос уже обработан."]);
    expect(h.sql("SELECT role FROM users WHERE id = ?", STRANGER)[0]!.role).toBe("viewer");
    expect(h.sent("sendMessage", STRANGER)).toEqual([]);
  });

  it("несколько главных владельцев в OWNER_ID через запятую", async () => {
    h.env.OWNER_ID = `${OWNER}, 3001`;
    const { createBot } = await import("../src/bot");
    const { getRole } = await import("../src/db");
    const { getConfig } = await import("../src/config");
    const config = getConfig(h.env);
    expect(config).toMatchObject({ ownerId: OWNER, ownerIds: [OWNER, 3001] });
    expect(await getRole(h.env.DB, config.ownerIds, 3001)).toBe("owner");
    expect(createBot(h.env)).toBeDefined();
  });

  it("смена роли действует сразу; забранный доступ блокирует", async () => {
    const id = addPayment("Интернет", "2026-11-20");
    await h.click(OWNER, `u:set:${ADMIN}:viewer`);
    await h.click(ADMIN, `p:pay:${id}:2026-11-20`);
    expect(paymentRow(id).due_date).toBe("2026-11-20");

    await h.click(OWNER, `u:revoke:${ADMIN}`);
    h.reset();
    await h.send(ADMIN, "📋 Список");
    expect(h.lastText()).toBe("Нет доступа");
    await h.send(ADMIN, "/start");
    expect(h.sent("sendMessage", OWNER)).toEqual([]);
  });
});

describe("добавление", () => {
  it("три шага: название, дата, период", async () => {
    await h.send(ADMIN, "➕ Добавить");
    expect(h.lastButtons().map(([text]) => text)).toEqual(["📋 Добавить списком", "↩️ Отмена"]);
    await h.send(ADMIN, "Интернет");
    await h.send(ADMIN, "32.13.2026");
    expect(h.lastText()).toContain("Такой даты не существует");
    await h.send(ADMIN, "25.11");
    expect(h.lastText()).toBe("Как часто платится?");
    await h.click(ADMIN, "a:per:quarterly");
    expect(h.lastText()).toBe("✅ Добавлено: Интернет — 25.11.2026 (раз в квартал)");
    expect(h.sql("SELECT name, due_date, period, created_by FROM payments")).toEqual([
      { name: "Интернет", due_date: "2026-11-25", period: "quarterly", created_by: ADMIN },
    ]);
  });

  it("дубль названия требует подтверждения, отмена ничего не создаёт", async () => {
    addPayment("Интернет", "2026-11-20");
    await h.send(ADMIN, "➕ Добавить");
    await h.send(ADMIN, "интернет");
    expect(h.lastText()).toContain("уже есть в списке");
    await h.click(ADMIN, "a:cancel");
    expect(h.lastText()).toBe("Отменено.");
    await h.send(ADMIN, "25.11"); // ввод уже отменён — это поиск, а не дата
    expect(h.sql("SELECT count(*) AS n FROM payments")[0]!.n).toBe(1);
  });

  it("дважды в месяц: второе число выбирается кнопкой", async () => {
    await h.send(ADMIN, "➕ Добавить");
    await h.send(ADMIN, "Зарплата");
    await h.send(ADMIN, "10.12.2026");
    await h.click(ADMIN, "a:per:semimonthly");
    expect(h.lastText()).toContain("первое число — 10");
    await h.click(ADMIN, "a:day:10"); // то же число — нельзя
    expect(h.sql("SELECT count(*) AS n FROM payments")[0]!.n).toBe(0);

    await h.send(ADMIN, "➕ Добавить");
    await h.send(ADMIN, "Зарплата");
    await h.send(ADMIN, "10.12.2026");
    await h.click(ADMIN, "a:per:semimonthly");
    await h.click(ADMIN, "a:day:25");
    expect(h.lastText()).toBe("✅ Добавлено: Зарплата — 10.12.2026 (дважды в месяц (10 и 25 числа))");
    const id = h.sql<{ id: number }>("SELECT id FROM payments")[0]!.id;
    await h.click(ADMIN, `p:pay:${id}:2026-12-10`);
    expect(paymentRow(id).due_date).toBe("2026-12-25");
  });

  it("список: хорошие строки добавляются, плохие перечисляются", async () => {
    await h.send(ADMIN, "➕ Добавить");
    await h.click(ADMIN, "a:bulk");
    expect(h.lastText()).toContain("Название; дата; период");
    await h.send(ADMIN, "Интернет; 25.11\nАренда; 01.12; ежемесячно\nХостинг; когда-нибудь");
    expect(h.lastText()).toContain("✅ Добавлено: 2");
    expect(h.lastText()).toContain("⚠️ Не добавлено (1):");
    expect(h.sql("SELECT name, due_date FROM payments ORDER BY id")).toEqual([
      { name: "Интернет", due_date: "2026-11-25" },
      { name: "Аренда", due_date: "2026-12-01" },
    ]);
  });
});

describe("карточка платежа", () => {
  it("оплата сдвигает срок один раз даже при двойном нажатии и пишет в журнал", async () => {
    const id = addPayment("Интернет", "2026-11-12");
    await h.click(ADMIN, `p:pay:${id}:2026-11-12`, { name: "Сеня" });
    await h.click(ADMIN, `p:pay:${id}:2026-11-12`, { name: "Сеня" });
    expect(paymentRow(id).due_date).toBe("2026-12-12");
    expect(h.sql("SELECT user_name, action, old_date, new_date FROM payments_log")).toEqual([
      { user_name: "Сеня", action: "paid", old_date: "2026-11-12", new_date: "2026-12-12" },
    ]);
    // Группы нет — об оплате узнаёт владелец.
    expect(h.sent("sendMessage", OWNER)[0]!.payload.text).toBe("✅ Сеня отметил оплату: Интернет → следующая 12.12.2026");
  });

  it("отмена оплаты возвращает срок; вторая отмена невозможна", async () => {
    const id = addPayment("Интернет", "2026-11-12");
    await h.click(OWNER, `p:pay:${id}:2026-11-12`);
    expect(h.lastButtons().map(([text]) => text)).toContain("↩️ Отменить оплату");
    await h.click(OWNER, `p:undo:${id}`);
    expect(paymentRow(id).due_date).toBe("2026-11-12");
    await h.click(OWNER, `p:undo:${id}`);
    expect(h.alerts().at(-1)).toContain("Отменять нечего");
    expect(h.sql("SELECT action, undone FROM payments_log ORDER BY id")).toEqual([
      { action: "paid", undone: 1 },
      { action: "undo", undone: 0 },
    ]);
  });

  it("разовый платёж после оплаты уходит в архив и возвращается из корзины", async () => {
    const id = addPayment("Ремонт", "2026-11-20", { period: "once" });
    await h.click(OWNER, `p:pay:${id}:2026-11-20`);
    expect(paymentRow(id).archived).toBe(1);
    await h.click(OWNER, "s:trash");
    expect(h.lastButtons()[0]).toEqual(["♻️ Ремонт — архив", `s:restore:${id}`]);
    await h.click(OWNER, `s:restore:${id}`);
    expect(paymentRow(id)).toMatchObject({ archived: 0, deleted: 0 });
  });

  it("удаление только после подтверждения; владелец узнаёт об удалении админом", async () => {
    const id = addPayment("Хостинг", "2026-11-20");
    await h.click(ADMIN, `p:del:${id}:l`, { name: "Сеня" });
    expect(h.lastText()).toBe("Точно удалить «Хостинг» (до 20.11.2026)?");
    expect(h.lastButtons()).toEqual([
      ["Да", `p:delyes:${id}`],
      ["Нет", "e:list:0"],
    ]);
    expect(paymentRow(id).deleted).toBe(0);

    await h.click(ADMIN, `p:delyes:${id}`, { name: "Сеня" });
    expect(paymentRow(id).deleted).toBe(1);
    expect(h.sent("sendMessage", OWNER)[0]!.payload.text).toContain("🔔 Сеня удалил платёж: Хостинг");
  });

  it("владельцу о его собственных действиях уведомления не приходят", async () => {
    const id = addPayment("Хостинг", "2026-11-20");
    await h.click(OWNER, `p:delyes:${id}`);
    expect(h.sent("sendMessage", OWNER)).toEqual([]);
  });

  it("смена даты текстом: журнал и уведомление владельцу", async () => {
    const id = addPayment("Хостинг", "2026-11-20");
    await h.click(ADMIN, `p:date:${id}`, { name: "Сеня" });
    await h.send(ADMIN, "абв", { name: "Сеня" });
    expect(h.lastText()).toContain("Не понял дату");
    await h.send(ADMIN, "05.12.2026", { name: "Сеня" });
    expect(paymentRow(id).due_date).toBe("2026-12-05");
    expect(h.sent("sendMessage", OWNER)[0]!.payload.text).toBe("🔔 Сеня изменил срок: Хостинг — 20.11.2026 → 05.12.2026");
    expect(h.sql("SELECT action FROM payments_log")).toEqual([{ action: "edit_date" }]);
  });

  it("параметры: запас дней, ответственный, автосписание, категория, заметка", async () => {
    const id = addPayment("Аренда", "2026-11-20");
    await h.click(ADMIN, `p:setwarn:${id}:10`);
    await h.click(ADMIN, `p:setresp:${id}:${ADMIN}`);
    await h.click(ADMIN, `p:auto:${id}`);
    await h.click(ADMIN, `p:setcat:${id}:2`);
    await h.click(ADMIN, `p:note:${id}`);
    await h.send(ADMIN, "Договор 15");
    expect(paymentRow(id)).toMatchObject({
      warn_days: 10,
      responsible_id: ADMIN,
      autopay: 1,
      category: "Аренда",
      note: "Договор 15",
    });
    expect(h.lastText()).toContain("👤 Ответственный: Сеня");

    // Недопустимые значения не сохраняются.
    await h.click(ADMIN, `p:setwarn:${id}:999`);
    await h.click(ADMIN, `p:setresp:${id}:${STRANGER}`);
    await h.click(ADMIN, `p:setcat:${id}:42`);
    expect(paymentRow(id)).toMatchObject({ warn_days: 10, responsible_id: ADMIN, category: "Аренда" });

    await h.click(ADMIN, `p:setwarn:${id}:d`);
    await h.click(ADMIN, `p:setresp:${id}:0`);
    await h.click(ADMIN, `p:auto:${id}`);
    await h.click(ADMIN, `p:setcat:${id}:n`);
    expect(paymentRow(id)).toMatchObject({ warn_days: null, responsible_id: null, autopay: 0, category: null });
  });

  it("смена периода на «дважды в месяц» из карточки", async () => {
    const id = addPayment("Зарплата", "2026-11-10");
    await h.click(ADMIN, `p:setper:${id}:semimonthly`);
    expect(paymentRow(id).period).toBe("monthly"); // пока не выбрано второе число
    await h.click(ADMIN, `p:setday:${id}:25`);
    expect(paymentRow(id)).toMatchObject({ period: "semimonthly", month_days: "10,25" });
    await h.click(ADMIN, `p:setper:${id}:yearly`);
    expect(paymentRow(id)).toMatchObject({ period: "yearly", month_days: null });
  });
});

describe("список и поиск", () => {
  it("список доступен наблюдателю; кнопка категорий появляется при их наличии", async () => {
    addPayment("Интернет", "2026-11-20");
    await h.send(VIEWER, "📋 Список");
    expect(h.lastText()).toBe("📋 Платежи (1):\n• Интернет — 20.11.2026 🟢 через 7 дн.");
    expect(h.sent("sendMessage").at(-1)!.payload.reply_markup).toBeUndefined();
    expect(h.sent("sendMessage").at(-1)!.payload.link_preview_options).toEqual({ is_disabled: true });

    addPayment("Netflix", "2026-11-25", { category: "Подписки" });
    await h.send(VIEWER, "📋 Список");
    expect(h.lastButtons()).toEqual([["🏷 По категориям", "l:cats"]]);
    await h.click(VIEWER, "l:cat:0");
    expect(h.lastText()).toBe("📋 Подписки (1):\n• Netflix — 25.11.2026 🟢 через 12 дн.");
  });

  it("поиск: любой текст вне пошагового ввода ищет платежи", async () => {
    const id = addPayment("Интернет Orange", "2026-11-20");
    addPayment("Аренда", "2026-11-25");
    await h.send(ADMIN, "orange");
    expect(h.lastText()).toBe("🔎 Найдено (1):\n• Интернет Orange — 20.11.2026 🟢 через 7 дн.");
    expect(h.lastButtons()).toEqual([["✏️ Интернет Orange", `p:open:${id}`]]);

    await h.send(VIEWER, "orange");
    expect(h.lastText()).toContain("🔎 Найдено (1)");
    expect(h.sent("sendMessage").at(-1)!.payload.reply_markup).toBeUndefined(); // наблюдателю — без кнопок

    await h.send(VIEWER, "яхта");
    expect(h.lastText()).toContain("Ничего не нашлось по запросу «яхта»");
  });

  it("помощь зависит от роли", async () => {
    await h.send(VIEWER, "❓ Помощь");
    expect(h.lastText()).not.toContain("➕ Добавить");
    await h.send(OWNER, "❓ Помощь");
    expect(h.lastText()).toContain("👥 Доступ");
  });
});

describe("напоминания", () => {
  it("без группы уходят владельцу; повторный запуск в тот же день ничего не шлёт", async () => {
    addPayment("Вчера", "2026-11-12");
    addPayment("Сегодня", "2026-11-13");
    addPayment("Нескоро", "2026-12-30");
    expect(await runCheck(h.env, h.bot.api)).toMatchObject({ sent: 2, left: 0, toGroup: false });
    expect(h.sent("sendMessage", OWNER).map((c) => c.payload.text)).toEqual([
      "🔴 Просрочено на 1 дн.: Вчера — до 12.11.2026",
      "🟠 Сегодня последний день оплаты: Сегодня — до 13.11.2026",
    ]);
    expect(h.lastButtons().map(([text]) => text)).toEqual(["✅ Оплатил", "📅 +1 мес", "✏️ Дата"]);

    h.reset();
    expect(await runCheck(h.env, h.bot.api)).toMatchObject({ sent: 0 });
    expect(h.sent("sendMessage")).toEqual([]);
  });

  it("до заданного часа молчит", async () => {
    addPayment("Сегодня", "2026-11-13");
    vi.setSystemTime(new Date("2026-11-13T08:30:00Z")); // 9:30 по Варшаве, проверка в 12
    expect(await runCheck(h.env, h.bot.api)).toMatchObject({ sent: 0 });
  });

  it("в группу и её тему, с заметкой и упоминанием ответственного", async () => {
    bindGroup();
    h.sql("INSERT INTO settings (key, value) VALUES ('group_thread_id', '77')");
    addPayment("Интернет", "2026-11-13", { note: "Договор 15", responsible_id: ADMIN });
    addPayment("Электричество", "2026-11-13", { responsible_id: VIEWER }); // у Оли нет @username
    await runCheck(h.env, h.bot.api);
    const [first, second] = h.sent("sendMessage", GROUP).map((c) => c.payload);
    expect(first!.text).toBe("🟠 Сегодня последний день оплаты: Интернет — до 13.11.2026\n📝 Договор 15\n👤 @senya");
    expect(first!.message_thread_id).toBe(77);
    expect(second!.text.endsWith("\n👤 Оля")).toBe(true);
    expect(second!.entities).toEqual([
      { type: "text_mention", offset: second!.text.length - 3, length: 3, user: { id: VIEWER, is_bot: false, first_name: "Оля" } },
    ]);
  });

  it("автосписание: срок сдвигается сам, запись в журнале от имени «автосписание»", async () => {
    const id = addPayment("Хостинг", "2026-11-10", { autopay: 1 });
    await runCheck(h.env, h.bot.api);
    expect(paymentRow(id).due_date).toBe("2026-12-10");
    expect(h.sql("SELECT user_name, action, old_date, new_date FROM payments_log")).toEqual([
      { user_name: "автосписание", action: "paid", old_date: "2026-11-10", new_date: "2026-12-10" },
    ]);
    expect(h.sent("sendMessage")).toEqual([]); // до нового срока далеко — напоминать не о чем
  });

  it("автосписание сегодня: напоминание без кнопки «Оплатил»", async () => {
    addPayment("Хостинг", "2026-11-13", { autopay: 1 });
    await runCheck(h.env, h.bot.api);
    expect(h.lastText()).toContain("💳 Сегодня автосписание: Хостинг");
    expect(h.lastButtons().map(([text]) => text)).toEqual(["✏️ Дата"]);
  });

  it("в субботу обычные платежи молчат, пока владелец не выключит тихий режим", async () => {
    addPayment("Понедельник", "2026-11-16");
    vi.setSystemTime(new Date("2026-11-14T11:30:00Z")); // суббота
    expect(await runCheck(h.env, h.bot.api)).toMatchObject({ sent: 0 });
    await h.click(OWNER, "s:quiet");
    expect(setting("quiet_weekends")).toBe("0");
    expect(await runCheck(h.env, h.bot.api)).toMatchObject({ sent: 1 });
  });

  it("в понедельник — план на неделю, давно просроченные и резервная копия; один раз", async () => {
    addPayment("Среда", "2026-11-18");
    addPayment("Старый долг", "2026-10-01");
    vi.setSystemTime(new Date("2026-11-16T11:30:00Z")); // понедельник
    await runCheck(h.env, h.bot.api);
    const texts = h.sent("sendMessage", OWNER).map((c) => c.payload.text as string);
    expect(texts).toContain("🗓 На этой неделе платим (1):\n• ср 18.11 — Среда");
    expect(texts.some((t) => t.startsWith("🔴 Давно просрочено (1):"))).toBe(true);
    expect(h.sent("sendDocument", OWNER)).toHaveLength(2);

    h.reset();
    vi.setSystemTime(new Date("2026-11-16T12:30:00Z"));
    await runCheck(h.env, h.bot.api);
    expect(h.sent("sendDocument")).toEqual([]);
    expect(h.sent("sendMessage")).toEqual([]);
  });

  it("кнопка под напоминанием: оплата, затем отмена возвращает напоминание", async () => {
    bindGroup();
    const id = addPayment("Интернет", "2026-11-13");
    await h.click(ADMIN, `r:pay:${id}:2026-11-13`, { name: "Сеня", chat: groupChat });
    expect(h.lastText()).toBe("Интернет\n✅ Оплачено (Сеня), следующая 13.12.2026");
    expect(h.lastButtons()).toEqual([["↩️ Отменить оплату", `r:undo:${id}`]]);
    expect(h.sent("sendMessage")).toEqual([]); // в ту же группу отдельное сообщение не дублируется

    await h.click(ADMIN, `r:undo:${id}`, { name: "Сеня", chat: groupChat });
    expect(paymentRow(id).due_date).toBe("2026-11-13");
    expect(h.lastText()).toBe("🟠 Сегодня последний день оплаты: Интернет — до 13.11.2026\n↩️ Оплата отменена (Сеня)");
    expect(h.lastButtons().map(([text]) => text)).toEqual(["✅ Оплатил", "📅 +1 мес", "✏️ Дата"]);
  });

  it("«Дата» в группе: бот просит ответить и принимает дату только ответом на своё сообщение", async () => {
    bindGroup();
    const id = addPayment("Интернет", "2026-11-13");
    await h.click(ADMIN, `r:date:${id}`, { name: "Сеня", chat: groupChat });
    const prompt = h.sent("sendMessage", GROUP)[0]!.payload;
    expect(prompt.reply_markup.force_reply).toBe(true);
    const promptId = h.sql<{ data: string }>("SELECT data FROM fsm")[0]!;
    const { promptId: replyTo } = JSON.parse(promptId.data);

    await h.send(ADMIN, "20.11.2026", { name: "Сеня", chat: groupChat }); // не ответ — игнорируется
    expect(paymentRow(id).due_date).toBe("2026-11-13");
    await h.send(VIEWER, "20.11.2026", { chat: groupChat, extra: { reply_to_message: { message_id: replyTo } } });
    expect(paymentRow(id).due_date).toBe("2026-11-13"); // ответил не тот, кого спрашивали

    await h.send(ADMIN, "20.11.2026", { name: "Сеня", chat: groupChat, extra: { reply_to_message: { message_id: replyTo } } });
    expect(paymentRow(id).due_date).toBe("2026-11-20");
    expect(h.sent("sendMessage", GROUP).at(-1)!.payload.text).toBe("✏️ Срок изменён (Сеня): Интернет — до 20.11.2026");
  });
});

describe("группа", () => {
  const joined = (fromId: number) => ({
    my_chat_member: {
      chat: groupChat,
      from: { id: fromId, is_bot: false, first_name: "Кто-то" },
      date: 0,
      old_chat_member: { user: botUser, status: "left" },
      new_chat_member: { user: botUser, status: "member" },
    },
  });

  it("добавил владелец — группа запоминается, бот объясняет кнопки", async () => {
    await h.update(joined(OWNER));
    expect(setting("group_chat_id")).toBe(String(GROUP));
    expect(setting("group_title")).toBe("Клуб");
    expect(h.sent("sendMessage", GROUP)[0]!.payload.text).toContain("Готово, буду напоминать здесь.");
    expect(h.sent("leaveChat")).toEqual([]);
  });

  it("добавил кто-то другой — бот выходит", async () => {
    await h.update(joined(STRANGER));
    expect(setting("group_chat_id")).toBeUndefined();
    expect(h.sent("leaveChat")).toHaveLength(1);
  });

  it("переезд в супергруппу меняет сохранённый chat_id", async () => {
    bindGroup();
    await h.update({
      message: { message_id: 1, date: 0, chat: groupChat, from: { id: STRANGER, is_bot: false, first_name: "X" }, migrate_to_chat_id: -100999 },
    });
    expect(setting("group_chat_id")).toBe("-100999");
  });

  it("владелец или админ упоминает бота в теме — напоминания идут туда; упоминание наблюдателя не действует", async () => {
    bindGroup();
    const inTopic = { is_topic_message: true, message_thread_id: 77 };
    await h.send(VIEWER, `@${BOT_USERNAME}`, { chat: groupChat, extra: inTopic });
    await h.send(STRANGER, `@${BOT_USERNAME}`, { chat: groupChat, extra: inTopic });
    expect(setting("group_thread_id")).toBeUndefined();

    await h.send(ADMIN, `@${BOT_USERNAME}`, { chat: groupChat, extra: { is_topic_message: true, message_thread_id: 55 } });
    expect(setting("group_thread_id")).toBe("55");

    await h.send(OWNER, `@${BOT_USERNAME} пиши сюда`, { chat: groupChat, extra: inTopic });
    expect(setting("group_thread_id")).toBe("77");
    expect(h.sent("sendMessage", GROUP).at(-1)!.payload.message_thread_id).toBe(77);

    await h.click(OWNER, "s:notopic");
    expect(setting("group_thread_id")).toBeUndefined();
  });

  it("отвязка группы: настройки очищены, бот выходит", async () => {
    bindGroup();
    await h.click(OWNER, "s:unbind");
    expect(setting("group_chat_id")).toBeUndefined();
    expect(h.sent("leaveChat")[0]!.payload.chat_id).toBe(GROUP);
  });
});
