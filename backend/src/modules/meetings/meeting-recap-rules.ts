/**
 * #4902, п. 10–11: правила итогов созвона в чате — без базы и без модели, чтобы их
 * можно было проверить тестами и применить к старым встречам без побочных эффектов.
 */

/** Звонки короче двух минут без речи — случайные дозвоны, в список встреч не попадают. */
export const SHORT_CALL_SEC = 120;

/** Неподтверждённые задачи — одно напоминание через сутки после личного сообщения. */
export const CONFIRM_REMIND_HOURS = 24;

/** Через сколько повторять упавшую обработку: сетевой сбой или перегрузка API успевают пройти. */
export const AUTO_RETRY_DELAY_SEC = 60;

/**
 * Название, которое ставит созвон сам: «Созвон 11.11, 09:22» (meet.gateway). Такие
 * 37 одинаковых строк в списке ничего не говорят — их и переименовывает ИИ. Название,
 * которое дал человек или событие календаря, не трогаем.
 */
const DEFAULT_TITLE = /^созвон\s+\d{1,2}\.\d{1,2}(\.\d{2,4})?,?\s+\d{1,2}:\d{2}$/i;

export function isDefaultTitle(title: string | null | undefined): boolean {
  return DEFAULT_TITLE.test(String(title ?? '').trim());
}

/** Пустые слова вместо названия — модель иногда отвечает ими, и это хуже даты. */
const GENERIC = /^(созвон|встреча|рабочая встреча|рабочий созвон|обсуждение|без названия|итоги встречи|название)$/i;

/** Обрезать по границе слова, не оставляя висящих знаков. */
export function cutAtWord(text: string, max: number): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.5 ? cut.slice(0, space) : s.slice(0, max)).replace(/[\s,;:—–-]+$/, '');
}

/**
 * Ответ модели → название: первая строка без кавычек, «Название:», точки в конце.
 * null — ответ непригоден (пусто, общее слово, та же дата), тогда берём правило.
 */
export function cleanAiTitle(raw: string | null | undefined): string | null {
  const first = String(raw ?? '').replace(/```[a-z]*|```/gi, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const s = first
    .replace(/^(название|тема|заголовок)\s*[:：-]\s*/i, '')
    .replace(/[.。!]+$/, '')
    .replace(/^[«"'“„*_#\s]+|[»"'”*_\s]+$/g, '')
    .replace(/[.。!]+$/, '')
    .trim();
  if (s.length < 4 || GENERIC.test(s) || isDefaultTitle(s)) return null;
  return cutAtWord(s, 90);
}

/**
 * Название правилом, когда модели нет: первое предложение итогов без «На встрече
 * обсудили…». Лучше «Запуск рассылки и сроки дизайна», чем «Созвон 11.11, 09:22».
 */
export function fallbackTitle(summary: string | null | undefined, decisions: string[] = []): string | null {
  const source = String(summary ?? '').trim() || decisions.find((d) => d.trim()) || '';
  const sentence = source.split(/(?<=[.!?])\s+|\n/)[0] ?? '';
  const s = sentence
    .replace(/^(на (встрече|созвоне)\s+)?(команда\s+)?(обсудил[аи]?|обсуждали|говорили о|договорились|решили)\s*[:,—-]?\s*/i, '')
    .replace(/^(встреча|созвон)\s+(была\s+)?(посвящен[аао]?|о)\s+/i, '')
    .replace(/[.!?]+$/, '')
    .trim();
  if (s.length < 4 || isDefaultTitle(s)) return null;
  const t = cutAtWord(s, 70);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Короткий звонок без единой реплики — в списке встреч его не показываем и не повторяем. */
export function isShortEmptyCall(m: { source: string; duration_sec: number | null }, segments: number): boolean {
  return m.source === 'call' && segments === 0 && m.duration_sec != null && Number(m.duration_sec) < SHORT_CALL_SEC;
}

export interface RecapDraft {
  id: string; title: string; assignee_id: string | null; assignee_hint?: string | null;
  deadline_at: Date | string | null; status: string; task_id: string | null; confirm_state?: string | null;
}

export interface PersonTasks {
  userId: string | null;
  name: string;
  tasks: { draftId: string; title: string; deadlineAt: string | null; status: string; taskId: string | null; confirm: 'taken' | 'declined' | null }[];
}

/**
 * Задачи по людям для карточки итогов: у кого есть исполнитель — по имени, по алфавиту;
 * без исполнителя — последним блоком (их распределяет хозяин встречи). Отклонённые
 * хозяином черновики — не задачи, их не показываем.
 */
export function groupByPerson(drafts: RecapDraft[], names: Map<string, string>): PersonTasks[] {
  const by = new Map<string, PersonTasks>();
  for (const d of drafts) {
    if (d.status === 'rejected') continue;
    const key = d.assignee_id ? String(d.assignee_id) : '';
    if (!by.has(key)) {
      by.set(key, {
        userId: key || null,
        name: key ? names.get(key) ?? d.assignee_hint ?? 'Сотрудник' : 'Без исполнителя',
        tasks: [],
      });
    }
    by.get(key)!.tasks.push({
      draftId: String(d.id), title: d.title,
      deadlineAt: d.deadline_at ? new Date(d.deadline_at).toISOString() : null,
      status: d.status, taskId: d.task_id ? String(d.task_id) : null,
      confirm: d.confirm_state === 'taken' || d.confirm_state === 'declined' ? d.confirm_state : null,
    });
  }
  return [...by.values()].sort((a, b) => (a.userId ? 0 : 1) - (b.userId ? 0 : 1) || a.name.localeCompare(b.name, 'ru'));
}

/** «подтверждено 7 из 10» — вместо «Итоги не разобраны» в списке встреч. */
export function confirmLabel(done: number, total: number): string {
  return `подтверждено ${Math.min(done, total)} из ${total}`;
}

/**
 * Пересказ правилом (модели нет): читается за минуту — до ~130 слов, это темп
 * спокойной речи. Сначала о чём, потом решения, кто что делает, риск.
 */
export function retellFallback(i: {
  title: string; summary: string | null; decisions: string[]; risks: string[]; people: PersonTasks[];
}): string {
  const parts: string[] = [`Встреча «${i.title}».`];
  if (i.summary?.trim()) parts.push(i.summary.trim());
  if (i.decisions.length) parts.push(`Решили: ${i.decisions.slice(0, 3).map((d) => d.replace(/[.!]+$/, '')).join('; ')}.`);
  const who = i.people.filter((p) => p.userId && p.tasks.length).slice(0, 4)
    .map((p) => `${p.name} — ${p.tasks.slice(0, 2).map((t) => t.title.replace(/[.!]+$/, '')).join(', ')}`);
  if (who.length) parts.push(`Кто что делает: ${who.join('; ')}.`);
  if (i.risks.length) parts.push(`Риск: ${i.risks[0].replace(/[.!]+$/, '')}.`);
  return trimWords(parts.join(' '), 130);
}

/** Не больше `max` слов; обрезанное — по концу предложения, если он недалеко. */
export function trimWords(text: string, max: number): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  if (words.length <= max) return words.join(' ');
  const cut = words.slice(0, max).join(' ');
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > cut.length * 0.6 ? cut.slice(0, end + 1) : `${cut.replace(/[,;:—–-]+$/, '')}…`;
}

/** Задача разобрана исполнителем: взял или сказал «не моё». */
export function isDecided(d: { status: string; confirm_state?: string | null }): boolean {
  return d.status === 'rejected' || d.confirm_state === 'taken' || d.confirm_state === 'declined';
}
