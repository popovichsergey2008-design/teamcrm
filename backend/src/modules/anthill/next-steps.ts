/**
 * Кнопки следующего шага под ответом QEVO Bot (#4893, п. 4): ответ заканчивается
 * действием, а не вопросом «скажите, что дальше». Чистая функция: по тому, какие
 * инструменты бот звал и что они нашли, — до четырёх кнопок.
 *
 * Кнопка ничего не делает сама. «prompt» — новая просьба боту: всё, что пишет в QEVO,
 * он покажет карточкой подтверждения («Поставить и пригласить» / «Изменить»), как
 * требуют Настройки. «fill» — заготовка в строку ввода, «schedule» — предпросмотр
 * регулярной задачи (п. 3), «download» — файл ответа, «link» — переход в раздел.
 */

export type NextButton =
  | { kind: 'prompt'; label: string; prompt: string }
  | { kind: 'fill'; label: string; text: string }
  | { kind: 'schedule'; label: string; title: string; instruction: string; phrase: string }
  | { kind: 'download'; label: string; format: 'xlsx' }
  | { kind: 'link'; label: string; href: string }
  /** Почты нет — карточка входа; после подключения бот выполнит resume сам (п. 2). */
  | { kind: 'connect_mail'; label: string; resume: string };

const SUMMARY = new Set(['team_pulse', 'chat_digest', 'time_audit', 'news_today', 'team_status', 'get_project', 'search_meetings', 'get_meeting']);
const TASKS = new Set(['search_tasks', 'my_day', 'get_task']);
const MESSAGES = new Set(['unanswered', 'whats_missed', 'chat_recent', 'search_messages']);
const MAIL = new Set(['mail_inbox', 'mail_search', 'mail_read']);
/** Похоже на разовую сводку, которую удобно получать регулярно. */
const RECURRABLE = /(сводк|итог|обзор|что нового|что пропустил|план дня|мой день|прогресс|статус|просроч|пульс|загрузк|новост)/i;
const ALREADY_SCHEDULED = /(кажд(ый|ую|ое)|по будням|ежедневн|еженедельн|регулярн)/i;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Слоты из ответа find_slots: строки «N. … — ISO 2026-11-14T11:00:00.000Z». */
export function slotsFrom(finding: string): Date[] {
  return [...finding.matchAll(/ISO (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/g)].map((m) => new Date(m[1])).filter((d) => !Number.isNaN(d.getTime()));
}

export function slotLabel(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d);
}

export function nextSteps(input: {
  question: string;
  used: { tool: string; params: Record<string, unknown> }[];
  findings: string[];
  tz: string | null;
}): NextButton[] {
  const tz = input.tz || 'Europe/Moscow';
  const tools = new Set(input.used.map((u) => u.tool));
  const out: NextButton[] = [];
  const add = (b: NextButton) => { if (out.length < 4 && !out.some((x) => x.label === b.label)) out.push(b); };

  // почта не подключена — одна кнопка подключения, остальное после
  if ([...tools].some((t) => MAIL.has(t)) && input.findings.some((f) => f.includes('Почта не подключена'))) {
    return [{ kind: 'connect_mail', label: 'Подключить почту', resume: clip(input.question, 500) }];
  }

  // найденные слоты — чипы времени: клик ставит встречу (через карточку подтверждения)
  const slotsCall = input.used.find((u) => u.tool === 'find_slots');
  if (slotsCall) {
    const finding = input.findings.find((f) => f.startsWith('[find_slots]')) ?? '';
    const people = String(slotsCall.params.people ?? '').trim();
    const dur = Number(slotsCall.params.duration) > 0 ? Number(slotsCall.params.duration) : 60;
    for (const d of slotsFrom(finding).slice(0, 4)) {
      const when = slotLabel(d, tz);
      add({
        kind: 'prompt', label: when,
        prompt: `Поставь встречу на ${when} (${d.toISOString()}), ${dur} мин${people ? `, участники: ${people}` : ''}. Тему и повестку предложи сам по нашим задачам — покажи карточкой перед отправкой.`,
      });
    }
    if (out.length) return out;
  }

  if ([...tools].some((t) => MESSAGES.has(t))) {
    add({ kind: 'prompt', label: 'Подготовить черновики ответов', prompt: 'Подготовь черновики ответов на сообщения, которые ждут меня. Ничего не отправляй — покажи каждое карточкой.' });
    add({ kind: 'prompt', label: 'Договорённости → задачи', prompt: 'Найди в этих сообщениях договорённости и предложи по каждой задачу — карточками на подтверждение.' });
  }
  if ([...tools].some((t) => MAIL.has(t))) {
    add({ kind: 'prompt', label: 'Черновики ответов на важные', prompt: 'Подготовь черновики ответов на важные письма. Ничего не отправляй — я проверю.' });
    add({ kind: 'fill', label: 'Письмо → задача', text: 'Сделай задачу из письма от ' });
  }
  if ([...tools].some((t) => TASKS.has(t))) {
    add({ kind: 'fill', label: 'Создать', text: 'Поставь задачу: ' });
    add({ kind: 'fill', label: 'Перенести', text: 'Перенеси срок задачи #' });
    add({ kind: 'fill', label: 'Делегировать', text: 'Поручи задачу #' });
  }
  if (tools.has('my_events')) {
    add({ kind: 'prompt', label: 'Повестка к ближайшей', prompt: 'Подготовь повестку к моей ближайшей встрече из открытых задач и прошлых договорённостей.' });
  }
  if ([...tools].some((t) => SUMMARY.has(t))) {
    add({ kind: 'prompt', label: 'Создать задачи по рискам', prompt: 'По этому ответу предложи задачи по рискам и проблемам — каждую карточкой на подтверждение.' });
    add({ kind: 'download', label: 'Скачать в Excel', format: 'xlsx' });
  }
  if (tools.has('web_search') || tools.has('read_url')) {
    add({ kind: 'prompt', label: 'Сохранить в документ', prompt: 'Сохрани эти находки документом в «Заметки» со ссылками на источники.' });
  }
  if (tools.has('how_to')) {
    add({ kind: 'prompt', label: 'Сделай за меня', prompt: `Сделай это за меня: ${clip(input.question, 300)}` });
  }
  // после полезного разового ответа — «Присылать это каждый будний день в 9:00?»
  if (RECURRABLE.test(input.question) && !ALREADY_SCHEDULED.test(input.question)) {
    add({ kind: 'schedule', label: 'Присылать каждый будний день в 9:00', title: clip(input.question, 60), instruction: clip(input.question, 600), phrase: 'по будням в 9:00' });
  }
  if (!out.length) {
    add({ kind: 'fill', label: 'Поставить задачу по ответу', text: 'Поставь задачу по этому ответу: ' });
  }
  return out;
}

/** Ответ → строки таблицы: пункты списка и строки «ключ: значение» — по ячейкам. */
export function answerRows(answer: string): string[][] {
  const rows: string[][] = [];
  for (const raw of answer.split('\n')) {
    const line = raw.replace(/\[(\d+)\]/g, '').replace(/[*_`#>]/g, '').trim();
    if (!line) continue;
    if (/^\|.*\|$/.test(line)) {
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      rows.push(line.slice(1, -1).split('|').map((c) => c.trim()));
      continue;
    }
    const item = line.replace(/^(\d+[.)]|[-•–])\s*/, '');
    const kv = /^([^:]{2,60}):\s+(.+)$/.exec(item);
    rows.push(kv ? [kv[1].trim(), kv[2].trim()] : [item]);
  }
  return rows;
}
