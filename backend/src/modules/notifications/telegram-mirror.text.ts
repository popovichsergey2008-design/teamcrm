/**
 * Письмо → сообщение в Telegram.
 *
 * Письмо и чат читают по-разному. В письме уместны приветствие, подпись и ссылка
 * отписки; в чате это шум, который отодвигает суть под обрез экрана. Поэтому здесь
 * не «отправка письма в мессенджер», а короткий пересказ: тема, суть, ссылка.
 *
 * Ссылку отписки убираем намеренно и отдельно: в ней личный токен, по которому любой
 * открывший её выключает человеку все уведомления. В письме она обязана быть,
 * в переслаиваемом сообщении — нет.
 */

/** Предел телеграма — 4096 символов; берём с запасом под служебные строки. */
const LIMIT = 3500;

const UNSUBSCRIBE = /^\s*отписаться\s*:/i;

/** Строки, которые в чате не несут ничего: пустая подпись, разделители. */
const NOISE = /^\s*[-—–_=]{3,}\s*$/;

export function mirrorText(subject: string, body: string): string {
  const lines: string[] = [];
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (UNSUBSCRIBE.test(line) || NOISE.test(line)) continue;
    // Подряд идущие пустые строки схлопываем: в письме это воздух вёрстки,
    // в чате — половина видимого сообщения.
    if (!line.trim() && !lines.at(-1)?.trim()) continue;
    lines.push(line);
  }
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();

  const head = String(subject ?? '').trim();
  const text = lines.join('\n').trim();
  // Тема часто повторяет первую строку письма — второй раз её не показываем.
  const full = !text ? head
    : !head || text.startsWith(head) ? text
      : `${head}\n\n${text}`;

  return clip(full, LIMIT);
}

/**
 * Обрезка по границе строки: обрыв на середине слова читается как поломка,
 * а последняя строка письма — обычно ссылка, которую половиной не открыть.
 */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const at = cut.lastIndexOf('\n');
  return `${(at > limit / 2 ? cut.slice(0, at) : cut).trimEnd()}\n…`;
}
