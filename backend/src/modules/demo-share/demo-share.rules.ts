/**
 * «Отправить коллеге» (#4863): результат демо с главной qevo.one — по ссылке
 * qevo.one/demo/<код>. Чистые функции: очистка от личных данных и разметка страницы.
 *
 * «Хранить 30 дней, без личных данных»: в демо человек мог вписать почту, телефон,
 * ник в Telegram или ссылку — их вырезаем до записи в базу, а не при показе.
 */

export interface DemoTask {
  title: string;
  project: string | null;
  who: string | null;
  due: string | null;
  check: string[];
  priority: string | null;
}

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const PHONE = /(?<!\d)\+?\d[\d\s().-]{8,}\d(?!\d)/g;
const HANDLE = /(?:https?:\/\/)?(?:t\.me|telegram\.me|wa\.me)\/[\w+]+|(?<![\p{L}\p{N}])@[A-Za-z0-9_]{3,}/gu;
const LINK = /https?:\/\/\S+/g;

/** Убрать контакты и ссылки, схлопнуть пробелы, обрезать. */
export function scrub(text: unknown, max: number): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(EMAIL, '[почта скрыта]')
    .replace(HANDLE, '[контакт скрыт]')
    .replace(LINK, '[ссылка скрыта]')
    .replace(PHONE, '[телефон скрыт]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
}

export function cleanTask(raw: unknown): DemoTask | null {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const title = scrub(t.title, 200);
  if (title.length < 3) return null;
  const opt = (v: unknown, max: number) => scrub(v, max) || null;
  const check = Array.isArray(t.check) ? t.check.map((c) => scrub(c, 160)).filter(Boolean).slice(0, 8) : [];
  return { title, project: opt(t.project, 80), who: opt(t.who, 60), due: opt(t.due, 60), check, priority: opt(t.priority, 30) };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const CSS = `
:root{--bg:#f6f1e8;--card:#fffdf9;--ink:#1d2433;--dim:#5d6575;--line:#e3dcd0;--acc:#2f5bea;--acc-soft:#e8eefd}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:24px 16px 48px}
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.logo{font-weight:800;font-size:20px;letter-spacing:.02em;color:var(--ink);text-decoration:none}
h1{font-size:26px;line-height:1.25;margin:0 0 6px}.lead{color:var(--dim);margin:0 0 20px}
.msg{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:14px}
.msg small,.task small{display:block;color:var(--dim);font-size:12px;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}
.msg p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.task{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--acc);border-radius:14px;padding:16px 18px}
.chip{display:inline-block;font-size:12px;padding:2px 8px;border-radius:99px;background:var(--acc-soft);color:var(--acc);margin-right:6px}
.task h2{font-size:20px;margin:10px 0 12px;overflow-wrap:anywhere}
.fields{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px}
.fields div{background:var(--bg);border-radius:10px;padding:8px 10px;min-width:0}.fields b{display:block;overflow-wrap:anywhere}
ul{margin:0;padding-left:20px}li{margin:3px 0;overflow-wrap:anywhere}
.cta{margin-top:24px;text-align:center}
.btn{display:inline-block;background:var(--acc);color:#fff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:12px}
.note{color:var(--dim);font-size:13px;margin-top:10px}
@media (max-width:600px){.fields{grid-template-columns:minmax(0,1fr)}h1{font-size:22px}}
`;

/** Страница результата: исходное сообщение, карточка задачи, «Попробуйте со своим сообщением». */
export function demoPage(d: { code: string; message: string; task: DemoTask }, base = 'https://qevo.one'): string {
  const t = d.task;
  const url = `${base}/demo/${d.code}`;
  const title = `Задача из сообщения: ${t.title}`;
  const desc = 'ИИ QEVO превратил сообщение в задачу с исполнителем, сроком и чек-листом. Попробуйте со своим сообщением.';
  const field = (label: string, v: string | null) => `<div><small>${label}</small><b>${esc(v ?? '—')}</b></div>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} · QEVO</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="QEVO">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(url)}/og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(url)}/og.png">
<link rel="icon" href="${base}/wp-content/themes/qevo/assets/img/favicon-32.png">
<style>${CSS}</style></head><body><main class="wrap">
<div class="top"><a class="logo" href="${base}/">QEVO</a></div>
<h1>Коллега поставил задачу через ИИ QEVO</h1>
<p class="lead">Одно сообщение — и готовая карточка: исполнитель, срок, чек-лист.</p>
<section class="msg" aria-label="Исходное сообщение"><small>Сообщение</small><p>${esc(d.message)}</p></section>
<article class="task" aria-label="Карточка задачи">
<span class="chip">Создано из переписки</span>${t.priority ? `<span class="chip">${esc(t.priority)}</span>` : ''}
<h2>${esc(t.title)}</h2>
<div class="fields">${field('Проект', t.project)}${field('Исполнитель', t.who)}${field('Срок', t.due)}</div>
${t.check.length ? `<small>Чек-лист</small><ul>${t.check.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
</article>
<div class="cta"><a class="btn" href="${base}/?utm_source=share&amp;utm_medium=demo">Попробуйте со своим сообщением</a>
<p class="note">14 дней бесплатно, без карты</p></div>
</main></body></html>`;
}

/** Картинка превью (1200×630) — та же карточка, чтобы результат был виден прямо в чате. */
export function ogHtml(task: DemoTask): string {
  const t = task;
  const rows = t.check.slice(0, 3).map((c) => `<li>${esc(c.length > 60 ? `${c.slice(0, 58)}…` : c)}</li>`).join('');
  const title = t.title.length > 90 ? `${t.title.slice(0, 88)}…` : t.title;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;background:#f6f1e8;font-family:Inter,"DejaVu Sans",Arial,sans-serif;color:#1d2433}
.c{position:absolute;inset:48px 56px;background:#fffdf9;border:2px solid #e3dcd0;border-left:10px solid #2f5bea;border-radius:28px;padding:40px 48px}
.k{font-size:24px;color:#2f5bea;font-weight:700}.h{font-size:46px;font-weight:800;line-height:1.15;margin:16px 0 22px}
.f{display:flex;gap:18px;margin-bottom:20px}.f div{background:#f6f1e8;border-radius:16px;padding:10px 18px;font-size:24px}.f small{display:block;color:#5d6575;font-size:17px}
ul{margin:0;padding-left:30px;font-size:24px;color:#38404f}li{margin:4px 0}
.b{position:absolute;right:48px;bottom:34px;font-size:30px;font-weight:800;letter-spacing:.03em}
</style></head><body><div class="c"><div class="k">Задача из сообщения · ИИ QEVO</div>
<div class="h">${esc(title)}</div>
<div class="f">${t.who ? `<div><small>Исполнитель</small>${esc(t.who)}</div>` : ''}${t.due ? `<div><small>Срок</small>${esc(t.due)}</div>` : ''}${t.project ? `<div><small>Проект</small>${esc(t.project)}</div>` : ''}</div>
${rows ? `<ul>${rows}</ul>` : ''}<div class="b">QEVO</div></div></body></html>`;
}

export function notFoundPage(base = 'https://qevo.one'): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Ссылка устарела · QEVO</title><style>${CSS}</style></head><body><main class="wrap">
<div class="top"><a class="logo" href="${base}/">QEVO</a></div><h1>Ссылка устарела</h1>
<p class="lead">Результаты демо хранятся 30 дней. Поставьте свою задачу через ИИ — это займёт минуту.</p>
<div class="cta"><a class="btn" href="${base}/?utm_source=share&amp;utm_medium=demo">Попробуйте со своим сообщением</a></div></main></body></html>`;
}
