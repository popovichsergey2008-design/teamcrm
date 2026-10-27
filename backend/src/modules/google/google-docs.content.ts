/**
 * Содержимое Google-документа, который QEVO создаёт по кнопке (§54–57 ТЗ).
 *
 * Документ собирается из блоков: заголовок, подзаголовки, абзацы, пункты списка.
 * Отсюда получаются запросы Docs API `batchUpdate`: весь текст вставляется ОДНИМ
 * куском в начало, а стили накладываются по диапазонам — так не нужно гадать, как
 * сдвигаются индексы после каждой вставки.
 */

export type DocKind = 'task_spec' | 'project_brief' | 'client_followup' | 'meeting_protocol' | 'blank';

export type DocBlock =
  | { kind: 'title'; text: string }
  | { kind: 'h2'; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'li'; text: string }
  /** строка «Поле: значение» — поле жирным */
  | { kind: 'kv'; key: string; value: string };

/** Пустое место для записи от руки: протокол заполняют на встрече, а не мы. */
const BLANK = '—';

export function buildDocRequests(blocks: DocBlock[]): any[] {
  let text = '';
  const styles: any[] = [];
  const bullets: { start: number; end: number }[] = [];
  // Docs считает индексы в UTF-16 с единицы — длина строки JS ровно это и даёт
  let at = 1;
  for (const b of blocks) {
    const line = (b.kind === 'kv' ? `${b.key}: ${b.value}` : b.text).replace(/\r?\n/g, ' ').trim() || BLANK;
    const start = at;
    const end = at + line.length + 1; // с переводом строки: стиль абзаца ложится на весь абзац
    text += `${line}\n`;
    at = end;
    if (b.kind === 'title' || b.kind === 'h2') {
      styles.push({
        updateParagraphStyle: {
          range: { startIndex: start, endIndex: end },
          paragraphStyle: { namedStyleType: b.kind === 'title' ? 'TITLE' : 'HEADING_2' },
          fields: 'namedStyleType',
        },
      });
    }
    if (b.kind === 'kv') {
      styles.push({
        updateTextStyle: {
          range: { startIndex: start, endIndex: start + b.key.length + 1 },
          textStyle: { bold: true },
          fields: 'bold',
        },
      });
    }
    if (b.kind === 'li') bullets.push({ start, end });
  }
  const requests: any[] = [{ insertText: { location: { index: 1 }, text } }, ...styles];
  // соседние пункты — одним списком, иначе у каждого своя нумерация и отступ
  for (const run of mergeRuns(bullets)) {
    requests.push({
      createParagraphBullets: {
        range: { startIndex: run.start, endIndex: run.end },
        bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  }
  return requests;
}

function mergeRuns(list: { start: number; end: number }[]) {
  const out: { start: number; end: number }[] = [];
  for (const r of list) {
    const prev = out[out.length - 1];
    if (prev && prev.end === r.start) prev.end = r.end;
    else out.push({ ...r });
  }
  return out;
}

const fmtDate = (d: Date | string | null | undefined, tz: string, withTime = false) => {
  if (!d) return 'не задан';
  return new Date(d).toLocaleString('ru-RU', {
    timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  });
};

export interface TaskDocData {
  title: string; project: string | null; assignee: string | null; manager: string | null;
  deadline: Date | null; description: string | null; checklist: string[]; url: string;
}
export interface ProjectDocData {
  name: string; description: string | null; owner: string | null; members: string[];
  openTasks: { title: string; assignee: string | null; deadline: Date | null }[]; url: string;
}
export interface ClientDocData {
  name: string; contact: string | null; notes: string | null;
  deals: { title: string; stage: string | null }[];
  openTasks: { title: string; assignee: string | null; deadline: Date | null }[];
}
export interface MeetingDocData {
  title: string; startsAt: Date; endsAt: Date; allDay: boolean; participants: string[];
  client: string | null; description: string | null; meetUrl: string | null;
}

/** Название файла: по нему документ находят в Диске, поэтому в нём то, что ищут. */
export function docName(kind: DocKind, subject: string, tz: string, when: Date = new Date()): string {
  const d = fmtDate(when, tz);
  const s = subject.trim().slice(0, 150);
  switch (kind) {
    case 'meeting_protocol': return `QEVO — Протокол встречи — ${s} — ${d}`;
    case 'task_spec': return `QEVO — Задача — ${s}`;
    case 'project_brief': return `QEVO — Проект — ${s}`;
    case 'client_followup': return `QEVO — ${s} — итоги и следующие шаги — ${d}`;
    default: return `QEVO — ${s}`;
  }
}

const taskLine = (t: { title: string; assignee: string | null; deadline: Date | null }, tz: string) =>
  [t.title, t.assignee ? `исполнитель ${t.assignee}` : null, t.deadline ? `срок ${fmtDate(t.deadline, tz)}` : null]
    .filter(Boolean).join(' · ');

export function taskDoc(d: TaskDocData, tz: string): DocBlock[] {
  return [
    { kind: 'title', text: d.title },
    { kind: 'kv', key: 'Проект', value: d.project ?? 'без проекта' },
    { kind: 'kv', key: 'Исполнитель', value: d.assignee ?? 'не назначен' },
    { kind: 'kv', key: 'Постановщик', value: d.manager ?? 'не задан' },
    { kind: 'kv', key: 'Срок', value: fmtDate(d.deadline, tz, true) },
    { kind: 'kv', key: 'Задача в QEVO', value: d.url },
    { kind: 'h2', text: 'Что нужно сделать' },
    ...paragraphs(d.description),
    ...(d.checklist.length ? [{ kind: 'h2', text: 'Чек-лист' } as DocBlock, ...d.checklist.map((t) => ({ kind: 'li', text: t }) as DocBlock)] : []),
    { kind: 'h2', text: 'Решение и заметки' },
    { kind: 'p', text: BLANK },
  ];
}

export function projectDoc(d: ProjectDocData, tz: string): DocBlock[] {
  return [
    { kind: 'title', text: d.name },
    { kind: 'kv', key: 'Руководитель', value: d.owner ?? 'не задан' },
    { kind: 'kv', key: 'Команда', value: d.members.length ? d.members.join(', ') : 'пока никого' },
    { kind: 'kv', key: 'Проект в QEVO', value: d.url },
    { kind: 'h2', text: 'О проекте' },
    ...paragraphs(d.description),
    { kind: 'h2', text: 'Цели и результат' },
    { kind: 'p', text: BLANK },
    { kind: 'h2', text: `Открытые задачи (${d.openTasks.length})` },
    ...(d.openTasks.length ? d.openTasks.map((t) => ({ kind: 'li', text: taskLine(t, tz) }) as DocBlock) : [{ kind: 'p', text: 'Открытых задач нет' } as DocBlock]),
    { kind: 'h2', text: 'Риски и вопросы' },
    { kind: 'p', text: BLANK },
  ];
}

export function clientDoc(d: ClientDocData, tz: string): DocBlock[] {
  return [
    { kind: 'title', text: `${d.name}: итоги и следующие шаги` },
    { kind: 'kv', key: 'Дата', value: fmtDate(new Date(), tz) },
    ...(d.contact ? [{ kind: 'kv', key: 'Контакт', value: d.contact } as DocBlock] : []),
    { kind: 'h2', text: 'Что обсудили' },
    ...paragraphs(d.notes),
    ...(d.deals.length ? [{ kind: 'h2', text: 'Сделки' } as DocBlock, ...d.deals.map((x) => ({ kind: 'li', text: x.stage ? `${x.title} — ${x.stage}` : x.title }) as DocBlock)] : []),
    { kind: 'h2', text: 'Что делаем мы' },
    ...(d.openTasks.length ? d.openTasks.map((t) => ({ kind: 'li', text: taskLine(t, tz) }) as DocBlock) : [{ kind: 'p', text: BLANK } as DocBlock]),
    { kind: 'h2', text: 'Что ждём от вас' },
    { kind: 'p', text: BLANK },
    { kind: 'h2', text: 'Следующий шаг' },
    { kind: 'p', text: BLANK },
  ];
}

export function meetingDoc(d: MeetingDocData, tz: string): DocBlock[] {
  const when = d.allDay ? fmtDate(d.startsAt, tz) : `${fmtDate(d.startsAt, tz, true)} — ${new Date(d.endsAt).toLocaleTimeString('ru-RU', { timeZone: tz, hour: '2-digit', minute: '2-digit' })}`;
  return [
    { kind: 'title', text: `Протокол встречи: ${d.title}` },
    { kind: 'kv', key: 'Дата', value: when },
    { kind: 'kv', key: 'Участники', value: d.participants.length ? d.participants.join(', ') : 'не указаны' },
    ...(d.client ? [{ kind: 'kv', key: 'Клиент', value: d.client } as DocBlock] : []),
    ...(d.meetUrl ? [{ kind: 'kv', key: 'Созвон', value: d.meetUrl } as DocBlock] : []),
    ...(d.description ? [{ kind: 'h2', text: 'Повестка' } as DocBlock, ...paragraphs(d.description)] : []),
    { kind: 'h2', text: 'Краткое содержание' },
    { kind: 'p', text: BLANK },
    { kind: 'h2', text: 'Решения' },
    { kind: 'li', text: BLANK },
    { kind: 'h2', text: 'Задачи' },
    { kind: 'li', text: 'Задача — исполнитель — срок' },
    { kind: 'h2', text: 'Открытые вопросы' },
    { kind: 'li', text: BLANK },
    { kind: 'h2', text: 'Следующий шаг' },
    { kind: 'p', text: BLANK },
  ];
}

/** Описание задачи хранится с разметкой редактора — в документ идёт чистый текст по абзацам. */
function paragraphs(raw: string | null | undefined): DocBlock[] {
  const plain = String(raw ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // картинки из описания в документ не переносим
    .split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return plain.length ? plain.slice(0, 200).map((text) => ({ kind: 'p', text })) : [{ kind: 'p', text: BLANK }];
}
