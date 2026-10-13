/**
 * Определитель проекта (ТЗ-31, «AI Project Resolver») — чистые правила, без базы.
 *
 * Главное правило ТЗ: **лучше спросить, чем уверенно поставить задачу не туда**.
 * Поэтому на выходе не один проект, а уверенность и варианты:
 *   HIGH   (≥ 0,90) — подставляем, но всегда показываем, откуда взяли;
 *   MEDIUM (0,65–0,89) — предлагаем 2–3 варианта, человек выбирает;
 *   LOW    (< 0,65) — спрашиваем.
 *
 * Работает только с теми проектами, что ему дали: вызывающий код заранее оставляет
 * живые (не архивные) и видимые человеку — права ДО любых догадок (§23). Модель здесь
 * не участвует: её выбор среди короткого списка приходит готовым сигналом `model`.
 *
 * Сигналы складываются как независимые свидетельства (1 − Π(1 − s)): два средних
 * сигнала за один проект сильнее одного. Недавность — только слабый довесок и сама
 * по себе проект не выбирает (§38).
 */

import { latinKey } from './event-draft';

export type ReasonCode =
  | 'EXPLICIT_PROJECT_MENTION'
  | 'SOURCE_PROJECT'
  | 'CHAT_PROJECT'
  | 'MEETING_PROJECT'
  | 'CLIENT_RELATION'
  | 'CURRENT_ROUTE'
  | 'PEOPLE_PROJECT'
  | 'SEMANTIC_MATCH'
  | 'RECENT_PROJECT'
  | 'ONLY_PROJECT';

export type Level = 'HIGH' | 'MEDIUM' | 'LOW';
export type ResolutionKind = 'AUTO_HIGH_CONFIDENCE' | 'SUGGESTED' | 'NEEDS_CHOICE' | 'NOT_FOUND';

export interface ResolverProject {
  id: string;
  name: string;
  /** Другие названия: «Alpha», «Клиент Альфа» (§24). */
  aliases?: string[] | null;
  clientId?: string | null;
  clientName?: string | null;
}

export interface ResolverInput {
  /** Текст задачи или расшифровка — для «названо прямо» и клиента. */
  text: string;
  projects: ResolverProject[];
  /** Откуда запущено создание: доска, карточка задачи. */
  sourceProjectId?: string | null;
  /** Чат проекта или чат задачи (§12). */
  chatProjectId?: string | null;
  meetingProjectId?: string | null;
  /** Открытый экран (/projects/130), если запуск не из самого проекта. */
  routeProjectId?: string | null;
  /** Клиент источника (клиентский чат, встреча с клиентом). */
  clientId?: string | null;
  /**
   * Участники разговора (автор, собеседник, упомянутые) → в каких проектах каждый
   * работает. Проект, где работают все, — сильная подсказка в личной переписке.
   */
  people?: { userId: string; projectIds: string[] }[];
  /** Недавние задачи человека по проектам (за 14 дней). */
  recent?: Record<string, number>;
  /** Выбор модели среди короткого списка, если правила не уверены. */
  model?: { projectId: string; confidence: number } | null;
}

export interface Candidate { projectId: string; name: string; confidence: number; reasonCodes: ReasonCode[] }

export interface Resolution {
  projectId: string | null;
  projectName: string | null;
  confidence: number;
  level: Level;
  resolution: ResolutionKind;
  reasonCodes: ReasonCode[];
  /** Другие вероятные — для MEDIUM/LOW, без выбранного. */
  alternatives: Candidate[];
  /** «Проект Tesla» назван, но такого нет среди доступных (§20). */
  notFoundName: string | null;
  /** Короткое объяснение для экрана, без внутренней кухни (§33). */
  hint: string;
}

export const HIGH = 0.9;
export const MEDIUM = 0.65;

const W: Record<ReasonCode, number> = {
  EXPLICIT_PROJECT_MENTION: 0.97,
  CHAT_PROJECT: 0.95,
  SOURCE_PROJECT: 0.93,
  MEETING_PROJECT: 0.92,
  CLIENT_RELATION: 0.9,
  CURRENT_ROUTE: 0.8,
  PEOPLE_PROJECT: 0.7,
  SEMANTIC_MATCH: 0.75,
  RECENT_PROJECT: 0.15,
  ONLY_PROJECT: 0.95,
};

const HINT: Record<ReasonCode, string> = {
  EXPLICIT_PROJECT_MENTION: 'проект назван в тексте',
  CHAT_PROJECT: 'чат этого проекта',
  SOURCE_PROJECT: 'создаётся из этого проекта',
  MEETING_PROJECT: 'проект встречи',
  CLIENT_RELATION: 'проект клиента',
  CURRENT_ROUTE: 'открыт этот проект',
  PEOPLE_PROJECT: 'проект, где вы работаете вместе',
  SEMANTIC_MATCH: 'по смыслу задачи',
  RECENT_PROJECT: 'ваши недавние задачи',
  ONLY_PROJECT: 'в компании один проект',
};

/** Порядок важности причин — для подписи берём самую весомую. */
const ORDER: ReasonCode[] = [
  'EXPLICIT_PROJECT_MENTION', 'CHAT_PROJECT', 'SOURCE_PROJECT', 'MEETING_PROJECT', 'CLIENT_RELATION',
  'ONLY_PROJECT', 'CURRENT_ROUTE', 'SEMANTIC_MATCH', 'PEOPLE_PROJECT', 'RECENT_PROJECT',
];

const STOP = new Set(['и', 'в', 'на', 'по', 'для', 'the', 'проект', 'проекта', 'проекту', 'проекте', 'crm']);
const words = (t: string) => t.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/i).filter(Boolean);
const keysOf = (name: string) => words(name).filter((w) => w.length >= 3 && !STOP.has(w)).map(latinKey).filter((k) => k.length >= 2);
function sameWord(spoken: string, target: string): boolean {
  if (spoken === target) return true;
  if (target.length < 4) return false;
  return spoken.startsWith(target.slice(0, target.length - 1)) && spoken.length <= target.length + 2;
}

/**
 * Какие названия прозвучали целиком (все значимые слова). Возвращает id с лучшим
 * совпадением; ничья между РАЗНЫМИ проектами — никого (угадайка не нужна).
 */
export function namedIn(text: string, items: { id: string; names: string[] }[]): string | null {
  const spoken = words(text).map(latinKey).filter(Boolean);
  if (!spoken.length) return null;
  let best: { id: string; score: number } | null = null;
  let tie = false;
  for (const it of items) {
    for (const n of it.names) {
      const keys = keysOf(n ?? '');
      if (!keys.length || !keys.every((k) => spoken.some((s) => sameWord(s, k)))) continue;
      const score = keys.length;
      if (!best || score > best.score) { best = { id: it.id, score }; tie = false; }
      else if (score === best.score && best.id !== it.id) tie = true;
    }
  }
  return best && !tie ? best.id : null;
}

/** «в проекте Tesla», «по проекту "Новый сайт"» — что человек назвал проектом. */
export function spokenProjectName(text: string): string | null {
  const m = /(?:^|[^a-zа-яё])(?:в|по|для|из)?\s*проект(?:е|у|а|ом)?\s+[«"']?([a-zа-яё0-9][a-zа-яё0-9-]*(?:\s+[a-zа-яё0-9][a-zа-яё0-9-]*){0,2})/i.exec(text);
  if (!m) return null;
  // обрезаем на служебном слове: «в проекте Tesla поставь Глебу» → «Tesla»
  const stopAt = /^(постав|сдела|созда|добав|задач|нужн|надо|до|к|и|а|что|чтобы|глеб|котор)/i;
  const parts = m[1].split(/\s+/);
  const kept: string[] = [];
  // и на глаголе в неопределённой форме: «по проекту Tesla обновить баннер» → «Tesla»
  for (const p of parts) { if (kept.length && (stopAt.test(p) || /(ть|ти|чь)$/i.test(p))) break; kept.push(p); }
  const name = kept.join(' ').trim();
  return name.length >= 2 ? name : null;
}

export function resolveProject(i: ResolverInput): Resolution {
  const byId = new Map(i.projects.map((p) => [String(p.id), p]));
  const ev = new Map<string, { s: number[]; codes: ReasonCode[] }>();
  const add = (id: string | null | undefined, code: ReasonCode, s = W[code]) => {
    if (!id || !byId.has(String(id)) || s <= 0) return;
    const e = ev.get(String(id)) ?? { s: [], codes: [] };
    e.s.push(Math.min(0.99, s));
    if (!e.codes.includes(code)) e.codes.push(code);
    ev.set(String(id), e);
  };

  const text = i.text ?? '';
  const explicit = namedIn(text, i.projects.map((p) => ({ id: String(p.id), names: [p.name, ...(p.aliases ?? [])] })));
  add(explicit, 'EXPLICIT_PROJECT_MENTION');
  add(i.chatProjectId, 'CHAT_PROJECT');
  add(i.sourceProjectId, 'SOURCE_PROJECT');
  add(i.meetingProjectId, 'MEETING_PROJECT');
  if (i.routeProjectId && i.routeProjectId !== i.sourceProjectId) add(i.routeProjectId, 'CURRENT_ROUTE');

  // Клиент: названный в тексте или клиент источника → его проекты (§14)
  const clientNamed = namedIn(text, i.projects.filter((p) => p.clientId && p.clientName)
    .map((p) => ({ id: String(p.clientId), names: [p.clientName!] })));
  for (const cid of new Set([clientNamed, i.clientId].filter(Boolean) as string[])) {
    const own = i.projects.filter((p) => String(p.clientId ?? '') === String(cid));
    for (const p of own) add(p.id, 'CLIENT_RELATION', own.length === 1 ? W.CLIENT_RELATION : 0.7);
  }

  // Участники: проект, где работают все, — 0,7; где часть — пропорционально, не выше 0,45
  if (i.people?.length) {
    const total = i.people.length;
    const count = new Map<string, number>();
    for (const p of i.people) for (const pid of new Set(p.projectIds.map(String))) count.set(pid, (count.get(pid) ?? 0) + 1);
    const everyone = [...count.entries()].filter(([, n]) => n === total).map(([id]) => id);
    for (const [id, n] of count) {
      const s = n === total ? (everyone.length === 1 ? W.PEOPLE_PROJECT : 0.5) : 0.45 * (n / total);
      add(id, 'PEOPLE_PROJECT', s);
    }
  }

  if (i.model && i.model.confidence > 0) add(i.model.projectId, 'SEMANTIC_MATCH', Math.min(W.SEMANTIC_MATCH, i.model.confidence * 0.8));
  for (const [id, n] of Object.entries(i.recent ?? {})) if (n > 0) add(id, 'RECENT_PROJECT', Math.min(W.RECENT_PROJECT, 0.05 * n));
  if (i.projects.length === 1) add(i.projects[0].id, 'ONLY_PROJECT');

  const notFound = !explicit ? spokenProjectName(text) : null;
  const notFoundName = notFound && !namedIn(notFound, i.projects.map((p) => ({ id: String(p.id), names: [p.name, ...(p.aliases ?? [])] })))
    ? notFound : null;

  const ranked: Candidate[] = [...ev.entries()].map(([id, e]) => {
    let c = 1 - e.s.reduce((acc, s) => acc * (1 - s), 1);
    // одна недавность — не основание (§38)
    if (e.codes.length === 1 && e.codes[0] === 'RECENT_PROJECT') c = Math.min(c, 0.3);
    return {
      projectId: id, name: byId.get(id)!.name, confidence: Math.round(c * 100) / 100,
      reasonCodes: [...e.codes].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)),
    };
  }).sort((a, b) => b.confidence - a.confidence || ORDER.indexOf(a.reasonCodes[0]) - ORDER.indexOf(b.reasonCodes[0]));

  const top = ranked[0] ?? null;
  const second = ranked[1] ?? null;
  let confidence = top?.confidence ?? 0;
  // Назвали проект, которого нет, — не подставляем молча другой (§20)
  if (notFoundName) confidence = Math.min(confidence, MEDIUM - 0.01);
  /*
    Два сильных кандидата рядом (чат одного проекта, а в тексте назван другой) — это
    сомнение. Явно названный проект выигрывает, остальным нужна заметная разница.
  */
  const close = !!second && top!.confidence - second.confidence < 0.05;
  const explicitTop = !!top && top.reasonCodes[0] === 'EXPLICIT_PROJECT_MENTION';
  let level: Level = confidence >= HIGH && (!close || explicitTop) ? 'HIGH' : confidence >= MEDIUM ? 'MEDIUM' : 'LOW';
  if (level === 'HIGH' && close && !explicitTop) level = 'MEDIUM';

  const resolution: ResolutionKind = notFoundName ? 'NOT_FOUND' : level === 'HIGH' ? 'AUTO_HIGH_CONFIDENCE' : level === 'MEDIUM' ? 'SUGGESTED' : 'NEEDS_CHOICE';
  const chosen = level === 'LOW' ? null : top;
  return {
    projectId: chosen?.projectId ?? null,
    projectName: chosen?.name ?? null,
    confidence: Math.round(confidence * 100) / 100,
    level,
    resolution,
    reasonCodes: top?.reasonCodes ?? [],
    alternatives: ranked.filter((c) => c.projectId !== chosen?.projectId).slice(0, 3),
    notFoundName,
    hint: chosen ? HINT[chosen.reasonCodes[0]] : '',
  };
}

/** Подпись причины — для экрана. */
export const reasonHint = (code: ReasonCode) => HINT[code];
