import type { GroupRow, Kpi, TaskLine, TaskReport } from './task-report.model';

/**
 * Вёрстка отчёта по задачам: HTML для печати в PDF.
 *
 * Отчёт уходит руководителю, клиенту, в бухгалтерию — он должен выглядеть как
 * документ, а не как распечатка экрана. Поэтому своя страница A4: шапка с логотипом,
 * плитки с цифрами и сравнением, графики в SVG (векторные — не мылятся при печати),
 * таблицы, которые не рвутся посреди строки. Ничего внешнего: шрифт системный в
 * контейнере (Inter), картинки — data-URI, иначе печать зависела бы от сети.
 */

const C = {
  ink: '#0f172a', text: '#334155', muted: '#64748b', faint: '#94a3b8', line: '#e2e8f0', soft: '#f1f5f9', card: '#f8fafc',
  brand: '#0e7490', brand2: '#6d28d9', good: '#15803d', goodSoft: '#dcfce7', bad: '#b91c1c', badSoft: '#fee2e2',
  warn: '#b45309', warnSoft: '#fef3c7', created: '#94a3b8', done: '#0e7490',
};

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

function parts(at: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: p.hour === '24' ? '00' : p.hour, mm: p.minute };
}
const shortDate = (at: Date | null, tz: string) => {
  if (!at) return '—';
  const p = parts(at, tz);
  return `${p.d} ${MONTHS_SHORT[p.m - 1]}`;
};
const longDateTime = (at: Date, tz: string) => {
  const p = parts(at, tz);
  return `${p.d} ${MONTHS_GEN[p.m - 1]} ${p.y}, ${p.hh}:${p.mm}`;
};
const nf = (v: number) => String(v).replace('.', ',');

function fmtValue(k: Kpi): string {
  if (k.value === null) return '—';
  if (k.unit === 'pct') return `${k.value}<small>%</small>`;
  if (k.unit === 'days') return `${nf(k.value)}<small> дн.</small>`;
  if (k.unit === 'hours') return `${nf(k.value)}<small> ч</small>`;
  return String(k.value);
}

/** Сравнение с прошлым периодом: зелёным — то, что стало лучше, красным — хуже. */
function delta(k: Kpi): string {
  if (k.value === null || k.prev === null) return '<span class="delta">нет данных для сравнения</span>';
  const diff = k.value - k.prev;
  if (diff === 0) return '<span class="delta">как в прошлом периоде</span>';
  const up = diff > 0;
  const tone = k.goodWhenUp === null ? 'neutral' : up === k.goodWhenUp ? 'good' : 'bad';
  const amount = k.unit === 'pct'
    ? `${Math.abs(diff)} п.п.`
    : k.prev > 0 && k.unit === 'num' ? `${Math.abs(Math.round((diff / k.prev) * 100))}%`
      : `${nf(Math.round(Math.abs(diff) * 10) / 10)}${k.unit === 'days' ? ' дн.' : k.unit === 'hours' ? ' ч' : ''}`;
  return `<span class="delta ${tone}">${up ? '▲' : '▼'} ${amount}</span><span class="delta-was">было ${k.unit === 'pct' ? `${k.prev}%` : nf(k.prev)}</span>`;
}

function trendChart(r: TaskReport): string {
  const b = r.trend.buckets;
  if (!b.length) return '';
  const W = 720; const H = 210; const padL = 30; const padB = 26; const padT = 18;
  const max = Math.max(1, ...b.map((x) => Math.max(x.created, x.completed)));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const plotW = W - padL - 6; const plotH = H - padB - padT;
  const gw = plotW / b.length;
  const bw = Math.max(2, Math.min(18, gw * 0.36));
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const every = Math.ceil(b.length / 14);
  let svg = '';
  for (let v = 0; v <= top; v += step) {
    svg += `<line x1="${padL}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" stroke="${C.line}" stroke-width="1"/>`;
    svg += `<text x="${padL - 6}" y="${y(v) + 3}" text-anchor="end" class="ax">${v}</text>`;
  }
  b.forEach((x, i) => {
    const cx = padL + gw * i + gw / 2;
    const r1 = `<rect x="${cx - bw - 1}" y="${y(x.created)}" width="${bw}" height="${Math.max(0, y(0) - y(x.created))}" rx="2" fill="${C.created}"/>`;
    const r2 = `<rect x="${cx + 1}" y="${y(x.completed)}" width="${bw}" height="${Math.max(0, y(0) - y(x.completed))}" rx="2" fill="url(#g)"/>`;
    svg += r1 + r2;
    if (b.length <= 16) {
      if (x.created) svg += `<text x="${cx - bw / 2 - 1}" y="${y(x.created) - 3}" text-anchor="middle" class="val">${x.created}</text>`;
      if (x.completed) svg += `<text x="${cx + bw / 2 + 1}" y="${y(x.completed) - 3}" text-anchor="middle" class="val strong">${x.completed}</text>`;
    }
    if (i % every === 0) svg += `<text x="${cx}" y="${H - 8}" text-anchor="middle" class="ax">${esc(x.label)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" class="chart">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.brand}"/><stop offset="1" stop-color="#155e75"/></linearGradient></defs>
    ${svg}</svg>
    <div class="legend"><span><i style="background:${C.created}"></i>Поставлено</span><span><i style="background:${C.done}"></i>Выполнено</span>
    <span class="dim">по ${r.trend.unit === 'day' ? 'дням' : r.trend.unit === 'week' ? 'неделям' : 'месяцам'}</span></div>`;
}

function niceStep(max: number): number {
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / pow;
  return Math.max(1, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow);
}

/** Кольцо «в срок / с опозданием / без срока». */
function qualityDonut(r: TaskReport): string {
  const { onTime, late, noDeadline } = r.quality;
  const total = onTime + late + noDeadline;
  if (!total) return '<div class="empty-note">За период нет выполненных задач.</div>';
  const R = 46; const L = 2 * Math.PI * R;
  let offset = 0;
  const seg = (n: number, color: string) => {
    if (!n) return '';
    const len = (n / total) * L;
    const s = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${color}" stroke-width="16" stroke-dasharray="${len} ${L - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 60 60)"/>`;
    offset += len;
    return s;
  };
  const pctOnTime = onTime + late ? Math.round((onTime / (onTime + late)) * 100) : null;
  return `<div class="donut">
    <svg viewBox="0 0 120 120" width="120" height="120">
      <circle cx="60" cy="60" r="${R}" fill="none" stroke="${C.soft}" stroke-width="16"/>
      ${seg(onTime, C.good)}${seg(late, C.bad)}${seg(noDeadline, C.faint)}
      <text x="60" y="58" text-anchor="middle" class="donut-num">${pctOnTime === null ? '—' : `${pctOnTime}%`}</text>
      <text x="60" y="74" text-anchor="middle" class="donut-cap">в срок</text>
    </svg>
    <div class="donut-legend">
      <div><i style="background:${C.good}"></i>В срок <b>${onTime}</b></div>
      <div><i style="background:${C.bad}"></i>С опозданием <b>${late}</b></div>
      <div><i style="background:${C.faint}"></i>Без срока <b>${noDeadline}</b></div>
    </div></div>`;
}

function hbars(items: { label: string; count: number; color?: string }[]): string {
  const max = Math.max(1, ...items.map((x) => x.count));
  return `<div class="hbars">${items.map((x) => `
    <div class="hbar"><span class="hbar-l">${esc(x.label)}</span>
      <span class="hbar-track"><span class="hbar-fill" style="width:${(x.count / max) * 100}%;background:${x.color ?? C.brand}"></span></span>
      <span class="hbar-n">${x.count}</span></div>`).join('')}</div>`;
}

const PRIORITY_COLOR: Record<string, string> = { urgent: C.bad, high: C.warn, normal: C.brand, low: C.faint };

function pctCell(v: number | null) {
  if (v === null) return '<td class="num dim">—</td>';
  const tone = v >= 85 ? 'good' : v >= 60 ? 'warn' : 'bad';
  return `<td class="num"><span class="pill ${tone}">${v}%</span></td>`;
}

function groupTable(rows: GroupRow[], first: string, showHours: boolean): string {
  return `<table class="grid">
    <thead><tr><th>${first}</th><th class="num">Поставлено</th><th class="num">Выполнено</th><th class="num">В срок</th>
    <th class="num">Просрочено</th><th class="num">В работе</th><th class="num">Срок вып.</th>${showHours ? '<th class="num">Часы</th>' : ''}</tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td class="name">${esc(r.name)}</td><td class="num">${r.created}</td><td class="num strong">${r.completed}</td>${pctCell(r.onTimePct)}
      <td class="num ${r.overdueEnd ? 'bad-text strong' : 'dim'}">${r.overdueEnd}</td><td class="num">${r.openEnd}</td>
      <td class="num dim">${r.leadDays === null ? '—' : `${nf(r.leadDays)} дн.`}</td>${showHours ? `<td class="num">${r.hours ? nf(r.hours) : '—'}</td>` : ''}
    </tr>`).join('')}</tbody></table>`;
}

function verdictCell(t: TaskLine): string {
  switch (t.verdict) {
    case 'ontime': return '<span class="pill good">в срок</span>';
    case 'late': return `<span class="pill bad">+${t.days} дн.</span>`;
    case 'nodeadline': return '<span class="pill muted">без срока</span>';
    case 'overdue': return `<span class="pill bad">${t.days} дн.</span>`;
    case 'soon': return `<span class="pill warn">${t.days === 0 ? 'сегодня' : `через ${t.days} дн.`}</span>`;
    case 'review': return '<span class="pill warn">ждёт приёмки</span>';
  }
}

function taskTable(rows: TaskLine[], r: TaskReport, kind: 'completed' | 'overdue' | 'soon' | 'review' | 'hours'): string {
  const tz = r.timezone;
  const head = kind === 'completed'
    ? '<th class="id">№</th><th>Задача</th><th>Проект</th><th>Исполнитель</th><th class="num">Срок</th><th class="num">Закрыта</th><th class="num">Итог</th>'
    : kind === 'hours'
      ? '<th class="id">№</th><th>Задача</th><th>Проект</th><th>Исполнитель</th><th class="num">Часы</th>'
      : `<th class="id">№</th><th>Задача</th><th>Проект</th><th>Исполнитель</th><th class="num">Срок</th><th class="num">${kind === 'overdue' ? 'Просрочка' : kind === 'soon' ? 'Когда' : 'Статус'}</th>`;
  const body = rows.map((t) => {
    const common = `<td class="id">#${esc(t.id)}</td><td class="title">${esc(t.title)}</td><td class="dim">${esc(t.project)}</td><td>${esc(t.assignee)}</td>`;
    if (kind === 'completed') return `<tr>${common}<td class="num dim">${shortDate(t.deadline, tz)}</td><td class="num">${shortDate(t.closed, tz)}</td><td class="num">${verdictCell(t)}</td></tr>`;
    if (kind === 'hours') return `<tr>${common}<td class="num strong">${nf(t.hours)}</td></tr>`;
    return `<tr>${common}<td class="num">${shortDate(t.deadline, tz)}</td><td class="num">${verdictCell(t)}</td></tr>`;
  }).join('');
  return `<table class="grid tasks"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function section(n: number, title: string, sub: string, body: string, extraClass = ''): string {
  return `<section class="block ${extraClass}"><div class="sec-head"><span class="sec-n">${String(n).padStart(2, '0')}</span>
    <div><h2>${esc(title)}</h2>${sub ? `<div class="sec-sub">${sub}</div>` : ''}</div></div>${body}</section>`;
}

export function renderTaskReportHtml(r: TaskReport): string {
  const tz = r.timezone;
  let n = 0;
  const blocks: string[] = [];

  blocks.push(section(++n, 'Динамика', 'Сколько задач ставили и закрывали за период', trendChart(r)));

  blocks.push(section(++n, 'Качество выполнения', 'Соблюдение сроков и что именно выполняли', `
    <div class="cols3">
      <div class="panel"><div class="panel-t">Соблюдение сроков</div>${qualityDonut(r)}</div>
      <div class="panel"><div class="panel-t">По приоритету</div>${hbars(r.byPriority.map((x) => ({ label: x.label, count: x.count, color: PRIORITY_COLOR[x.key] })))}</div>
      <div class="panel"><div class="panel-t">По тегам</div>${r.byTag.length ? hbars(r.byTag.map((x) => ({ label: x.name, count: x.count, color: C.brand2 }))) : '<div class="empty-note">Выполненные задачи без тегов.</div>'}</div>
    </div>`));

  if (r.projects.length > 1) blocks.push(section(++n, 'По проектам', 'Отсортировано по числу выполненных задач', groupTable(r.projects, 'Проект', r.showHours), 'breakable'));
  if (r.people.length > 1) blocks.push(section(++n, 'По исполнителям', 'Часы — по учёту времени самого сотрудника, остальное — по задачам, где он исполнитель', groupTable(r.people, 'Сотрудник', r.showHours), 'breakable'));

  if (r.overdue.length) {
    blocks.push(section(++n, 'Просроченные задачи', `${r.ongoing ? 'Открыты сейчас' : 'Были открыты на конец периода'}, срок прошёл${r.overdueTotal > r.overdue.length ? ` · показаны ${r.overdue.length} из ${r.overdueTotal}` : ''}`,
      taskTable(r.overdue, r, 'overdue'), 'breakable'));
  }
  if (r.soon.length) blocks.push(section(++n, 'Под риском', 'Открытые задачи, срок которых наступает в ближайшие 3 дня', taskTable(r.soon, r, 'soon'), 'breakable'));
  if (r.review.length) blocks.push(section(++n, 'Ждут приёмки', 'Исполнитель сдал работу, постановщик ещё не принял', taskTable(r.review, r, 'review'), 'breakable'));
  if (r.topHours.length) blocks.push(section(++n, 'Больше всего времени', 'Задачи, на которые ушло больше всего часов за период', taskTable(r.topHours, r, 'hours'), 'breakable'));
  if (r.completed.length) {
    blocks.push(section(++n, 'Выполненные задачи', `В порядке закрытия${r.completedTotal > r.completed.length ? ` · показаны ${r.completed.length} из ${r.completedTotal}` : ''}`,
      taskTable(r.completed, r, 'completed'), 'breakable'));
  }

  const logo = r.logoDataUri
    ? `<img class="logo" src="${r.logoDataUri}" alt="">`
    : `<div class="logo-mark">${esc((r.companyName || 'A').trim()[0]?.toUpperCase() ?? 'A')}</div>`;

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${esc(r.title)} · ${esc(r.periodLabel)}</title>
<style>
  @page { size: A4; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: 'Inter', 'DejaVu Sans', sans-serif; color: ${C.text}; font-size: 9.5pt; line-height: 1.45; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .cover { border-radius: 14px; padding: 22px 24px 20px; color: #fff; background: linear-gradient(120deg, #0b3b4a 0%, ${C.brand} 48%, ${C.brand2} 100%); position: relative; overflow: hidden; }
  .cover::after { content: ''; position: absolute; right: -60px; top: -60px; width: 220px; height: 220px; border-radius: 50%; background: rgba(255,255,255,.07); }
  .cover-top { display: flex; align-items: center; gap: 12px; }
  .logo { width: 40px; height: 40px; border-radius: 10px; object-fit: contain; background: #fff; padding: 3px; }
  .logo-mark { width: 40px; height: 40px; border-radius: 10px; background: rgba(255,255,255,.18); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 18pt; }
  .company { font-weight: 700; font-size: 11pt; }
  .brand { font-size: 7.5pt; letter-spacing: .14em; opacity: .75; }
  .cover h1 { margin: 18px 0 2px; font-size: 22pt; line-height: 1.15; font-weight: 800; letter-spacing: -.01em; }
  .period { font-size: 13pt; font-weight: 600; opacity: .95; }
  .cover-meta { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 8.5pt; opacity: .88; }
  .chip { display: inline-block; padding: 2px 9px; border-radius: 99px; background: rgba(255,255,255,.18); font-weight: 600; }

  .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 14px 0 0; }
  .kpi { border: 1px solid ${C.line}; border-radius: 11px; padding: 10px 12px 9px; background: #fff; }
  .kpi-l { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .08em; color: ${C.muted}; font-weight: 600; }
  .kpi-v { font-size: 20pt; font-weight: 800; color: ${C.ink}; line-height: 1.1; margin: 3px 0 1px; }
  .kpi-v small { font-size: 10pt; font-weight: 600; color: ${C.muted}; }
  .kpi-h { font-size: 7.5pt; color: ${C.faint}; }
  .kpi-d { margin-top: 5px; display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; }
  .delta { font-size: 7.5pt; font-weight: 700; color: ${C.muted}; }
  .delta.good { color: ${C.good}; } .delta.bad { color: ${C.bad}; } .delta.neutral { color: ${C.brand}; }
  .delta-was { font-size: 7pt; color: ${C.faint}; }

  .insights { margin-top: 12px; border-radius: 11px; background: ${C.card}; border: 1px solid ${C.line}; padding: 11px 14px 10px; }
  .insights-t { font-weight: 700; color: ${C.ink}; font-size: 10pt; margin-bottom: 4px; }
  .insights ul { margin: 0; padding: 0; list-style: none; }
  .insights li { position: relative; padding-left: 14px; margin: 3px 0; }
  .insights li::before { content: ''; position: absolute; left: 2px; top: .58em; width: 6px; height: 6px; border-radius: 50%; background: linear-gradient(135deg, ${C.brand}, ${C.brand2}); }

  .block { margin-top: 18px; break-inside: avoid; }
  .block.breakable { break-inside: auto; }
  .sec-head { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 8px; break-after: avoid; }
  .sec-n { font-size: 8pt; font-weight: 800; color: #fff; background: linear-gradient(135deg, ${C.brand}, ${C.brand2}); border-radius: 6px; padding: 3px 6px; margin-top: 2px; }
  h2 { margin: 0; font-size: 13pt; color: ${C.ink}; font-weight: 750; }
  .sec-sub { font-size: 8pt; color: ${C.muted}; }

  .chart { display: block; }
  .chart .ax { font-size: 9px; fill: ${C.faint}; }
  .chart .val { font-size: 8.5px; fill: ${C.muted}; }
  .chart .val.strong { fill: ${C.brand}; font-weight: 700; }
  .legend { display: flex; gap: 14px; font-size: 8pt; color: ${C.muted}; margin-top: 2px; }
  .legend i, .donut-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
  .dim { color: ${C.faint}; }

  .cols3 { display: grid; grid-template-columns: 1.15fr 1fr 1fr; gap: 8px; }
  .panel { border: 1px solid ${C.line}; border-radius: 11px; padding: 10px 12px; }
  .panel-t { font-size: 8pt; font-weight: 700; color: ${C.ink}; margin-bottom: 6px; }
  .donut { display: flex; align-items: center; gap: 8px; }
  .donut-num { font-size: 20px; font-weight: 800; fill: ${C.ink}; }
  .donut-cap { font-size: 9px; fill: ${C.muted}; }
  .donut-legend div { font-size: 8pt; margin: 3px 0; white-space: nowrap; }
  .hbars { display: grid; gap: 5px; }
  .hbar { display: grid; grid-template-columns: 92px 1fr 22px; gap: 6px; align-items: center; font-size: 8pt; }
  .hbar-l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hbar-track { height: 8px; background: ${C.soft}; border-radius: 99px; overflow: hidden; }
  .hbar-fill { display: block; height: 100%; border-radius: 99px; }
  .hbar-n { text-align: right; font-weight: 700; color: ${C.ink}; }
  .empty-note { font-size: 8pt; color: ${C.faint}; padding: 10px 0; }

  table.grid { width: 100%; border-collapse: collapse; font-size: 8.3pt; }
  .grid thead { display: table-header-group; }
  .grid th { text-align: left; font-size: 7pt; text-transform: uppercase; letter-spacing: .06em; color: ${C.muted}; font-weight: 700; padding: 6px 6px; border-bottom: 1.5px solid ${C.ink}; }
  .grid td { padding: 5px 6px; border-bottom: 1px solid ${C.line}; vertical-align: top; }
  .grid tr { break-inside: avoid; }
  .grid tbody tr:nth-child(even) td { background: #fbfcfe; }
  .num { text-align: right; white-space: nowrap; }
  .grid td.name { font-weight: 600; color: ${C.ink}; }
  .tasks td.title { color: ${C.ink}; }
  .id { color: ${C.faint}; white-space: nowrap; width: 1%; }
  .strong { font-weight: 700; color: ${C.ink}; }
  .bad-text { color: ${C.bad} !important; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 99px; font-size: 7.5pt; font-weight: 700; white-space: nowrap; }
  .pill.good { background: ${C.goodSoft}; color: ${C.good}; }
  .pill.bad { background: ${C.badSoft}; color: ${C.bad}; }
  .pill.warn { background: ${C.warnSoft}; color: ${C.warn}; }
  .pill.muted { background: ${C.soft}; color: ${C.muted}; }

  .empty { margin-top: 24px; text-align: center; color: ${C.muted}; padding: 40px 20px; border: 1px dashed ${C.line}; border-radius: 12px; }
  .method { margin-top: 20px; font-size: 7.5pt; color: ${C.faint}; border-top: 1px solid ${C.line}; padding-top: 8px; break-inside: avoid; }
  .method b { color: ${C.muted}; }
</style></head><body>
  <header class="cover">
    <div class="cover-top">${logo}<div><div class="company">${esc(r.companyName)}</div><div class="brand">ANTHILL · ОТЧЁТНОСТЬ</div></div></div>
    <h1>${esc(r.title)}</h1>
    <div class="period">${esc(r.periodLabel)}${r.ongoing ? ' · период ещё идёт' : ''}</div>
    <div class="cover-meta">
      <span class="chip">${esc(r.scopeLabel)}</span>
      <span>Сравнение: ${esc(r.prevLabel)}</span>
      <span>Сформирован ${esc(longDateTime(r.generatedAt, tz))}${r.generatedBy ? ` · ${esc(r.generatedBy)}` : ''}</span>
    </div>
  </header>

  ${r.empty ? `<div class="empty"><b>За этот период по выбранным условиям задач нет.</b><br>Попробуйте другой период или уберите фильтр по проекту или сотруднику.</div>` : `
  <div class="kpis">${r.kpis.map((k) => `<div class="kpi"><div class="kpi-l">${esc(k.label)}</div><div class="kpi-v">${fmtValue(k)}</div>
    <div class="kpi-h">${esc(k.hint)}</div><div class="kpi-d">${delta(k)}</div></div>`).join('')}</div>

  <div class="insights"><div class="insights-t">Главное за период</div><ul>${r.insights.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>

  ${blocks.join('\n')}`}

  <div class="method"><b>Как считается.</b> Выполненной считается задача, закрытая в этом периоде; «в срок» — закрыта не позже своего срока
  (задачи без срока в процент не входят). Просроченные и «в работе» — ${r.ongoing ? 'на момент формирования отчёта' : 'на конец периода'}.
  Срок выполнения — медиана от постановки до закрытия. Сравнение — с предыдущим периодом такой же длины (${esc(r.prevLabel)}).
  Удалённые и объединённые задачи не учитываются. Время — в поясе компании (${esc(tz)}).</div>
</body></html>`;
}
