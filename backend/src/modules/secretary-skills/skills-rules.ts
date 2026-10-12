/**
 * Письмо клиенту после встречи и утренний бриф (ТЗ-21, этапы 6–7) — чистые правила:
 * шаблон письма без модели, строки брифа и текст для голоса. Проверяются тестами.
 */

export interface FollowupFacts {
  meetingTitle: string;
  clientName: string;
  contactName: string | null;
  myName: string;
  summary: string | null;
  decisions: string[];
  tasks: { title: string; who: string | null; deadline: string | null }[];
}

/**
 * Письмо без модели — из итогов встречи как есть: договорённости, кто что делает и к
 * какому сроку, следующий шаг. Модель только переписывает его человеческим языком;
 * без неё письмо всё равно полезно — это и есть протокол.
 */
export function followupTemplate(f: FollowupFacts): { subject: string; body: string } {
  const lines: string[] = [];
  lines.push(f.contactName ? `${f.contactName}, добрый день!` : 'Добрый день!');
  lines.push('');
  lines.push(`Спасибо за встречу «${f.meetingTitle}». Фиксирую, о чём договорились.`);
  if (f.summary) { lines.push(''); lines.push(f.summary.trim()); }
  if (f.decisions.length) {
    lines.push('');
    lines.push('Решили:');
    for (const d of f.decisions.slice(0, 8)) lines.push(`— ${d}`);
  }
  if (f.tasks.length) {
    lines.push('');
    lines.push('Кто что делает:');
    for (const t of f.tasks.slice(0, 10)) lines.push(`— ${t.title}${t.who ? ` — ${t.who}` : ''}${t.deadline ? `, до ${t.deadline}` : ''}`);
  }
  lines.push('');
  lines.push('Если что-то записал неточно — поправьте, пожалуйста, ответным письмом.');
  lines.push('');
  lines.push(`С уважением, ${f.myName}`);
  return { subject: `Итоги встречи: ${f.meetingTitle}`.slice(0, 200), body: lines.join('\n') };
}

export interface BriefFacts {
  closedYesterday: number;
  createdYesterday: number;
  overdue: number;
  /** ТЗ-30: где задержка у просроченных — у исполнителей, на проверке, на согласовании, у клиента */
  overdueBy?: { work: number; review: number; approval: number; client: number };
  dueToday: number;
  hottest: { title: string; who: string | null } | null;
  decisionsWaiting: number;
  approvalsWaiting: number;
  meetingsToday: number;
  firstMeeting: { title: string; time: string } | null;
  prepared: { replies: number; letters: number; meetingDrafts: number };
  overloaded: string[];
}

/** 3–7 пунктов, только непустые: «ничего не горит» — тоже новость, но одной строкой. */
export function briefLines(f: BriefFacts): string[] {
  const out: string[] = [];
  if (f.closedYesterday || f.createdYesterday) out.push(`Вчера закрыто задач: ${f.closedYesterday}, новых: ${f.createdYesterday}.`);
  if (f.dueToday || f.overdue) {
    const hot = f.hottest ? ` Главное — «${f.hottest.title}»${f.hottest.who ? ` (${f.hottest.who})` : ''}.` : '';
    const by = f.overdueBy;
    // «за сроком» — задача проекта; кто её держит — отдельно, чтобы не обвинять сдавших (п. 19)
    const where = by && f.overdue && (by.review || by.approval || by.client)
      ? ` (${[by.work ? `у исполнителей — ${by.work}` : '', by.review ? `на проверке — ${by.review}` : '', by.approval ? `на согласовании — ${by.approval}` : '', by.client ? `ждут клиента — ${by.client}` : ''].filter(Boolean).join(', ')})`
      : '';
    out.push(`Горит: срок сегодня — ${f.dueToday}, просрочено — ${f.overdue}${where}.${hot}`);
  }
  if (f.decisionsWaiting || f.approvalsWaiting) {
    out.push(`Ждут вашего решения: ${[f.decisionsWaiting ? `предложений секретаря — ${f.decisionsWaiting}` : null, f.approvalsWaiting ? `согласований — ${f.approvalsWaiting}` : null].filter(Boolean).join(', ')}.`);
  }
  if (f.meetingsToday) out.push(`Встреч сегодня: ${f.meetingsToday}${f.firstMeeting ? `, первая в ${f.firstMeeting.time} — «${f.firstMeeting.title}»` : ''}.`);
  if (f.overloaded.length) out.push(`Перегружены: ${f.overloaded.slice(0, 3).join(', ')}${f.overloaded.length > 3 ? ` и ещё ${f.overloaded.length - 3}` : ''}.`);
  const p = f.prepared;
  if (p.replies || p.letters || p.meetingDrafts) {
    out.push(`Подготовлено: ${[p.letters ? `писем клиентам — ${p.letters}` : null, p.meetingDrafts ? `задач со встреч — ${p.meetingDrafts}` : null, p.replies ? `ответов в чатах — ${p.replies}` : null].filter(Boolean).join(', ')}.`);
  }
  if (!out.length) out.push('Ничего не горит: сроков на сегодня и ждущих решений нет.');
  return out.slice(0, 7);
}

/** Для голоса: без кавычек-ёлочек и тире-списков — синтез читает их как паузы и мусор. */
export function speakable(name: string | null, lines: string[]): string {
  const hello = `Доброе утро${name ? `, ${name.split(' ')[0]}` : ''}.`;
  return [hello, ...lines].join(' ')
    .replace(/[«»"]/g, '')
    .replace(/\s+—\s+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}
