/**
 * Форматированное описание задачи: Markdown ↔ HTML.
 *
 * Заказчик попросил «редактор, как в WordPress»: жирный, списки, картинки по Ctrl+V.
 * Редактор — визуальный (contentEditable), а ХРАНИМ по-прежнему текст в лёгкой
 * разметке: `**жирный**`, `- пункт`, `## заголовок`, `![снимок](/api/files/12)`.
 *
 * Почему не HTML в базе: описание читают не только глаза — его кладут в письма и
 * Telegram, отдают ИИ-агенту и в поиск, выгружают в .docx и синхронизируют с
 * YouGile и Битриксом. Текст со звёздочками везде остаётся читаемым, HTML — нет.
 * Старые описания (плоский текст) проходят через тот же разбор без изменений.
 *
 * Разбор — здесь, чистыми функциями, под проверкой логики: разметка ошибается
 * молча — съедает звёздочку из «5*3», делает ссылкой «т.д.» или теряет картинку.
 *
 * Поддерживаем ровно то, что есть на панели редактора, и ничего сверх: заголовок,
 * жирный, курсив, зачёркнутый, два вида списков, ссылка, картинка. Таблиц, цитат
 * и кода нет — их некому вставлять, а правила разбора они усложняют втрое.
 */

import { hrefOf, splitMessage } from './chat-text';

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Картинка из вложений задачи: только свои файлы, только по номеру. */
const IMG = /!\[([^\]]*)\]\(\/api\/files\/(\d+)\)/;
/** Ссылка `[текст](адрес)` — адрес только веб-схемы, иначе «javascript:» уехал бы в href. */
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/;
const BOLD = /\*\*([^*\n]+?)\*\*/;
const STRIKE = /~~([^~\n]+?)~~/;
/**
 * Курсив — одна звёздочка вокруг слова. Требуем непробельный символ с обеих сторон
 * внутри, иначе «5 * 3 * 2» превращалось бы в курсив.
 */
const ITALIC = /(^|[^*A-Za-zА-Яа-яЁё0-9])\*(\S(?:[^*\n]*\S)?)\*(?![*A-Za-zА-Яа-яЁё0-9])/;

const INLINE = new RegExp(
  `(${IMG.source})|(${LINK.source})|(${BOLD.source})|(${STRIKE.source})|(${ITALIC.source})`,
);

/** Обычный текст: ссылки кликаются, упоминания подсвечены — как в переписке. */
function plain(text: string): string {
  return splitMessage(text).map((p) => (
    p.kind === 'link' ? `<a href="${esc(hrefOf(p.value))}" target="_blank" rel="noreferrer">${esc(p.value)}</a>`
      : p.kind === 'mention' ? `<span class="msg-mention">${esc(p.value)}</span>`
        : esc(p.value)
  )).join('');
}

/** Строка с форматированием внутри: жирный, курсив, ссылки, картинки. */
export function inlineToHtml(text: string): string {
  let rest = text;
  let out = '';
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { out += plain(rest); break; }
    const at = m.index;
    out += plain(rest.slice(0, at));
    if (m[1]) {
      out += `<img data-file-id="${m[3]}" alt="${esc(m[2])}">`;
    } else if (m[4]) {
      out += `<a href="${esc(m[6])}" target="_blank" rel="noreferrer">${inlineToHtml(m[5])}</a>`;
    } else if (m[7]) {
      out += `<strong>${inlineToHtml(m[8])}</strong>`;
    } else if (m[9]) {
      out += `<s>${inlineToHtml(m[10])}</s>`;
    } else {
      // курсив: захваченный символ перед звёздочкой возвращаем в текст
      out += plain(m[12]) + `<em>${inlineToHtml(m[13])}</em>`;
    }
    rest = rest.slice(at + m[0].length);
  }
  return out;
}

const HEADING = /^(#{1,3})\s+(.*\S)\s*$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Разметка → HTML для показа и для загрузки в редактор.
 *
 * Картинки отдаются БЕЗ src: файлы за авторизацией, и голый адрес отдал бы 401.
 * Тот, кто показывает, подставляет содержимое сам по `data-file-id`.
 */
export function mdToHtml(md: string): string {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.map(inlineToHtml).join('<br>')}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`<${list.kind}>${list.items.map((i) => `<li>${inlineToHtml(i)}</li>`).join('')}</${list.kind}>`); list = null; }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flushPara(); flushList(); continue; }

    const h = HEADING.exec(line);
    if (h) {
      flushPara(); flushList();
      const level = Math.min(4, h[1].length + 1); // «#» — h2: h1 в карточке уже занят названием
      out.push(`<h${level}>${inlineToHtml(h[2])}</h${level}>`);
      continue;
    }
    const b = BULLET.exec(line);
    const n = b ? null : NUMBERED.exec(line);
    if (b || n) {
      flushPara();
      const kind = b ? 'ul' : 'ol';
      if (!list || list.kind !== kind) { flushList(); list = { kind, items: [] }; }
      list.items.push((b ?? n)![1]);
      continue;
    }
    // картинка отдельной строкой — отдельным блоком, а не внутри абзаца
    if (new RegExp(`^${IMG.source}$`).test(line.trim())) {
      flushPara(); flushList();
      out.push(`<p>${inlineToHtml(line.trim())}</p>`);
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara(); flushList();
  return out.join('');
}

/** Есть ли в описании хоть что-то, кроме пустоты. */
export function isBlank(md: string): boolean {
  return !String(md ?? '').trim();
}

/*
  ───── обратно: DOM редактора → разметка ─────

  Только для браузера: ходим по узлам contentEditable. Всё, что редактор не умеет
  показать на панели (таблицы, цвета, шрифты из вставленного Word), сводится к
  тексту — иначе в базу уезжал бы мусор, который потом не прочитать.
*/

type NodeLike = {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<NodeLike>;
  getAttribute?: (name: string) => string | null;
};

const isEl = (n: NodeLike) => n.nodeType === 1;

function inlineMd(node: NodeLike): string {
  if (node.nodeType === 3) return String(node.textContent ?? '').replace(/\u00a0/g, ' ');
  if (!isEl(node)) return '';
  const tag = node.nodeName.toLowerCase();
  const inner = () => Array.from(node.childNodes).map(inlineMd).join('');
  switch (tag) {
    case 'br': return '\n';
    case 'strong': case 'b': {
      const t = inner();
      return t.trim() ? `**${t.trim()}**` : t;
    }
    case 'em': case 'i': {
      const t = inner();
      return t.trim() ? `*${t.trim()}*` : t;
    }
    case 's': case 'strike': case 'del': {
      const t = inner();
      return t.trim() ? `~~${t.trim()}~~` : t;
    }
    case 'a': {
      const href = node.getAttribute?.('href') ?? '';
      const t = inner().trim();
      if (!/^https?:\/\//i.test(href)) return t;
      // адрес, набранный как есть, остаётся адресом: «[url](url)» — лишний шум
      return t === href ? href : `[${t || href}](${href})`;
    }
    case 'img': {
      const id = node.getAttribute?.('data-file-id');
      if (!id) return '';
      const alt = (node.getAttribute?.('alt') ?? 'снимок').replace(/[\]\n]/g, ' ');
      return `![${alt}](/api/files/${id})`;
    }
    default: return inner();
  }
}

const BLOCK = /^(p|div|ul|ol|h[1-6]|blockquote|section|article|pre|table)$/i;

/**
 * Дети контейнера: строчные узлы подряд — один абзац, блочные — каждый своим чередом.
 *
 * В contentEditable первая строка часто лежит голым текстом прямо в корне, а со
 * второй начинаются `<div>`: без склейки подряд идущих строчных узлов «abc<b>d</b>»
 * распадалось бы на две строки.
 */
function blocksOf(kids: NodeLike[], out: string[]): void {
  let run: NodeLike[] = [];
  const flush = () => {
    if (!run.length) return;
    const t = run.map(inlineMd).join('').replace(/^\n+|\n+$/g, '');
    if (t.trim()) out.push(t);
    run = [];
  };
  for (const k of kids) {
    if (isEl(k) && BLOCK.test(k.nodeName)) { flush(); blockMd(k, out); } else run.push(k);
  }
  flush();
}

function blockMd(node: NodeLike, out: string[]): void {
  if (!isEl(node)) {
    const t = inlineMd(node);
    if (t.trim()) out.push(t);
    return;
  }
  const tag = node.nodeName.toLowerCase();
  const kids = Array.from(node.childNodes);
  switch (tag) {
    case 'h1': case 'h2': out.push(`# ${inlineMd(node).trim()}`); out.push(''); return;
    case 'h3': out.push(`## ${inlineMd(node).trim()}`); out.push(''); return;
    case 'h4': case 'h5': case 'h6': out.push(`### ${inlineMd(node).trim()}`); out.push(''); return;
    case 'ul': case 'ol': {
      let i = 0;
      for (const li of kids) {
        if (li.nodeName.toLowerCase() !== 'li') continue;
        i++;
        const text = inlineMd(li).replace(/\n+/g, ' ').trim();
        out.push(tag === 'ul' ? `- ${text}` : `${i}. ${text}`);
      }
      out.push('');
      return;
    }
    case 'p': case 'div': case 'blockquote': case 'section': case 'article': case 'li': {
      // блок из блоков (div внутри div — так contentEditable делает Enter) — вглубь
      if (kids.some((k) => isEl(k) && BLOCK.test(k.nodeName))) {
        blocksOf(kids, out);
        return;
      }
      const t = inlineMd(node).replace(/^\n+|\n+$/g, '');
      out.push(t);
      return;
    }
    default: {
      const t = inlineMd(node);
      if (t.trim()) out.push(t);
    }
  }
}

/**
 * Содержимое редактора → разметка.
 *
 * Пустые строки схлопываем до одной: Enter в contentEditable плодит `<div><br></div>`,
 * и без этого между абзацами накапливались бы дыры.
 */
export function htmlToMd(root: NodeLike): string {
  const out: string[] = [];
  blocksOf(Array.from(root.childNodes), out);
  return out.join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
