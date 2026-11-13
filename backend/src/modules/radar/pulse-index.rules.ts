/**
 * Индекс здоровья команды v2 (#4890, п. 1).
 *
 * Было (health_v1): каждая часть считалась от абсолютных порогов — «минус 15 за каждого
 * перегруженного», «минус 150% за долю застрявших». У живой команды три части из пяти
 * упирались в ноль, и закрытие просрочки или проверки индекс не двигало вовсе.
 *
 * Стало: те же пять частей и те же веса, но каждая часть = 40% уровня (прежняя шкала,
 * без штрафов-обрывов) + 60% динамики относительно СОБСТВЕННОЙ базы команды — медианы
 * той же величины за прошлые 4–8 недель. Динамика — гладкая кривая без потолка и пола
 * (tanh от логарифма отношения), поэтому любое улучшение сдвигает индекс хоть немного.
 * Индекс храним с точностью до десятой, на экране — целое; дельта после действия — с
 * десятыми, если целое не поменялось.
 */

export const INDEX_VERSION = 'health_v2';

export type ComponentKey = 'delivery' | 'deadlines' | 'flow' | 'capacity' | 'velocity';
export const COMPONENTS: ComponentKey[] = ['delivery', 'deadlines', 'flow', 'capacity', 'velocity'];

/** Веса прежние (п. 1: «формула и веса остаются прежними»). */
export const WEIGHTS: Record<ComponentKey, number> = { delivery: 0.25, deadlines: 0.2, flow: 0.2, capacity: 0.2, velocity: 0.15 };

export const COMPONENT_TITLE: Record<ComponentKey, string> = {
  delivery: 'Закрываем столько, сколько приходит', deadlines: 'Сроки', flow: 'Движение задач (проверка)', capacity: 'Загрузка', velocity: 'Скорость',
};

export const COMPONENT_HINT: Record<ComponentKey, string> = {
  delivery: 'Закрыто за 30 дней против заведённых за 30 дней.',
  deadlines: 'Просроченные задачи в работе (сданное на проверку — не просрочка исполнителя).',
  flow: 'Сколько задач ждёт проверки, тестирования или приёмки.',
  capacity: 'Задачи без исполнителя и сверх 12 открытых задач на человека.',
  velocity: 'Закрыто задач за 7 дней.',
};

/** Срез величин в один момент времени: сейчас или конец прошлой недели. */
export interface IndexPoint {
  closed7: number; created7: number; closed30: number; created30: number;
  open: number; withDeadline: number; overdue: number; review: number; noAssignee: number; excess: number;
}

export const EMPTY_POINT: IndexPoint = { closed7: 0, created7: 0, closed30: 0, created30: 0, open: 0, withDeadline: 0, overdue: 0, review: 0, noAssignee: 0, excess: 0 };

/** Крутизна кривой динамики: одна проверка из 80 — около +2 к части «Движение». */
export const K = 4;
export const LEVEL_SHARE = 0.4;

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const r1 = (v: number) => Math.round(v * 10) / 10;

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Какую величину сравниваем с базой и в какую сторону лучше. */
const METRIC: Record<ComponentKey, { of: (p: IndexPoint) => number; better: 'higher' | 'lower'; ratio?: boolean }> = {
  delivery: { of: (p) => (p.closed30 + 1) / (p.created30 + 1), better: 'higher', ratio: true },
  deadlines: { of: (p) => p.overdue, better: 'lower' },
  flow: { of: (p) => p.review, better: 'lower' },
  capacity: { of: (p) => p.noAssignee + p.excess, better: 'lower' },
  velocity: { of: (p) => p.closed7, better: 'higher' },
};

/** Уровень — прежняя шкала части, без штрафов-обрывов в ноль. */
export function levelOf(k: ComponentKey, p: IndexPoint, prev: IndexPoint | null): number {
  switch (k) {
    case 'delivery': return p.created30 === 0 ? (p.closed30 > 0 ? 100 : 75) : clamp((100 * p.closed30) / p.created30);
    case 'deadlines': return p.withDeadline ? clamp(100 * (1 - p.overdue / p.withDeadline)) : 100;
    case 'flow': return p.open ? clamp(100 - (150 * p.review) / p.open) : 100;
    case 'capacity': return p.open ? clamp(100 - (150 * (p.noAssignee + p.excess)) / p.open) : 100;
    case 'velocity': {
      const before = prev?.closed7 ?? 0;
      return before === 0 ? (p.closed7 > 0 ? 80 : 50) : clamp(75 + 50 * (p.closed7 / before - 1));
    }
    default: return 50;
  }
}

/** Динамика к базе: 50 — как обычно; выше — лучше своей нормы. Никогда не упирается в 0 или 100. */
export function dynamicsOf(k: ComponentKey, cur: IndexPoint, base: IndexPoint[]): { value: number; cur: number; base: number } {
  const m = METRIC[k];
  const c = m.of(cur);
  const b = base.length ? median(base.map(m.of)) : c;
  let ratio: number;
  if (m.ratio) ratio = b > 0 ? c / b : 1;
  else ratio = m.better === 'higher' ? (c + 1) / (b + 1) : (b + 1) / (c + 1);
  return { value: 50 + 50 * Math.tanh(K * Math.log(ratio)), cur: r1(c), base: r1(b) };
}

export interface IndexResult {
  score: number;
  components: Record<ComponentKey, number>;
  parts: Record<ComponentKey, { level: number; dynamics: number; cur: number; base: number }>;
}

export function indexOf(cur: IndexPoint, prev: IndexPoint | null, base: IndexPoint[]): IndexResult {
  const components = {} as Record<ComponentKey, number>;
  const parts = {} as IndexResult['parts'];
  let score = 0;
  for (const k of COMPONENTS) {
    const level = levelOf(k, cur, prev);
    const d = dynamicsOf(k, cur, base);
    const value = r1(LEVEL_SHARE * level + (1 - LEVEL_SHARE) * d.value);
    components[k] = value;
    parts[k] = { level: r1(level), dynamics: r1(d.value), cur: d.cur, base: d.base };
    score += WEIGHTS[k] * value;
  }
  return { score: r1(score), components, parts };
}

/**
 * Ряд по неделям: points[0] — сейчас, points[k] — k недель назад. База для точки k —
 * точки k+1…k+8 (не меньше одной), поэтому тренд и мини-график считаются одной формулой
 * за один и тот же период (п. 1).
 */
export function series(points: IndexPoint[], weeks = 8): number[] {
  const out: number[] = [];
  for (let k = Math.min(weeks, points.length) - 1; k >= 0; k--) {
    const base = points.slice(k + 1, k + 9);
    out.push(indexOf(points[k], points[k + 1] ?? null, base).score);
  }
  return out;
}

/** Что будет с индексом, если величины сейчас изменятся на delta — «индекс +N» по формуле (п. 2, 7). */
export function effectOf(points: IndexPoint[], delta: Partial<IndexPoint>): number {
  if (!points.length) return 0;
  const base = points.slice(1, 9);
  const cur = points[0];
  const next: IndexPoint = { ...cur };
  for (const [k, v] of Object.entries(delta) as [keyof IndexPoint, number][]) next[k] = Math.max(0, (next[k] ?? 0) + v);
  return r1(indexOf(next, points[1] ?? null, base).score - indexOf(cur, points[1] ?? null, base).score);
}

/** Сделанное «принятие» n проверок: очередь меньше, закрытых больше (те же три величины, что в формуле). */
export const acceptDelta = (n: number): Partial<IndexPoint> => ({ review: -n, open: -n, closed7: n, closed30: n });

export type Zone = 'healthy' | 'normal' | 'risk' | 'help';

/** Зоны без «Критично» красным первым на экране (п. 1). */
export function zoneOf(score: number): Zone {
  if (score >= 70) return 'healthy';
  if (score >= 55) return 'normal';
  if (score >= 40) return 'risk';
  return 'help';
}

export const ZONE_TITLE: Record<Zone, string> = { healthy: 'здорово', normal: 'норма', risk: 'зона риска', help: 'нужна помощь' };

const GOOD: Record<ComponentKey, string> = {
  velocity: 'Команда разгоняется', delivery: 'Закрываете больше, чем приходит', deadlines: 'Просрочек меньше обычного',
  flow: 'Проверка идёт быстрее обычного', capacity: 'Нагрузка ровнее обычного',
};
const BAD: Record<ComponentKey, string> = {
  velocity: 'темп ниже обычного', delivery: 'копится бэклог', deadlines: 'мешают просрочки', flow: 'тормозит проверка', capacity: 'перекос нагрузки',
};
const BAD_FIRST: Record<ComponentKey, string> = {
  velocity: 'Темп ниже обычного', delivery: 'Копится бэклог', deadlines: 'Мешают просрочки', flow: 'Тормозит проверка', capacity: 'Перекос нагрузки',
};

/** Заголовок одной фразой: что хорошо и что мешает (п. 1). */
export function headlineOf(r: IndexResult): string {
  const byDyn = [...COMPONENTS].sort((a, b) => r.parts[b].dynamics - r.parts[a].dynamics);
  const best = byDyn[0];
  const worst = [...COMPONENTS].sort((a, b) => r.components[a] - r.components[b])[0];
  const good = r.parts[best].dynamics >= 55 ? GOOD[best] : null;
  const bad = r.components[worst] < 55 ? worst : null;
  if (good && bad && bad !== best) return `${good}, ${BAD[bad]}`;
  if (good) return `${good}, серьёзных тормозов нет`;
  if (bad) return `${BAD_FIRST[bad]} — с неё и начните`;
  return 'Команда работает в обычном темпе';
}

/** Формула словами — «из чего складывается» (п. 1). */
export function formulaText(r: IndexResult): string {
  const sum = COMPONENTS.map((k) => `${r.components[k]}×${Math.round(WEIGHTS[k] * 100)}%`).join(' + ');
  return `Каждая часть = 40% уровня + 60% динамики к собственной базе команды (медиана за прошлые 4–8 недель; 50 — как обычно). Итог: ${sum} = ${r.score}.`;
}

/** Строка под заголовком: «закрыто 48 задач против 34 · лучшая неделя за 2 месяца». */
export function speedLine(points: IndexPoint[]): string {
  if (!points.length) return '';
  const now = points[0].closed7; const prev = points[1]?.closed7 ?? 0;
  const parts = [`закрыто ${now} ${now % 10 === 1 && now % 100 !== 11 ? 'задача' : 'задач'} против ${prev}`];
  const before = points.slice(1, 9).map((p) => p.closed7);
  if (before.length >= 4 && now > 0 && now > Math.max(...before)) parts.push('лучшая неделя за 2 месяца');
  return parts.join(' · ');
}
