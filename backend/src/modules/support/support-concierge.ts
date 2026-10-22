/**
 * Консьерж-поддержка (ТЗ-29) — чистые правила: статус инженера, честная оценка
 * ожидания, итог помощи, неудачные запросы для диагностики.
 */

export type EngineerStatus = 'available' | 'busy' | 'in_huddle' | 'away' | 'offline';
export const MANUAL_STATUSES = ['available', 'busy', 'away'] as const;
export type ManualStatus = (typeof MANUAL_STATUSES)[number];

/**
 * Статус инженера (п. 7): не «фальшивый онлайн», а из того, что есть.
 * Порядок важен: не в сети и вне смены — «не в сети», что бы ни стояло вручную;
 * «отошёл» — его слово; идущий созвон — «на созвоне»; ручное «занят» или полная
 * загрузка — «занят».
 */
export function engineerStatus(i: {
  online: boolean; manual: ManualStatus | null; inHuddle: boolean;
  load: number; maxLoad: number; hasShifts: boolean; onShift: boolean;
}): EngineerStatus {
  if (!i.online) return 'offline';
  if (i.hasShifts && !i.onShift) return 'offline';
  if (i.manual === 'away') return 'away';
  if (i.inHuddle) return 'in_huddle';
  if (i.manual === 'busy' || (i.maxLoad > 0 && i.load >= i.maxLoad)) return 'busy';
  return 'available';
}

export const STATUS_TEXT: Record<EngineerStatus, string> = {
  available: 'на связи',
  busy: 'занят',
  in_huddle: 'на созвоне',
  away: 'отошёл',
  offline: 'не в сети',
};

/**
 * Оценка ожидания (п. 8): не зашитые «16 секунд», а по очереди, свободным и медиане.
 * - есть свободный и очереди нет — медиана первого ответа, если она есть и до минуты,
 *   иначе «обычно меньше минуты»;
 * - свободных нет, но кто-то на связи — «примерно a–b минут» по длине очереди;
 * - никого — честно «сейчас никого», с обратным звонком.
 */
export function waitEstimate(i: { available: number; online: number; queue: number; medianSec: number | null }):
  { kind: 'now' | 'queue' | 'offline'; text: string; minutes: [number, number] | null } {
  if (i.available > 0 && i.queue < i.available) {
    if (i.medianSec !== null && i.medianSec > 0 && i.medianSec <= 60) {
      return { kind: 'now', text: `Среднее время ответа: ~ ${Math.max(5, Math.round(i.medianSec / 5) * 5)} секунд`, minutes: null };
    }
    return { kind: 'now', text: 'Обычно отвечаем меньше чем за минуту', minutes: null };
  }
  if (i.online > 0 || i.available > 0) {
    const per = Math.max(1, i.online || i.available);
    const a = Math.min(30, Math.max(2, Math.ceil(((i.queue + 1) * 3) / per)));
    const b = a + 2;
    return { kind: 'queue', text: `Примерное ожидание: ${a}–${b} минут`, minutes: [a, b] };
  }
  return { kind: 'offline', text: 'Сейчас инженеров нет на связи', minutes: null };
}

export interface Resolution { problem: string; fixed: string; checked: string; next: string }

/** Итог помощи от модели: JSON из четырёх строк; что угодно другое — null. */
export function parseResolution(raw: string): Resolution | null {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]) as Record<string, unknown>;
    const s = (k: string) => (typeof j[k] === 'string' ? (j[k] as string).replace(/\s+/g, ' ').trim().slice(0, 400) : '');
    const r = { problem: s('problem'), fixed: s('fixed'), checked: s('checked'), next: s('next') };
    return r.problem || r.fixed ? r : null;
  } catch {
    return null;
  }
}

/** Без модели — из последних слов разговора: честно и коротко. */
export function rulesResolution(subject: string, summary: string | null): Resolution {
  return {
    problem: subject.slice(0, 300),
    fixed: summary ? summary.replace(/\s+/g, ' ').trim().slice(0, 300) : 'Разобрали вопрос вместе со специалистом.',
    checked: '',
    next: '',
  };
}

export interface FailedRequest { method: string; path: string; status: number; requestId: string | null; at: string }

/**
 * Неудачные запросы для диагностики (п. 20): только метод, путь БЕЗ параметров, код и
 * номер запроса. Ни тел, ни заголовков, ни строки запроса — там бывают токены и почта.
 */
export function sanitizeFailedRequests(raw: unknown): FailedRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-5).flatMap((x) => {
    if (!x || typeof x !== 'object') return [];
    const r = x as Record<string, unknown>;
    const method = String(r.method ?? '').toUpperCase();
    if (!/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) return [];
    const path = String(r.path ?? '').split('?')[0].split('#')[0]
      // числа и длинные ключи в пути — на «:id», чтобы не утекали токены ссылок
      .replace(/\/[A-Za-z0-9_-]{20,}/g, '/:token')
      .slice(0, 160);
    if (!path.startsWith('/')) return [];
    const status = Number(r.status);
    const requestId = typeof r.requestId === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(r.requestId) ? r.requestId : null;
    const at = typeof r.at === 'string' && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : new Date().toISOString();
    return [{ method, path, status: Number.isFinite(status) ? status : 0, requestId, at }];
  });
}

/**
 * Телеметрия экрана (ТЗ-34, 3.5): размер экрана и окна, ориентация, плотность и
 * название открытой карточки. Только числа из белого списка и короткая строка —
 * ничего, что человек не видит на своём экране сам.
 */
export interface Telemetry { screen?: string; viewport?: string; orientation?: 'portrait' | 'landscape'; dpr?: number; entityTitle?: string }

export function sanitizeTelemetry(raw: unknown): Telemetry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const size = (v: unknown) => (typeof v === 'string' && /^\d{2,5}×\d{2,5}$/.test(v) ? v : undefined);
  const out: Telemetry = {
    screen: size(r.screen),
    viewport: size(r.viewport),
    orientation: r.orientation === 'portrait' || r.orientation === 'landscape' ? r.orientation : undefined,
    dpr: typeof r.dpr === 'number' && r.dpr > 0 && r.dpr < 10 ? Math.round(r.dpr * 100) / 100 : undefined,
    entityTitle: typeof r.entityTitle === 'string' && r.entityTitle.trim() ? r.entityTitle.replace(/\s+/g, ' ').trim().slice(0, 120) : undefined,
  };
  return Object.values(out).some((v) => v !== undefined) ? out : null;
}

/** Сколько живёт доступ инженера к настройкам (п. 45). */
export const ACCESS_MINUTES = 15;
