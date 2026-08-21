#!/usr/bin/env node
/**
 * Проверка контраста текста по обеим темам (WCAG 2.1, порог AA 4.5:1).
 *
 * Зачем: цвета живут в токенах, и одно неудачное значение тихо ломает десятки мест
 * сразу — так `--text-mut` с контрастом 3.24:1 сделал нечитаемыми подписи в сайдбаре,
 * время в чате, заголовки секций и выходные в календаре. Глазами это не ловится:
 * в светлой теме выглядит «бледновато», в тёмной — «стильно».
 *
 * Как считаем: резолвим переменные каждой темы, берём каждое правило с `color` и
 * сравниваем с фоном. Фон — свой, если правило его задаёт; иначе проверяем по всем
 * поверхностям, на которых элемент может лежать, и ругаемся, только если он провален
 * на всех сразу (иначе получим шум от элементов, которые на подложке не встречаются).
 *
 * Полупрозрачный цвет накладываем на фон — иначе контраст считается по «чистому»
 * значению и врёт в обе стороны.
 *
 * Запуск: npm run contrast (в CI — рядом с линтером).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const AA = 4.5;
/** Поверхности, на которых может лежать текст без собственного фона. */
const SURFACES = ['--bg', '--bg-elev', '--bg-elev-2'];

/**
 * Осознанные исключения. Каждое — с причиной: молча заглушать проверку нельзя,
 * иначе список превращается в свалку и правило перестаёт работать.
 */
const ALLOW = [
  {
    selector: '.call-name',
    why: 'лежит поверх видео, а оно тёмное в любой теме (--video-bg), фон страницы под ним не виден',
  },
  {
    selector: '.label-chip',
    why: 'цвет текста считается от фона метки в labelTextColor() и приходит инлайном; #fff здесь — лишь запасной',
  },
];

// ── цвет ──────────────────────────────────────────────────────────────────────
const clamp255 = (n) => Math.max(0, Math.min(255, n));

function parseHex(raw) {
  let h = raw.replace('#', '').trim();
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (h.length === 8) h = h.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function parseRgba(raw) {
  const m = /^rgba?\(([^)]+)\)$/i.exec(raw.trim());
  if (!m) return null;
  const parts = m[1].replace(/\//g, ',').split(',').map((p) => parseFloat(p.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
  return { rgb: parts.slice(0, 3), alpha: parts.length > 3 && !Number.isNaN(parts[3]) ? parts[3] : 1 };
}

/** Значение → RGB. `over` нужен, чтобы наложить полупрозрачное на реальный фон. */
function toRgb(value, tokens, over = null, depth = 0) {
  if (value == null || depth > 12) return null;
  const v = String(value).replace(/!important/g, '').trim();
  if (!v) return null;

  const varMatch = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/.exec(v);
  if (varMatch) {
    const [, name, fallback] = varMatch;
    if (tokens[name] !== undefined) return toRgb(tokens[name], tokens, over, depth + 1);
    return fallback ? toRgb(fallback, tokens, over, depth + 1) : null;
  }
  if (v.startsWith('#')) return parseHex(v);
  if (/^rgba?\(/i.test(v)) {
    const p = parseRgba(v);
    if (!p) return null;
    if (p.alpha >= 0.999) return p.rgb;
    if (!over) return null;
    return p.rgb.map((c, i) => p.alpha * c + (1 - p.alpha) * over[i]);
  }
  const named = { white: [255, 255, 255], black: [0, 0, 0] };
  return named[v.toLowerCase()] ?? null;
}

function luminance([r, g, b]) {
  const lin = (c) => {
    const x = clamp255(c) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// ── разбор css ────────────────────────────────────────────────────────────────
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Тело блока по позиции открывающей скобки — со счётом вложенности (@media). */
function blockAt(css, from) {
  const open = css.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return '';
}

const declsOf = (body) => {
  const out = {};
  for (const [, prop, value] of body.matchAll(/([-\w]+)\s*:\s*([^;{}]+)/g)) {
    out[prop.trim().toLowerCase()] = value.trim();
  }
  return out;
};

function tokensFrom(body) {
  const out = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[name] = value.trim();
  return out;
}

function findBlock(css, needle) {
  const at = css.indexOf(needle);
  return at < 0 ? '' : blockAt(css, at);
}

function rulesOf(css, file) {
  const out = [];
  for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const selector = m[1].split(/\s+/).join(' ').trim();
    if (!selector || selector.startsWith(':root') || selector.startsWith('@') || selector === '*') continue;
    out.push({
      file,
      line: css.slice(0, m.index).split('\n').length,
      selector,
      decls: declsOf(m[2]),
    });
  }
  return out;
}

function ownBackground(decls) {
  for (const prop of ['background', 'background-color']) {
    const raw = decls[prop];
    if (!raw) continue;
    const first = raw.trim().split(/\s+(?![^(]*\))/)[0];
    if (first && !['none', 'transparent', 'inherit', 'initial'].includes(first)) return raw.trim();
  }
  return null;
}

// ── прогон ────────────────────────────────────────────────────────────────────
const files = readdirSync(SRC).filter((f) => f.endsWith('.css')).sort();
if (!files.length) {
  console.error('contrast: не найдено ни одного .css в', SRC);
  process.exit(2);
}
const sources = files.map((f) => ({ name: f, css: stripComments(readFileSync(join(SRC, f), 'utf8')) }));

// Палитра: светлая — база, тёмная — те же токены с переопределениями.
const base = sources.find((s) => s.name === 'index.css') ?? sources[0];
const light = tokensFrom(findBlock(base.css, ':root {'));
const dark = { ...light, ...tokensFrom(findBlock(base.css, ':root[data-theme="dark"]')) };
const THEMES = { светлая: light, тёмная: dark };

if (!Object.keys(light).length) {
  console.error('contrast: не разобрал токены :root — проверьте формат', base.name);
  process.exit(2);
}

const rules = sources.flatMap((s) => rulesOf(s.css, s.name));
const withColor = rules.filter((r) => r.decls.color);
const allowed = (selector) => ALLOW.find((a) => selector.includes(a.selector));

const findings = [];
for (const rule of withColor) {
  const color = rule.decls.color;
  for (const [theme, tokens] of Object.entries(THEMES)) {
    const bgDecl = ownBackground(rule.decls);
    const bases = bgDecl
      ? [{ label: bgDecl, rgb: toRgb(bgDecl, tokens, toRgb('var(--bg-elev)', tokens)) }]
      : SURFACES.map((s) => ({ label: s, rgb: toRgb(`var(${s})`, tokens) }));

    const checked = [];
    for (const { label, rgb } of bases) {
      if (!rgb) continue;
      const fg = toRgb(color, tokens, rgb);
      if (!fg) continue;
      checked.push({ label, ratio: contrast(fg, rgb) });
    }
    if (!checked.length) continue;

    const failing = checked.filter((c) => c.ratio < AA);
    // без своего фона правило провалено, только если провалено на ВСЕХ поверхностях
    if (!failing.length || (!bgDecl && failing.length < checked.length)) continue;

    const worst = failing.reduce((a, b) => (a.ratio <= b.ratio ? a : b));
    findings.push({
      ...rule,
      theme,
      color,
      bg: bgDecl ? worst.label : 'любая поверхность',
      ratio: worst.ratio,
      allow: allowed(rule.selector),
    });
  }
}

findings.sort((a, b) => a.ratio - b.ratio);
const real = findings.filter((f) => !f.allow);
const skipped = findings.filter((f) => f.allow);

const pad = (s, n) => String(s).padEnd(n).slice(0, n);
console.log(`контраст: тем 2, правил с color — ${withColor.length}, порог AA ${AA}:1`);

if (skipped.length) {
  console.log(`\nисключения (${skipped.length}):`);
  for (const f of skipped) {
    console.log(`  ${f.ratio.toFixed(2)}:1  ${f.selector} — ${f.allow.why}`);
  }
}

if (!real.length) {
  console.log('\nпровалов нет.');
  process.exit(0);
}

console.log(`\nПРОВАЛОВ: ${real.length}\n`);
for (const f of real) {
  console.log(
    `  ${f.ratio.toFixed(2).padStart(5)}:1  ${pad(f.theme, 8)} ${pad(`${f.file}:${f.line}`, 16)} ` +
      `${pad(f.selector, 44)} color=${pad(f.color, 22)} фон=${f.bg}`,
  );
}
console.log(
  '\nПочинить можно тремя способами: приглушить токен текста, взять под белый текст плотную ' +
    'заливку --fill-* (в тёмной теме --danger/--warn/--ok/--accent — пастель, белым по ним нельзя) ' +
    'или, если случай осознанный, добавить его в ALLOW в этом файле с объяснением.',
);
process.exit(1);
