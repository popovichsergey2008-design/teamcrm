/**
 * «Вторая память» (ТЗ-21, этап 4) — чистые правила: запрос по словам, ссылка на источник,
 * нарезка переписки и реплик на фрагменты с якорем. Без базы — проверяются тестами.
 */

export type MemoryType =
  | 'task' | 'comment' | 'regulation' | 'gdoc' | 'meeting' | 'file'
  | 'chat' | 'decision' | 'news' | 'client_note' | 'project' | 'hub';

export const TYPE_LABEL: Record<MemoryType, string> = {
  task: 'Задача', comment: 'Комментарий', regulation: 'Регламент', gdoc: 'Документ', meeting: 'Встреча', file: 'Файл',
  chat: 'Переписка', decision: 'Решение', news: 'Новость', client_note: 'Клиент', project: 'Проект',
  hub: 'Инфоцентр',
};

/** Подпись раздела и категории записи Инфоцентра (#4659) — для текста в памяти. */
const HUB_SECTION: Record<string, string> = { passport: 'паспорт', team: 'команда', knowledge: 'база знаний' };
const HUB_CATEGORY: Record<string, string> = {
  site: 'сайт', app: 'приложение', admin: 'админка', social: 'соцсети', bot: 'бот',
  spec: 'ТЗ и спецификации', brand: 'брендбук', design: 'дизайн', repo: 'репозиторий', api: 'API',
  regulation: 'регламент', doc: 'документ', contractor: 'подрядчик', client: 'заказчик',
};
export function hubSectionLabel(section: string, category: string | null): string {
  const s = HUB_SECTION[section] ?? section;
  const c = category && HUB_CATEGORY[category];
  return c ? `${s} / ${c}` : s;
}

/** Куда вести из ответа. Якорь уточняет: секунда записи, сообщение, задача. */
export interface Anchor {
  sec?: number;
  chatId?: string;
  messageId?: string;
  taskId?: string;
  meetingId?: string;
  clientId?: string;
  decisionId?: string;
}

/**
 * Запрос по словам: любые из значимых слов (ИЛИ), с приставкой — «смет» найдёт «смету».
 * «И» по всем словам вопроса («что мы решили по форме») не находит почти ничего: в
 * тексте нет «что» и «мы» рядом с «формой». Ранжирование всё равно поднимает тексты,
 * где совпало больше слов.
 */
const STOP = new Set(['что', 'как', 'кто', 'где', 'когда', 'это', 'для', 'при', 'или', 'над', 'под', 'про', 'наш', 'наша', 'наши',
  'мы', 'вы', 'они', 'его', 'её', 'был', 'была', 'были', 'есть', 'там', 'тут', 'уже', 'ещё', 'еще', 'так', 'чем', 'чего', 'по']);

export function ftsQuery(q: string): string | null {
  const words = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .slice(0, 12);
  const uniq = [...new Set(words)];
  if (!uniq.length) return null;
  return uniq.map((w) => `${w}:*`).join(' | ');
}

export function memoryLink(type: string, sourceId: string, scope: string | null, a: Anchor | null): string | null {
  const anchor = a ?? {};
  switch (type) {
    case 'task': return scope ? `/projects/${scope}/task/${sourceId}` : null;
    case 'comment': return scope && anchor.taskId ? `/projects/${scope}/task/${anchor.taskId}` : null;
    case 'meeting': {
      const sec = anchor.sec != null ? Math.max(0, Math.floor(anchor.sec)) : null;
      return `/meetings/${anchor.meetingId ?? sourceId}${sec != null ? `?t=${sec}` : ''}`;
    }
    case 'chat': return anchor.chatId ? `/chat/${anchor.chatId}${anchor.messageId ? `?m=${anchor.messageId}` : ''}` : null;
    case 'decision':
      if (anchor.chatId) return `/chat/${anchor.chatId}${anchor.messageId ? `?m=${anchor.messageId}` : ''}`;
      if (anchor.meetingId) return `/meetings/${anchor.meetingId}${anchor.sec != null ? `?t=${Math.floor(anchor.sec)}` : ''}`;
      return null;
    case 'news': return `/news/${sourceId}`;
    case 'client_note': return anchor.clientId ? `/clients/${anchor.clientId}` : null;
    case 'project': return `/projects/${sourceId}`;
    // запись Инфоцентра — на доску проекта, Инфоцентр открывается по ?hub=
    case 'hub': return scope ? `/projects/${scope}?hub=${sourceId}` : null;
    default: return null;
  }
}

export interface Line { text: string; anchor: Anchor; at?: Date | string | null; authorId?: string | null }
export interface Part { text: string; anchor: Anchor; at: Date | string | null; authorId: string | null }

/**
 * Реплики и сообщения — в фрагменты по ~1000 знаков, не разрывая строку. Якорь фрагмента —
 * его первая строка: ответ ведёт туда, где разговор об этом начался. Автор — если весь
 * фрагмент сказал один человек (иначе фильтр «кто сказал» врал бы).
 */
export function groupLines(lines: Line[], max = 1000): Part[] {
  const out: Part[] = [];
  let cur: Line[] = [];
  let len = 0;
  const flush = () => {
    if (!cur.length) return;
    const authors = new Set(cur.map((l) => l.authorId ?? ''));
    out.push({
      text: cur.map((l) => l.text).join('\n'),
      anchor: cur[0].anchor,
      at: cur[0].at ?? null,
      authorId: authors.size === 1 ? (cur[0].authorId ?? null) : null,
    });
    cur = []; len = 0;
  };
  for (const l of lines) {
    const t = l.text.trim();
    if (!t) continue;
    if (len && len + t.length > max) flush();
    cur.push({ ...l, text: t.length > max * 2 ? t.slice(0, max * 2) : t });
    len += t.length + 1;
  }
  flush();
  return out;
}

/** «1:05:12» / «12:07» — секунда записи для подписи в ответе. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
