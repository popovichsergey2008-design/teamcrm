import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { DEFAULT_COLOR_NAMES, guessColor, isStickerColor, parseWhen, STICKER_COLORS, When, whenLabel, ymd } from './sticker-rules';
import { StickerRow, StickersRepository } from './stickers.repository';

/** Длиннее — ИИ сокращает до заголовка в 1–2 строки, полный текст — внутрь (шаг 1.3). */
const LONG = 300;

export interface StickerOut {
  id: string; text: string; body: string | null; date: string | null; time: string | null; color: string;
  source: string; sourceRef: Record<string, unknown> | null; doneAt: string | null; deletedAt: string | null;
  taskId: string | null; eventId: string | null; position: number; createdAt: string;
  /** Напоминание ушло, а стикер не закрыт — красная точка (шаг 6.1). */
  reminded: boolean;
}

export const stickerOut = (r: StickerRow): StickerOut => ({
  id: r.id, text: r.text, body: r.body, date: r.due_date, time: r.due_time, color: r.color, source: r.source,
  sourceRef: r.source_ref, doneAt: r.done_at ? new Date(r.done_at).toISOString() : null,
  deletedAt: r.deleted_at ? new Date(r.deleted_at).toISOString() : null, taskId: r.task_id, eventId: r.event_id,
  position: Number(r.position), createdAt: new Date(r.created_at).toISOString(),
  reminded: !!r.reminded_at && !r.snooze_until && !r.done_at,
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/**
 * Стикеры-напоминалки (#4997, ТЗ 19.11.2026). Листок с одной мыслью: текст, дата и время
 * (необязательны), цвет. Личные — только автор. Дата сама из текста, цвет — по смыслу.
 */
@Injectable()
export class StickersService {
  private readonly log = new Logger('Stickers');

  constructor(private readonly repo: StickersRepository, private readonly ai: AiService) {}

  /** «Сейчас» в поясе человека: «завтра» и «сегодня» — по его часам, а не по серверу. */
  async localNow(tenantId: string, userId: string): Promise<Date> {
    const tz = (await this.repo.timezone(tenantId, userId))?.timezone || 'Europe/Moscow';
    try { return new Date(new Date().toLocaleString('en-US', { timeZone: tz })); } catch { return new Date(); }
  }

  async board(tenantId: string, userId: string) {
    const [rows, names, now] = await Promise.all([
      this.repo.open(tenantId, userId), this.repo.colorNames(userId), this.localNow(tenantId, userId),
    ]);
    return { items: rows.map(stickerOut), today: ymd(now), colors: this.colorsOut(names) };
  }

  archive(tenantId: string, userId: string, kind: 'done' | 'trash') {
    return this.repo.archive(tenantId, userId, kind).then((rows) => rows.map(stickerOut));
  }

  /** Предпросмотр «📅 пт, 20 ноября · 15:00» пока человек печатает (шаг 1.2). */
  async parse(tenantId: string, userId: string, text: string): Promise<When & { label: string; color: string }> {
    const now = await this.localNow(tenantId, userId);
    const w = parseWhen(text, now);
    return { ...w, label: whenLabel(w, now), color: guessColor(text) };
  }

  /**
   * Создать. Дата и время: переданы — как есть; `date: undefined` — из текста (бот, Telegram).
   * Цвет не выбран — по смыслу. Длинная надиктовка — заголовок ИИ, полный текст внутрь.
   */
  async create(tenantId: string, userId: string, p: {
    text: string; date?: string | null; time?: string | null; color?: string | null; source?: string;
    sourceRef?: Record<string, unknown> | null; fallbackDate?: 'today' | 'none';
  }): Promise<StickerOut> {
    let text = p.text.trim().replace(/\s+\n/g, '\n');
    if (!text) throw AppException.validation('Напишите, что не забыть');
    let body: string | null = null;
    if (text.length > LONG) {
      body = text;
      text = await this.title(tenantId, text);
    }
    let date = p.date === undefined ? undefined : p.date;
    let time = p.time === undefined ? undefined : p.time;
    if (date === undefined || time === undefined) {
      const w = parseWhen(body ?? text, await this.localNow(tenantId, userId));
      if (date === undefined) date = w.date ?? (p.fallbackDate === 'today' ? ymd(await this.localNow(tenantId, userId)) : null);
      if (time === undefined) time = w.time;
    }
    if (date !== null && date !== undefined && !DATE.test(date)) throw AppException.validation('Дата — в виде ГГГГ-ММ-ДД');
    if (time !== null && time !== undefined && !TIME.test(time)) throw AppException.validation('Время — в виде ЧЧ:ММ');
    const color = p.color && isStickerColor(p.color) ? p.color : guessColor(body ?? text);
    const row = await this.repo.create({
      tenantId, userId, text: text.slice(0, 500), body, date: date ?? null, time: time ?? null, color,
      source: p.source ?? 'manual', sourceRef: p.sourceRef ?? null,
    });
    return stickerOut(row);
  }

  /** Заголовок длинной надиктовки: 1–2 строки. Без ИИ — первые слова. */
  private async title(tenantId: string, text: string): Promise<string> {
    const cut = () => `${text.slice(0, 120).replace(/\s+\S*$/, '')}…`;
    try {
      const r = await this.ai.generateWithModel(tenantId,
        'Сократи заметку до заголовка стикера: одна-две короткие строки, до 90 знаков, по-русски, без кавычек и точки в конце. '
        + 'Даты и время из заметки сохрани. Верни только заголовок.', text.slice(0, 4000), 'sticker_title');
      const t = String(r.text ?? '').trim().replace(/^["«]|["»]$/g, '');
      return !r.degraded && t && t.length <= 160 ? t : cut();
    } catch { return cut(); }
  }

  async update(tenantId: string, userId: string, id: string, p: {
    text?: string; date?: string | null; time?: string | null; color?: string; position?: number;
    taskId?: string | null; eventId?: string | null;
  }): Promise<StickerOut> {
    if (p.taskId && !/^\d+$/.test(p.taskId)) throw AppException.validation('Нет такой задачи');
    if (p.eventId && !/^\d+$/.test(p.eventId)) throw AppException.validation('Нет такого события');
    if (p.date && !DATE.test(p.date)) throw AppException.validation('Дата — в виде ГГГГ-ММ-ДД');
    if (p.time && !TIME.test(p.time)) throw AppException.validation('Время — в виде ЧЧ:ММ');
    if (p.color !== undefined && !isStickerColor(p.color)) throw AppException.validation('Такого цвета нет');
    if (p.text !== undefined && !p.text.trim()) throw AppException.validation('Стикер не может быть пустым');
    // без даты времени не бывает: «Без даты» убирает и время
    const time = p.date === null ? null : p.time;
    const row = await this.repo.patch(tenantId, userId, id, { ...p, text: p.text?.trim().slice(0, 500), time });
    if (!row) throw AppException.notFound('Стикер не найден');
    return stickerOut(row);
  }

  async mark(tenantId: string, userId: string, ids: string[], action: 'done' | 'undone' | 'delete' | 'restore') {
    const clean = ids.filter((x) => /^\d+$/.test(x)).slice(0, 500);
    if (!clean.length) throw AppException.validation('Не выбрано ни одного стикера');
    return { changed: await this.repo.mark(tenantId, userId, clean, action) };
  }

  async snooze(tenantId: string, userId: string, id: string, minutes: number) {
    const m = Math.min(24 * 60, Math.max(5, Math.round(minutes)));
    if (!(await this.repo.snooze(tenantId, userId, id, m))) throw AppException.notFound('Стикер не найден');
    return { snoozed: m };
  }

  async overdueToToday(tenantId: string, userId: string) {
    return { moved: await this.repo.overdueToToday(tenantId, userId, ymd(await this.localNow(tenantId, userId))) };
  }

  private colorsOut(names: Record<string, string>) {
    return STICKER_COLORS.map((c) => ({ key: c, name: (names[c] ?? '').trim() || DEFAULT_COLOR_NAMES[c] }));
  }

  async setColorNames(tenantId: string, userId: string, names: Record<string, string>) {
    const clean: Record<string, string> = {};
    for (const c of STICKER_COLORS) if (typeof names[c] === 'string' && names[c].trim()) clean[c] = names[c].trim().slice(0, 40);
    await this.repo.setColorNames(tenantId, userId, clean);
    return this.colorsOut(clean);
  }

  /** Сегодняшние открытые стикеры — для Фокуса дня, бота и утреннего списка. */
  async forDay(tenantId: string, userId: string, date?: string) {
    const day = date ?? ymd(await this.localNow(tenantId, userId));
    const all = await this.repo.open(tenantId, userId);
    return {
      date: day,
      items: all.filter((r) => r.due_date === day).map(stickerOut),
      overdue: all.filter((r) => r.due_date && r.due_date < day).map(stickerOut),
    };
  }

  purge() { return this.repo.purge(); }
}
