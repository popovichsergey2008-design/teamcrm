/**
 * Подсветка процитированного куска внутри исходного сообщения (задача #1338).
 *
 * Нажали на цитату — лента прокрутилась к исходному сообщению, и оно вспыхнуло
 * целиком. Но цитируют обычно один абзац из длинного сообщения, и «вот оно, ищите
 * сами» — не ответ. Как в Telegram: сообщение подсвечено, а внутри него — ещё и
 * ровно тот кусок, который процитировали.
 *
 * Разметка сообщения — HTML из лёгкой разметки, и цитата может пересекать жирный
 * текст, ссылку или перенос строки. Поэтому ищем по СКЛЕЕННОМУ тексту всех текстовых
 * узлов, а оборачиваем по частям — каждый узел своим `<mark>`.
 */

/** Пробелы в цитате и в сообщении могут расходиться (перенос строки против пробела). */
const WS = /\s+/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Где в тексте лежит цитата: начало и конец в символах склеенного текста.
 *
 * Чистая функция — её проверяет logic-check. Пустая цитата и цитата длиннее
 * сообщения не находятся; цитата, равная всему сообщению, тоже не отмечается:
 * сообщение и так подсвечено целиком, второй слой поверх — шум.
 */
export function findFragment(text: string, fragment: string): { start: number; end: number } | null {
  const clean = String(fragment ?? '').trim();
  if (!clean) return null;
  if (clean.replace(WS, ' ') === String(text ?? '').trim().replace(WS, ' ')) return null;
  const re = new RegExp(clean.split(WS).map(escapeRe).join('\\s+'), 'i');
  const m = re.exec(text);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length };
}

/**
 * Обернуть найденный кусок в `<mark>` внутри уже отрисованного узла.
 *
 * Возвращает откат: подсветка временная, а сообщение живёт дальше, и после неё
 * узел должен стать ровно таким, каким был.
 */
export function markFragment(root: HTMLElement, fragment: string): () => void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    text += n.textContent ?? '';
  }
  const hit = findFragment(text, fragment);
  if (!hit) return () => undefined;

  const marks: HTMLElement[] = [];
  let offset = 0;
  for (const node of nodes) {
    const len = node.textContent?.length ?? 0;
    const from = Math.max(hit.start, offset);
    const to = Math.min(hit.end, offset + len);
    offset += len;
    if (from >= to) continue;
    // Режем узел на «до», «кусок», «после» и оборачиваем только кусок.
    let piece = node;
    if (from - (offset - len) > 0) piece = piece.splitText(from - (offset - len));
    if (to - from < (piece.textContent?.length ?? 0)) piece.splitText(to - from);
    const mark = document.createElement('mark');
    mark.className = 'msg-quote-mark';
    piece.parentNode?.insertBefore(mark, piece);
    mark.appendChild(piece);
    marks.push(mark);
  }
  return () => {
    for (const mark of marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parent.normalize();
    }
  };
}
