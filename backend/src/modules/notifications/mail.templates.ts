/**
 * Письма TEAMCRM.
 *
 * Чистые функции без обращений к базе — их проверяют тесты, а не живая отправка.
 *
 * Почему вёрстка именно такая: почтовые клиенты — это не браузеры. Внешние
 * стили и картинки Gmail и Outlook режут или не показывают, поэтому оформление
 * задано прямо в атрибутах, логотип набран текстом, а не изображением, и вся
 * раскладка держится на таблицах — единственном, что одинаково работает везде.
 * Письмо обязано читаться и в почтовике, который не умеет ничего.
 */

export type EventKey = 'task.created' | 'task.commented' | 'task.status';

export const EVENT_TITLE: Record<EventKey, string> = {
  'task.created': 'Новые задачи для меня',
  'task.commented': 'Комментарии в моих задачах',
  'task.status': 'Смена статуса моих задач',
};

/**
 * Лента компании: объявления и упоминания.
 *
 * Отдельными ключами, а не одним «письма из ленты»: это разные поводы. Объявление
 * приходит всем и его можно захотеть отключить, а упоминание — личное обращение, и
 * отключают его совсем другие люди и по другой причине.
 */
export const FEED_ANNOUNCEMENT_KEY = 'feed.announcement';
export const FEED_ANNOUNCEMENT_TITLE = 'Объявления компании';
export const FEED_MENTION_KEY = 'feed.mention';
export const FEED_MENTION_TITLE = 'Когда меня упомянули в новостях';

/** Отдельный переключатель: письма о том, что человек сделал сам. */
export const OWN_EVENT_KEY = 'task.own';
export const OWN_EVENT_TITLE = 'Письма о моих собственных действиях';

/**
 * Дубль тех же уведомлений в личный чат с ботом. Отдельный ключ, а не вид письма:
 * это не «о чём писать», а «куда ещё продублировать». По умолчанию включён —
 * привязавший Telegram сделал это, чтобы получать оттуда пользу, а не настраивать.
 */
export const MIRROR_EVENT_KEY = 'telegram.mirror';
export const MIRROR_EVENT_TITLE = 'Дублировать уведомления в Telegram';

const BRAND = {
  ink: '#101623',
  soft: '#4d5768',
  mut: '#7a8496',
  line: '#e2e7f2',
  bg: '#f4f6fa',
  card: '#ffffff',
  accent: '#1e57e6',
  accentSoft: '#e8effe',
  ok: '#17875a',
  warn: '#9a6a00',
  danger: '#cf2b3b',
};

const PRIORITY_LABEL: Record<string, { text: string; color: string }> = {
  urgent: { text: 'Срочно', color: BRAND.danger },
  high: { text: 'Высокий приоритет', color: BRAND.warn },
  low: { text: 'Низкий приоритет', color: BRAND.mut },
};

export interface TaskCtx {
  taskTitle: string;
  projectName: string;
  taskUrl: string;
  actorName: string;
  /** Дополняют письмо, но не обязательны: у задачи может не быть ни срока, ни исполнителя. */
  assigneeName?: string | null;
  columnName?: string | null;
  priority?: string | null;
  deadlineAt?: Date | string | null;
}

export interface Letter {
  subject: string;
  text: string;
  html: string;
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Перевод строки отдельной константой — чтобы не терялся при правках через инструменты. */
const NEWLINE = '\n';

const trim = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function formatDeadline(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ru-RU', { day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' });
}

/** Строка сводки: подпись слева, значение справа. */
function metaRow(label: string, value: string, color = BRAND.ink): string {
  return `<tr>
    <td style="padding:5px 0;font-size:13px;color:${BRAND.mut};white-space:nowrap;vertical-align:top">${escape(label)}</td>
    <td style="padding:5px 0 5px 14px;font-size:13px;color:${color};font-weight:600">${value}</td>
  </tr>`;
}

function metaTable(ctx: TaskCtx): string {
  const rows: string[] = [metaRow('Проект', escape(ctx.projectName))];
  if (ctx.columnName) rows.push(metaRow('Колонка', escape(ctx.columnName)));
  if (ctx.assigneeName) rows.push(metaRow('Исполнитель', escape(ctx.assigneeName)));
  const prio = ctx.priority ? PRIORITY_LABEL[ctx.priority] : undefined;
  if (prio) rows.push(metaRow('Приоритет', escape(prio.text), prio.color));
  const deadline = formatDeadline(ctx.deadlineAt);
  if (deadline) rows.push(metaRow('Срок', escape(deadline), BRAND.ink));
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%">${rows.join('')}</table>`;
}

/**
 * Каркас письма: шапка с логотипом, карточка задачи, кнопка, подвал.
 * @param lead первая строка — то, ради чего письмо и открывают
 * @param extra необязательный блок между сводкой и кнопкой (например, текст комментария)
 */
function shell(opts: {
  preheader: string;
  lead: string;
  ctx: TaskCtx;
  extra?: string;
  accent: string;
  unsubscribeUrl: string;
}): string {
  const { ctx } = opts;
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>TEAMCRM</title></head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<!-- Строка предпросмотра: её показывает список писем рядом с темой, но в самом письме она не видна. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escape(opts.preheader)}</div>
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%;background:${BRAND.bg}">
  <tr><td align="center" style="padding:28px 12px">
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%;max-width:560px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif">

      <tr><td style="padding:0 4px 14px">
        <span style="font-size:19px;font-weight:800;letter-spacing:-.5px;color:${BRAND.ink}">TEAM<span style="color:${BRAND.accent}">CRM</span></span>
      </td></tr>

      <tr><td style="background:${BRAND.card};border:1px solid ${BRAND.line};border-radius:12px;overflow:hidden">
        <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%">
          <tr><td style="height:4px;background:${opts.accent};font-size:0;line-height:0">&nbsp;</td></tr>
          <tr><td style="padding:22px 26px 24px">
            <p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:${BRAND.soft}">${opts.lead}</p>
            <p style="margin:0 0 18px;font-size:19px;line-height:1.35;font-weight:700;color:${BRAND.ink}">${escape(ctx.taskTitle)}</p>
            ${metaTable(ctx)}
            ${opts.extra ?? ''}
            <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:22px">
              <tr><td style="background:${BRAND.accent};border-radius:8px">
                <a href="${escape(ctx.taskUrl)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Открыть задачу</a>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </td></tr>

      <tr><td style="padding:16px 6px 0;font-size:12px;line-height:1.6;color:${BRAND.mut}">
        Письмо от TEAMCRM.
        <a href="${escape(opts.unsubscribeUrl)}" style="color:${BRAND.mut};text-decoration:underline">Отписаться</a>
        или настроить письма в личном кабинете.
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

/** Текстовая часть: её читают почтовики без разметки и голосовые помощники. */
function plain(lead: string, ctx: TaskCtx, unsubscribeUrl: string, extra?: string): string {
  const lines = [lead, '', ctx.taskTitle, '', `Проект: ${ctx.projectName}`];
  if (ctx.columnName) lines.push(`Колонка: ${ctx.columnName}`);
  if (ctx.assigneeName) lines.push(`Исполнитель: ${ctx.assigneeName}`);
  const prio = ctx.priority ? PRIORITY_LABEL[ctx.priority] : undefined;
  if (prio) lines.push(`Приоритет: ${prio.text}`);
  const deadline = formatDeadline(ctx.deadlineAt);
  if (deadline) lines.push(`Срок: ${deadline}`);
  if (extra) lines.push('', extra);
  lines.push('', `Открыть: ${ctx.taskUrl}`, '', `Отписаться: ${unsubscribeUrl}`);
  return lines.join('\n');
}

export function taskCreatedLetter(ctx: TaskCtx, unsubscribeUrl: string): Letter {
  const own = ctx.assigneeName && ctx.actorName === ctx.assigneeName;
  const lead = own ? 'Вы поставили себе задачу.' : `${ctx.actorName} поставил задачу на вас.`;
  return {
    subject: trim(`Новая задача: ${ctx.taskTitle}`, 120),
    text: plain(lead, ctx, unsubscribeUrl),
    html: shell({ preheader: `${ctx.projectName} · ${ctx.taskTitle}`, lead: escape(lead), ctx, accent: BRAND.accent, unsubscribeUrl }),
  };
}

export function taskCommentedLetter(ctx: TaskCtx & { comment: string }, unsubscribeUrl: string): Letter {
  const quote = trim(ctx.comment.trim(), 600);
  const lead = `${ctx.actorName} написал в задаче:`;
  const extra = `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%;margin-top:16px">
    <tr><td style="padding:12px 14px;background:${BRAND.accentSoft};border-left:3px solid ${BRAND.accent};border-radius:0 6px 6px 0;font-size:14px;line-height:1.55;color:${BRAND.ink};white-space:pre-wrap">${escape(quote)}</td></tr>
  </table>`;
  return {
    subject: trim(`${ctx.actorName} — комментарий: ${ctx.taskTitle}`, 120),
    text: plain(lead, ctx, unsubscribeUrl, quote),
    html: shell({ preheader: quote, lead: escape(lead), ctx, extra, accent: BRAND.accent, unsubscribeUrl }),
  };
}

/**
 * Работа сдана и ждёт вашего решения.
 *
 * Письмо постановщику: исполнитель своё сделал, задача теперь в его очереди.
 * Пишем фактом и зовём глаголом — «примите или верните», потому что от этого письма
 * требуется именно действие, а не осведомлённость.
 */
export function taskApprovalLetter(ctx: TaskCtx, unsubscribeUrl: string): Letter {
  const lead = `${ctx.actorName} сдал работу и ждёт вашего решения: принять или вернуть.`;
  return {
    subject: trim(`Ждёт вашего решения: ${ctx.taskTitle}`, 120),
    text: plain(lead, ctx, unsubscribeUrl),
    html: shell({
      preheader: `${ctx.projectName} · сдано на проверку`,
      lead: escape(lead),
      ctx,
      accent: BRAND.accent,
      unsubscribeUrl,
    }),
  };
}

/** Работу вернули. Причина — в теле письма: «переделай» без объяснения бесполезно. */
export function taskReturnedLetter(ctx: TaskCtx & { reason: string }, unsubscribeUrl: string): Letter {
  const lead = `${ctx.actorName} вернул задачу в работу.`;
  const quote = `Что доработать: ${ctx.reason}`;
  return {
    subject: trim(`Вернули в работу: ${ctx.taskTitle}`, 120),
    text: plain(lead, ctx, unsubscribeUrl, quote),
    html: shell({
      preheader: `${ctx.projectName} · вернули в работу`,
      lead: escape(lead),
      ctx,
      accent: BRAND.warn,
      unsubscribeUrl,
      extra: escape(quote),
    }),
  };
}

/**
 * Вас добавили к задаче.
 *
 * Соисполнителю говорим о работе, наблюдателю — что он в курсе, но не обязан делать.
 * Смешивать эти два письма нельзя: первое требует действия, второе именно что не требует,
 * и человек должен понять это с первой строки.
 */
export function taskParticipantLetter(
  ctx: TaskCtx & { role: 'co_assignee' | 'watcher' }, unsubscribeUrl: string,
): Letter {
  const co = ctx.role === 'co_assignee';
  const lead = co
    ? `${ctx.actorName} добавил вас соисполнителем — работу делаете вместе с исполнителем.`
    : `${ctx.actorName} добавил вас наблюдателем: вы будете видеть ход работы, делать ничего не нужно.`;
  return {
    subject: trim(`${co ? 'Вы соисполнитель' : 'Вы наблюдаете'}: ${ctx.taskTitle}`, 120),
    text: plain(lead, ctx, unsubscribeUrl),
    html: shell({
      preheader: `${ctx.projectName} · ${co ? 'соисполнитель' : 'наблюдатель'}`,
      lead: escape(lead),
      ctx,
      accent: co ? BRAND.accent : BRAND.mut,
      unsubscribeUrl,
    }),
  };
}

/**
 * Задачи объединили.
 *
 * Отдельного переключателя в настройках у этого письма нет и не нужно: для
 * человека объединение — это смена состояния его задачи («она теперь вон та»),
 * и приходит оно тем же каналом, что и перенос в другую колонку.
 *
 * Номера в тексте обязательны: по ним задачу ищут в переписке, где на неё уже
 * успели сослаться.
 */
export function taskMergedLetter(
  ctx: TaskCtx & { mergedNumber: string; primaryNumber: string; primaryTitle: string },
  unsubscribeUrl: string,
): Letter {
  const lead = `${ctx.actorName} объединил задачу #${ctx.mergedNumber} с задачей #${ctx.primaryNumber} `
    + `«${ctx.primaryTitle}». Работа продолжается в основной задаче — переписка и файлы уже там.`;
  return {
    subject: trim(`Задача #${ctx.mergedNumber} объединена с #${ctx.primaryNumber}`, 120),
    text: plain(lead, ctx, unsubscribeUrl),
    html: shell({
      preheader: `${ctx.projectName} · объединение задач`,
      lead: escape(lead),
      ctx,
      accent: BRAND.accent,
      unsubscribeUrl,
    }),
  };
}

export function taskStatusLetter(ctx: TaskCtx & { to: string; closed: boolean }, unsubscribeUrl: string): Letter {
  const what = ctx.closed ? 'завершена' : `перенесена в «${ctx.to}»`;
  const lead = `${ctx.actorName} — задача ${what}.`;
  return {
    subject: trim(`Задача ${what}: ${ctx.taskTitle}`, 120),
    text: plain(lead, { ...ctx, columnName: ctx.to }, unsubscribeUrl),
    html: shell({
      preheader: `${ctx.projectName} · ${what}`,
      lead: escape(lead),
      ctx: { ...ctx, columnName: ctx.to },
      accent: ctx.closed ? BRAND.ok : BRAND.accent,
      unsubscribeUrl,
    }),
  };
}

/**
 * Объявление в ленте компании.
 *
 * Своя оболочка, а не общая: у объявления нет ни задачи, ни проекта, ни срока — вся
 * табличка полей в нём пустует. Показываем то, что есть: кто объявил, что именно и
 * кнопку в ленту.
 *
 * Текст письма — САМО объявление, а не «в ленте новое сообщение». Уведомление, ради
 * которого нужно куда-то идти, чтобы узнать содержание, читают один раз.
 */
export function feedAnnouncementLetter(
  ctx: { authorName: string; body: string; feedUrl: string },
  unsubscribeUrl: string,
): Letter {
  const lead = `${ctx.authorName} — объявление для всей компании:`;
  const subject = trim(`Объявление: ${ctx.body.split('\n')[0]}`, 120);
  const text = [lead, '', ctx.body, '', `Открыть ленту: ${ctx.feedUrl}`, '', `Отписаться: ${unsubscribeUrl}`].join('\n');
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>TEAMCRM</title></head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escape(ctx.body.slice(0, 120))}</div>
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%;background:${BRAND.bg}">
  <tr><td align="center" style="padding:28px 12px">
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%;max-width:560px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif">
      <tr><td style="padding:0 4px 14px">
        <span style="font-size:19px;font-weight:800;letter-spacing:-.5px;color:${BRAND.ink}">TEAM<span style="color:${BRAND.accent}">CRM</span></span>
      </td></tr>
      <tr><td style="background:${BRAND.card};border:1px solid ${BRAND.line};border-radius:12px;overflow:hidden">
        <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%">
          <tr><td style="height:4px;background:${BRAND.warn};font-size:0;line-height:0">&nbsp;</td></tr>
          <tr><td style="padding:22px 26px 24px">
            <p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:${BRAND.soft}">${escape(lead)}</p>
            <div style="margin:0 0 18px;font-size:16px;line-height:1.55;color:${BRAND.ink};white-space:pre-wrap">${escape(ctx.body)}</div>
            <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:6px">
              <tr><td style="background:${BRAND.accent};border-radius:8px">
                <a href="${escape(ctx.feedUrl)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Открыть ленту</a>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:16px 6px 0;font-size:12px;line-height:1.6;color:${BRAND.mut}">
        Письмо от TEAMCRM.
        <a href="${escape(unsubscribeUrl)}" style="color:${BRAND.mut};text-decoration:underline">Отписаться</a>
        или настроить письма в личном кабинете.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  return { subject, text, html };
}

/**
 * Вас упомянули в ленте компании.
 *
 * Письмо адресное и потому приходит даже на обычную новость: упоминание — это личная
 * просьба посмотреть, а не общий шум. Как и в объявлении, показываем САМ текст: письмо,
 * ради которого нужно куда-то идти, чтобы узнать содержание, читают один раз.
 */
export function feedMentionLetter(
  ctx: { authorName: string; body: string; feedUrl: string; inComment: boolean },
  unsubscribeUrl: string,
): Letter {
  const where = ctx.inComment ? 'в обсуждении новости' : 'в новости компании';
  const lead = `${ctx.authorName} упомянул вас ${where}:`;
  const subject = trim(`${ctx.authorName} упомянул вас: ${ctx.body.split(NEWLINE)[0]}`, 120);
  const text = [lead, '', ctx.body, '', `Открыть: ${ctx.feedUrl}`, '', `Отписаться: ${unsubscribeUrl}`].join(NEWLINE);
  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>TEAMCRM</title></head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escape(ctx.body.slice(0, 120))}</div>
<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%;background:${BRAND.bg}">
  <tr><td align="center" style="padding:28px 12px">
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%;max-width:560px;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif">
      <tr><td style="padding:0 4px 14px">
        <span style="font-size:19px;font-weight:800;letter-spacing:-.5px;color:${BRAND.ink}">TEAM<span style="color:${BRAND.accent}">CRM</span></span>
      </td></tr>
      <tr><td style="background:${BRAND.card};border:1px solid ${BRAND.line};border-radius:12px;overflow:hidden">
        <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%">
          <tr><td style="height:4px;background:${BRAND.accent};font-size:0;line-height:0">&nbsp;</td></tr>
          <tr><td style="padding:22px 26px 24px">
            <p style="margin:0 0 14px;font-size:14px;line-height:1.5;color:${BRAND.soft}">${escape(lead)}</p>
            <div style="margin:0 0 18px;font-size:15px;line-height:1.55;color:${BRAND.ink};white-space:pre-wrap">${escape(ctx.body)}</div>
            <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin-top:6px">
              <tr><td style="background:${BRAND.accent};border-radius:8px">
                <a href="${escape(ctx.feedUrl)}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">Открыть новость</a>
              </td></tr>
            </table>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:16px 6px 0;font-size:12px;line-height:1.6;color:${BRAND.mut}">
        Письмо от TEAMCRM.
        <a href="${escape(unsubscribeUrl)}" style="color:${BRAND.mut};text-decoration:underline">Отписаться</a>
        или настроить письма в личном кабинете.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
  return { subject, text, html };
}
