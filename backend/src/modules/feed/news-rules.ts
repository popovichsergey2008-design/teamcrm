/**
 * Правила «Новостей» (ТЗ-20) — чистые функции, без базы и без модели.
 *
 * Здесь решается, ЧТО и КОГДА попадает в ленту: есть ли повод для хайлайта дня, кто
 * герой, как звучит текст по фактам, что войдёт в выводы недели. Модель потом может
 * только переписать готовый текст живее (если у организации есть ключ) — цифры и
 * источники она не трогает (§86 «AI не придумывает цифры»).
 */

export const POST_TYPES = [
  'manual', 'announcement', 'kudos', 'poll', 'highlight', 'learnings', 'milestone', 'release', 'victory',
] as const;
export type PostType = typeof POST_TYPES[number];

/** Фильтры ленты (§45) → какие типы показывать. */
export const FEED_FILTERS: Record<string, PostType[]> = {
  all: [...POST_TYPES],
  highlights: ['highlight', 'learnings', 'victory'],
  kudos: ['kudos'],
  releases: ['release', 'milestone'],
  polls: ['poll'],
  announcements: ['announcement'],
};

export const VISIBILITIES = ['all', 'department', 'project', 'custom'] as const;
export type Visibility = typeof VISIBILITIES[number];

/** Реакции (§24) — пять, не больше: выбор из двадцати превращает реакцию в труд. */
export const REACTIONS = ['❤️', '🔥', '👏', '🎉', '💡'] as const;

/** Бейджи благодарности (§22). */
export const KUDOS_BADGES: Record<string, string> = {
  saver: 'Спаситель дня',
  team: 'Командный игрок',
  quality: 'Мастер качества',
  speed: 'Скорость света',
  idea: 'Лучшее решение',
  help: 'Помощь коллегам',
};

/** Закреплённых сверху — не больше трёх (§46): иначе закреплённое перестаёт выделяться. */
export const MAX_PINNED = 3;

/**
 * Лимиты от спама (§79): сколько чего человек может опубликовать за окно.
 * Цифры с запасом для живой работы и тесные для скрипта или вспышки раздражения.
 */
export const RATE_LIMITS: Record<string, { max: number; windowHours: number; message: string }> = {
  post: { max: 20, windowHours: 1, message: 'Слишком много публикаций подряд — попробуйте через час' },
  kudos: { max: 15, windowHours: 24, message: 'Сегодня вы уже поблагодарили многих — продолжим завтра' },
  poll: { max: 10, windowHours: 24, message: 'Сегодня создано уже 10 опросов — продолжим завтра' },
  comment: { max: 60, windowHours: 1, message: 'Слишком много комментариев подряд — сделайте паузу' },
};

// ───────────────────────── хайлайт дня ─────────────────────────

export interface DayFacts {
  /** День, о котором хайлайт (местная дата организации, ГГГГ-ММ-ДД). */
  date: string;
  completedTasks: number;
  projectsAffected: number;
  /** Самые заметные закрытые задачи (срочные/высокие первыми) — для «главного результата». */
  topTasks: { id: string; title: string; projectId: string; projectName: string | null; priority: string }[];
  meetingsCount: number;
  meetingsMinutes: number;
  decisions: number;
  /** Релизы и вехи, опубликованные в ленте за день: хайлайт ссылается на них, а не дублирует. */
  releases: { postId: string; title: string }[];
  kudos: { toUserId: string; toName: string }[];
  /** Снятые затыки: просьбы о переносе решены, блокеры сняты. */
  blockersResolved: number;
  /** Закрыто за 7 дней против предыдущих 7 — для «быстрее прошлой недели». */
  weekClosed: number;
  prevWeekClosed: number;
  /** Закрывшие срочные/высокие задачи — кандидаты в герои наряду с Kudos. */
  criticalClosers: { userId: string; name: string; count: number }[];
}

/** Порог повода (решение заказчика 11.10): без повода — честный пропуск, а не пустой пафос. */
export const HIGHLIGHT_MIN_TASKS = 5;

export function highlightReason(f: DayFacts): string | null {
  if (f.releases.length) return 'release';
  if (f.completedTasks >= HIGHLIGHT_MIN_TASKS) return 'tasks';
  if (f.kudos.length) return 'kudos';
  if (f.blockersResolved > 0) return 'blockers';
  return null;
}

/** По выходным хайлайт не публикуем (решение 11.10): «вчера» для понедельника — пятница. */
export function isWeekend(isoDow: number): boolean {
  return isoDow === 6 || isoDow === 7;
}

/**
 * Герой дня (§14, решение 11.10): только благодарности и закрытые критичные задачи —
 * никаких кликов, часов в сети и сообщений. Нет явного лидера — героя нет.
 */
export function pickHero(f: DayFacts): { userId: string; name: string; why: string } | null {
  const score = new Map<string, { name: string; kudos: number; critical: number }>();
  for (const k of f.kudos) {
    const s = score.get(k.toUserId) ?? { name: k.toName, kudos: 0, critical: 0 };
    s.kudos++;
    score.set(k.toUserId, s);
  }
  for (const c of f.criticalClosers) {
    const s = score.get(c.userId) ?? { name: c.name, kudos: 0, critical: 0 };
    s.critical += c.count;
    score.set(c.userId, s);
  }
  const ranked = [...score.entries()]
    .map(([userId, s]) => ({ userId, name: s.name, kudos: s.kudos, critical: s.critical, total: s.kudos * 2 + s.critical }))
    .sort((a, b) => b.total - a.total);
  const top = ranked[0];
  if (!top || top.total < 2) return null;
  // ничья — героя нет: делить «героя» на двоих значит устроить рейтинг
  if (ranked[1] && ranked[1].total === top.total) return null;
  const why = top.kudos && top.critical
    ? `благодарностей: ${top.kudos}, закрыто критичных задач: ${top.critical}`
    : top.kudos ? `благодарностей от коллег: ${top.kudos}` : `закрыто критичных задач: ${top.critical}`;
  return { userId: top.userId, name: top.name, why };
}

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export interface Source { label: string; path: string }

/**
 * Текст хайлайта правилами. Каждая строка — факт из базы; ссылки-источники рядом (§86).
 * Коротко и без канцелярита (§80): 2–4 строки, ни одной восклицательной без повода.
 */
/** `when` — «Вчера», а в понедельник «В пятницу и выходные»: хайлайт за три дня сразу. */
export function highlightText(f: DayFacts, hero: { name: string; why: string } | null, when = 'Вчера'): { title: string; body: string; sources: Source[] } {
  const lines: string[] = [];
  const sources: Source[] = [];
  const parts: string[] = [];
  if (f.completedTasks > 0) {
    parts.push(`закрыла ${f.completedTasks} ${plural(f.completedTasks, 'задачу', 'задачи', 'задач')}`
      + (f.projectsAffected > 1 ? ` в ${f.projectsAffected} ${plural(f.projectsAffected, 'проекте', 'проектах', 'проектах')}` : ''));
  }
  if (f.meetingsCount > 0) {
    parts.push(`провела ${f.meetingsCount} ${plural(f.meetingsCount, 'созвон', 'созвона', 'созвонов')}`
      + (f.meetingsMinutes > 0 ? ` (${f.meetingsMinutes} мин)` : ''));
  }
  if (parts.length) lines.push(`${when} команда ${parts.join(' и ')}.`);

  if (f.releases.length) {
    lines.push(`Главный результат: ${f.releases.map((r) => `«${r.title}»`).join(', ')}.`);
    for (const r of f.releases) sources.push({ label: r.title, path: `/news/${r.postId}` });
  } else if (f.topTasks.length) {
    const t = f.topTasks[0];
    lines.push(`Главный результат: «${t.title}»${t.projectName ? ` (${t.projectName})` : ''}.`);
  }
  for (const t of f.topTasks.slice(0, 3)) sources.push({ label: t.title, path: `/projects/${t.projectId}/task/${t.id}` });

  if (f.decisions > 0) lines.push(`Принято ${f.decisions} ${plural(f.decisions, 'решение', 'решения', 'решений')}.`);
  if (f.blockersResolved > 0) lines.push(`Снято ${f.blockersResolved} ${plural(f.blockersResolved, 'препятствие', 'препятствия', 'препятствий')}.`);
  if (f.kudos.length) lines.push(`Коллеги сказали «спасибо» ${f.kudos.length} ${plural(f.kudos.length, 'раз', 'раза', 'раз')}.`);

  const trend = weekTrend(f.weekClosed, f.prevWeekClosed);
  if (trend) lines.push(trend);
  if (hero) lines.push(`Герой дня: ${hero.name} — ${hero.why}.`);

  return { title: 'AI-Хайлайты дня', body: lines.join('\n'), sources };
}

/** «На 15% быстрее прошлой недели» — только при заметной разнице и достаточном объёме. */
export function weekTrend(week: number, prev: number): string | null {
  if (prev < 5 || week < 5) return null;
  const pct = Math.round(((week - prev) / prev) * 100);
  if (pct >= 10) return `Команда закрывает задачи на ${pct}% быстрее прошлой недели.`;
  return null; // спад — тема «Пульса», а не новостей для всех (§5)
}

// ───────────────────────── выводы недели ─────────────────────────

export interface WeekFacts {
  decisions: { text: string; path: string }[];
  meetings: { title: string; path: string }[];
  releases: { title: string; path: string }[];
  blockersResolved: number;
  kudosCount: number;
  closedTasks: number;
}

/**
 * Выводы недели (§42–43). Каждая строка — со ссылкой на источник; строк без источника
 * не бывает. Мало материала (меньше двух пунктов) — пропуск, а не «неделя прошла хорошо».
 */
export function learningsText(w: WeekFacts): { title: string; body: string; sources: Source[] } | null {
  const lines: string[] = [];
  const sources: Source[] = [];
  for (const r of w.releases.slice(0, 3)) { lines.push(`• Вышло: «${r.title}».`); sources.push({ label: r.title, path: r.path }); }
  for (const d of w.decisions.slice(0, 4)) { lines.push(`• Решили: ${d.text}`); sources.push({ label: d.text.slice(0, 60), path: d.path }); }
  if (w.meetings.length) {
    lines.push(`• Итоги ${w.meetings.length} ${plural(w.meetings.length, 'встречи', 'встреч', 'встреч')} разобраны.`);
    for (const m of w.meetings.slice(0, 3)) sources.push({ label: m.title, path: m.path });
  }
  if (w.blockersResolved > 0) lines.push(`• Снято ${w.blockersResolved} ${plural(w.blockersResolved, 'препятствие', 'препятствия', 'препятствий')}.`);
  if (lines.length < 2) return null;
  const tail: string[] = [];
  if (w.closedTasks > 0) tail.push(`за неделю закрыто ${w.closedTasks} ${plural(w.closedTasks, 'задача', 'задачи', 'задач')}`);
  if (w.kudosCount > 0) tail.push(`благодарностей: ${w.kudosCount}`);
  const summary = tail.join(', ');
  const out = ['Главное за неделю', '', ...lines, ''];
  if (summary) out.push(`${summary[0].toUpperCase()}${summary.slice(1)}.`);
  out.push('Хороших выходных!');
  const body = out.join('\n');
  return { title: 'Выводы недели', body, sources };
}

// ───────────────────────── проверки публикации ─────────────────────────

/**
 * Модерация правилами (§55): похоже ли на утечку секрета. Модель для этого не нужна —
 * пароли, ключи и номера карт видны по виду.
 */
export function sensitiveHint(text: string): string | null {
  if (/(парол|password|passwd|пароль)\s*[:=]/i.test(text)) return 'Похоже на пароль в тексте — его увидит вся компания';
  if (/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{20,}\b/.test(text)) return 'Похоже на ключ доступа — его увидит вся компания';
  if (/\b(?:\d[ -]?){16}\b/.test(text) && luhnSomewhere(text)) return 'Похоже на номер банковской карты';
  return null;
}

function luhnSomewhere(text: string): boolean {
  const m = text.match(/\b(?:\d[ -]?){16}\b/g) ?? [];
  return m.some((raw) => {
    const d = raw.replace(/\D/g, '');
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
    }
    return sum % 10 === 0;
  });
}

/** Варианты опроса: 2–10 непустых и разных. */
export function cleanPollOptions(options: string[]): string[] | string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of options) {
    const t = String(o ?? '').trim().slice(0, 120);
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  if (out.length < 2) return 'Нужно минимум два разных варианта';
  if (out.length > 10) return 'Не больше десяти вариантов';
  return out;
}

/** Итог опроса (§37): победитель или ничья. */
export function pollWinner(counts: { optionId: string; label: string; votes: number }[]): { label: string } | { tie: string[] } | null {
  const max = Math.max(0, ...counts.map((c) => c.votes));
  if (max === 0) return null;
  const top = counts.filter((c) => c.votes === max);
  return top.length === 1 ? { label: top[0].label } : { tie: top.map((t) => t.label) };
}
