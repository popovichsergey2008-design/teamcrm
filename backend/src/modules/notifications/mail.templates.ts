/**
 * Тексты писем.
 *
 * Чистые функции без обращений к базе — их проверяют тесты, а не живая отправка.
 * Письмо строится так, чтобы всё главное было в теме и первой строке: почту
 * читают в списке, не открывая.
 */

export type EventKey = 'task.created' | 'task.commented' | 'task.status';

export const EVENT_TITLE: Record<EventKey, string> = {
  'task.created': 'Новые задачи для меня',
  'task.commented': 'Комментарии в моих задачах',
  'task.status': 'Смена статуса моих задач',
};

export interface TaskCtx {
  taskTitle: string;
  projectName: string;
  taskUrl: string;
  actorName: string;
}

export interface Letter {
  subject: string;
  text: string;
  html: string;
}

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const trim = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Простая вёрстка: таблиц и картинок нет намеренно. Почтовые клиенты
 * ломают сложную вёрстку каждый по-своему, а внешние картинки многие
 * не показывают вовсе — письмо должно читаться и без них.
 */
function wrap(title: string, lines: string[], ctx: TaskCtx, unsubscribeUrl: string): string {
  const body = lines.map((l) => `<p style="margin:0 0 10px">${l}</p>`).join('');
  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a;max-width:560px">',
    `<p style="margin:0 0 14px;font-size:16px;font-weight:600">${escape(title)}</p>`,
    body,
    `<p style="margin:18px 0"><a href="${escape(ctx.taskUrl)}" style="display:inline-block;padding:9px 16px;background:#2f6bff;color:#fff;text-decoration:none;border-radius:6px">Открыть задачу</a></p>`,
    `<p style="margin:22px 0 0;font-size:12px;color:#8a8a8a">Письмо от TEAMCRM · проект «${escape(ctx.projectName)}»<br>`,
    `<a href="${escape(unsubscribeUrl)}" style="color:#8a8a8a">Отписаться от писем</a></p>`,
    '</div>',
  ].join('');
}

export function taskCreatedLetter(ctx: TaskCtx, unsubscribeUrl: string): Letter {
  const subject = trim(`Новая задача: ${ctx.taskTitle}`, 120);
  const lines = [
    `${escape(ctx.actorName)} поставил задачу на вас.`,
    `Проект: <b>${escape(ctx.projectName)}</b>`,
  ];
  return {
    subject,
    text: `${ctx.actorName} поставил задачу на вас.\n\n${ctx.taskTitle}\nПроект: ${ctx.projectName}\n\nОткрыть: ${ctx.taskUrl}\n\nОтписаться: ${unsubscribeUrl}`,
    html: wrap(ctx.taskTitle, lines, ctx, unsubscribeUrl),
  };
}

export function taskCommentedLetter(ctx: TaskCtx & { comment: string }, unsubscribeUrl: string): Letter {
  const subject = trim(`${ctx.actorName} — комментарий: ${ctx.taskTitle}`, 120);
  const quote = trim(ctx.comment.trim(), 600);
  const lines = [
    `${escape(ctx.actorName)} написал в задаче:`,
    `<span style="display:block;padding:10px 12px;background:#f4f6fa;border-left:3px solid #2f6bff;white-space:pre-wrap">${escape(quote)}</span>`,
    `Проект: <b>${escape(ctx.projectName)}</b>`,
  ];
  return {
    subject,
    text: `${ctx.actorName} написал в задаче «${ctx.taskTitle}»:\n\n${quote}\n\nПроект: ${ctx.projectName}\nОткрыть: ${ctx.taskUrl}\n\nОтписаться: ${unsubscribeUrl}`,
    html: wrap(ctx.taskTitle, lines, ctx, unsubscribeUrl),
  };
}

export function taskStatusLetter(ctx: TaskCtx & { to: string; closed: boolean }, unsubscribeUrl: string): Letter {
  const what = ctx.closed ? 'завершена' : `перенесена в «${ctx.to}»`;
  const subject = trim(`Задача ${what}: ${ctx.taskTitle}`, 120);
  const lines = [
    `${escape(ctx.actorName)} — задача ${escape(what)}.`,
    `Проект: <b>${escape(ctx.projectName)}</b>`,
  ];
  return {
    subject,
    text: `${ctx.actorName} — задача «${ctx.taskTitle}» ${what}.\n\nПроект: ${ctx.projectName}\nОткрыть: ${ctx.taskUrl}\n\nОтписаться: ${unsubscribeUrl}`,
    html: wrap(ctx.taskTitle, lines, ctx, unsubscribeUrl),
  };
}
