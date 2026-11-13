// Экспорт в CSV для Excel: разделитель «;», BOM, чтобы кириллица открывалась без настройки.
import { PERIOD_LABELS } from "./dates";
import type { ExportLog, ExportPayment } from "./db";

type Cell = string | number | null;

function cell(value: Cell): string {
  if (value === null) return "";
  let text = String(value);
  // Название вида «=2+2» Excel выполнил бы как формулу — нейтрализуем апострофом.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: Cell[][]): string {
  return `﻿${[headers, ...rows].map((row) => row.map(cell).join(";")).join("\r\n")}\r\n`;
}

export function paymentsCsv(rows: ExportPayment[]): string {
  return toCsv(
    ["id", "Название", "Оплачено до", "Период", "Час напоминания", "Статус", "Создан (UTC)", "Изменён (UTC)", "Заметка"],
    rows.map((p) => [
      p.id,
      p.name,
      p.due_date,
      PERIOD_LABELS[p.period],
      p.remind_hour === null ? "как в настройках" : `${p.remind_hour}:00`,
      p.deleted ? "удалён" : p.archived ? "архив" : "активен",
      p.created_at,
      p.updated_at,
      p.note,
    ]),
  );
}

const ACTION_LABELS: Record<ExportLog["action"], string> = {
  paid: "оплата",
  edit_date: "изменение даты",
  delete: "удаление",
  undo: "отмена оплаты",
  restore: "восстановление",
};

export function logCsv(rows: ExportLog[]): string {
  return toCsv(
    ["id", "id платежа", "Платёж", "Кто", "Telegram ID", "Действие", "Старая дата", "Новая дата", "Когда (UTC)"],
    rows.map((l) => [
      l.id,
      l.payment_id,
      l.name,
      l.user_name,
      l.user_id,
      l.action === "paid" && l.undone ? "оплата (отменена)" : ACTION_LABELS[l.action],
      l.old_date,
      l.new_date,
      l.created_at,
    ]),
  );
}
