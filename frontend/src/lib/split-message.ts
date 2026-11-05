/**
 * Длинное сообщение — несколькими подряд, как в Telegram (#4786).
 *
 * Сервер принимает в одном сообщении до 8000 знаков, и раньше человек сам резал
 * длинный текст на куски. Режем за него: по абзацам, внутри слишком длинного
 * абзаца — по предложениям, затем по словам; слово длиннее части (ссылка на
 * десять тысяч знаков) — как есть, по длине.
 */
export const MESSAGE_MAX = 8000;

export function splitMessage(text: string, max = MESSAGE_MAX): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let cur = '';
  const push = () => { if (cur.trim()) parts.push(cur.trim()); cur = ''; };
  const add = (piece: string, sep: string) => {
    if (!cur) { cur = piece; return; }
    if (cur.length + sep.length + piece.length <= max) { cur += sep + piece; return; }
    push();
    cur = piece;
  };
  const addLong = (piece: string, level: 0 | 1 | 2) => {
    if (piece.length <= max) return void add(piece, level === 0 ? '\n\n' : level === 1 ? ' ' : ' ');
    if (level === 0) {
      for (const s of piece.split(/(?<=[.!?…])\s+/)) addLong(s, 1);
    } else if (level === 1) {
      for (const w of piece.split(/\s+/)) addLong(w, 2);
    } else {
      push();
      for (let i = 0; i < piece.length; i += max) { cur = piece.slice(i, i + max); push(); }
    }
  };
  for (const para of text.split(/\n{2,}/)) {
    // абзац целиком помещается — внутри него переносы строк сохраняем как есть
    if (para.length <= max) add(para, '\n\n');
    else { push(); addLong(para, 0); push(); }
  }
  push();
  return parts.length ? parts : [text.slice(0, max)];
}
