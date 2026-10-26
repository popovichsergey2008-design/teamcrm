import { esc } from '../reports/task-report.html';
import type { CheckItem, Shot, Verdict } from './before-after.rules';

/**
 * PDF отчёта «было/стало» — тот же вид, что на экране и в образце заказчика:
 * номер в кружке, название пункта, строка «Было: … → Стало: …», две колонки БЫЛО
 * (терракотовая подпись) и СТАЛО (синяя), пометка вердикта. Картинки — data-URI:
 * печать идёт без сети. Цвета свои, светлые: PDF печатают на белой бумаге.
 */

const C = {
  ink: '#1f1b16', text: '#3d362d', muted: '#665d50', line: '#e3dcd0', card: '#fcfaf6',
  before: '#9a4a1c', after: '#0b5e9e',
  ok: '#0f6f49', okSoft: '#dff4ea', bad: '#c22335', badSoft: '#fce7ea', warn: '#8a5f00', warnSoft: '#fbf0d5',
};

const VERDICT: Record<Verdict, { label: string; fg: string; bg: string }> = {
  fixed: { label: 'Исправлено', fg: C.ok, bg: C.okSoft },
  not_fixed: { label: 'Не исправлено', fg: C.bad, bg: C.badSoft },
  no_result: { label: 'Результат не приложен', fg: C.bad, bg: C.badSoft },
  unclear: { label: 'Стоит посмотреть', fg: C.warn, bg: C.warnSoft },
  eyes: { label: 'Проверьте глазами', fg: C.warn, bg: C.warnSoft },
};

function shots(list: Shot[], images: Map<string, string>, empty: string): string {
  if (!list.length) return `<div class="empty">${esc(empty)}</div>`;
  return list.map((s) => {
    const src = images.get(s.fileId);
    const cap = [s.by, s.url].filter(Boolean).join(' · ');
    return src
      ? `<figure><img src="${src}" alt="${esc(s.name)}"/>${cap ? `<figcaption>${esc(cap)}</figcaption>` : ''}</figure>`
      : `<div class="empty">Снимок «${esc(s.name)}» недоступен</div>`;
  }).join('');
}

/** Подписи вердиктов в чек-листе приёмки: там не «исправлено», а «подтверждено». */
const FUNCTIONAL_LABEL: Partial<Record<Verdict, string>> = {
  fixed: 'Подтверждено', not_fixed: 'Не выполнено', no_result: 'Нет отчёта исполнителя',
};

function item(it: CheckItem, images: Map<string, string>, kind: string, checked: { by?: string } | undefined): string {
  const base = VERDICT[it.verdict] ?? VERDICT.eyes;
  const v = kind === 'functional' ? { ...base, label: FUNCTIONAL_LABEL[it.verdict] ?? base.label } : base;
  const mark = checked ? `<div class="checked">✓ Проверено${checked.by ? ` — ${esc(checked.by)}` : ''}</div>` : '';
  if (kind === 'functional') {
    // приёмка функции: колонки «было/стало» не нужны — только снимки результата, если есть
    const shotsBlock = it.after.length || it.before.length
      ? `<div class="cols">${it.before.length ? `<div class="col"><div class="label before">БЫЛО</div>${shots(it.before, images, '')}</div>` : ''}
          ${it.after.length ? `<div class="col"><div class="label after">РЕЗУЛЬТАТ</div>${shots(it.after, images, '')}</div>` : ''}</div>`
      : '';
    return `<section class="item">
    <div class="head"><span class="num">${it.n}</span><h2>${esc(it.title)}</h2></div>
    <div class="verdict" style="color:${v.fg};background:${v.bg}"><b>${v.label}.</b> ${esc(it.reason)}</div>
    ${mark}${shotsBlock}
  </section>`;
  }
  const change = it.change && (it.change.from || it.change.to)
    ? `<div class="change">Было: «${esc(it.change.from ?? '—')}» → Стало: ${it.change.to ? `«${esc(it.change.to)}»` : 'убрано'}</div>`
    : '';
  const noBefore = !it.before.length && it.change?.from
    ? `<div class="empty">Скриншота «до» не было — показан прежний текст: «${esc(it.change.from)}»</div>`
    : null;
  return `<section class="item">
    <div class="head"><span class="num">${it.n}</span><h2>${esc(it.title)}</h2></div>
    ${change}
    <div class="verdict" style="color:${v.fg};background:${v.bg}"><b>${v.label}.</b> ${esc(it.reason)}</div>
    ${mark}
    <div class="cols">
      <div class="col"><div class="label before">БЫЛО</div>${noBefore ?? shots(it.before, images, 'Скриншота «до» нет')}</div>
      <div class="col"><div class="label after">СТАЛО</div>${shots(it.after, images, 'Результат не приложен')}</div>
    </div>
  </section>`;
}

export function renderBeforeAfterHtml(input: {
  title: string;
  taskId: string;
  report: { version: number; createdAt: Date; items: CheckItem[]; summary: Record<string, unknown>; mode: string; model: string | null };
  images: Map<string, string>;
}): string {
  const { report, images } = input;
  const sum = report.summary as {
    headline?: string; message?: string; notes?: string[]; loose?: { before?: Shot[]; after?: Shot[] };
    kind?: string; examples?: Shot[]; checked?: Record<string, { by?: string }>;
    afterReport?: { author?: string | null; at?: string | null; body?: string }[];
  };
  const kind = sum.kind === 'functional' ? 'functional' : 'visual';
  const loose = sum.loose ?? {};
  const examplesBlock = sum.examples?.length
    ? `<section class="item"><div class="head"><h2>Образец от постановщика</h2></div>
        <p class="lead">Как должно быть — не исходный вид и не результат.</p>
        <div class="cols">${sum.examples.map((s) => `<div class="col">${shots([s], images, '—')}</div>`).join('')}</div></section>`
    : '';
  const reportBlock = kind === 'functional' && sum.afterReport?.length
    ? `<section class="item"><div class="head"><h2>Отчёт исполнителя</h2></div>
        ${sum.afterReport.map((m) => `<p class="msg"><b>${esc(m.author ?? '—')}:</b> ${esc(m.body ?? '')}</p>`).join('')}</section>`
    : '';
  const looseBlock = (loose.before?.length || loose.after?.length)
    ? `<section class="item"><div class="head"><h2>Снимки без привязки к пункту</h2></div>
        <div class="cols"><div class="col"><div class="label before">БЫЛО</div>${shots(loose.before ?? [], images, '—')}</div>
        <div class="col"><div class="label after">СТАЛО</div>${shots(loose.after ?? [], images, '—')}</div></div></section>`
    : '';
  const when = new Date(report.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"/><style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Inter, 'DejaVu Sans', sans-serif; color: ${C.text}; font-size: 11px; }
    h1 { font-size: 20px; color: ${C.ink}; margin: 0 0 4px; }
    .lead { color: ${C.muted}; margin: 0 0 12px; }
    .total { border: 1px solid ${C.line}; border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; background: ${C.card}; }
    .total b { color: ${C.ink}; font-size: 13px; }
    .notes { color: ${C.muted}; margin-top: 4px; }
    .item { border: 1px solid ${C.line}; border-radius: 10px; padding: 12px; margin-bottom: 12px; break-inside: avoid; }
    .head { display: flex; align-items: center; gap: 8px; }
    .num { width: 22px; height: 22px; border-radius: 50%; background: ${C.ink}; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-weight: 700; flex: none; }
    h2 { font-size: 13px; color: ${C.ink}; margin: 0; }
    .change { color: ${C.muted}; margin: 6px 0 0 30px; }
    .verdict { margin: 8px 0; padding: 5px 8px; border-radius: 6px; }
    .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .label { font-weight: 700; letter-spacing: .06em; font-size: 10px; margin-bottom: 4px; }
    .label.before { color: ${C.before}; } .label.after { color: ${C.after}; }
    figure { margin: 0 0 6px; } img { width: 100%; border: 1px solid ${C.line}; border-radius: 6px; }
    figcaption { color: ${C.muted}; font-size: 9px; }
    .checked { color: ${C.ok}; font-weight: 600; margin: 0 0 8px; }
    .msg { margin: 6px 0 0; }
    .empty { color: ${C.muted}; border: 1px dashed ${C.line}; border-radius: 6px; padding: 14px 8px; text-align: center; }
  </style></head><body>
    <h1>${kind === 'functional' ? 'Чек-лист приёмки' : 'Было/стало'}: ${esc(input.title)}</h1>
    <p class="lead">Задача #${esc(input.taskId)} · версия ${report.version} · ${esc(when)}. ${kind === 'functional'
      ? 'Пункты — критерии приёмки; результат — отчёт исполнителя и его снимки.'
      : 'Слева — исходные материалы и замечания, справа — результат исполнителя.'}</p>
    <div class="total"><b>${esc(sum.headline ?? '')}</b><div>${esc(sum.message ?? '')}</div>
      ${(sum.notes ?? []).map((n) => `<div class="notes">${esc(n)}</div>`).join('')}
      <div class="notes">${report.mode === 'ai' ? `Сравнивала модель ${esc(report.model ?? '')}` : 'Без проверки ИИ'} — это помощь глазам, а не приёмка работы.</div>
    </div>
    ${examplesBlock}
    ${reportBlock}
    ${report.items.map((it) => item(it, images, kind, sum.checked?.[String(it.n)])).join('')}
    ${looseBlock}
  </body></html>`;
}
