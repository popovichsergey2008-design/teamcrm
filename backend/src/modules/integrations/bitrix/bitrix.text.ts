/**
 * Очистка текста из Битрикса от разметки (BBCode + остатки HTML) в читаемый plain-text.
 * У нас описания/комментарии рендерятся как обычный текст, поэтому теги [URL], [P], [B]… — «мусор».
 * Ссылки вида [URL=x]x[/URL] схлопываем в один URL; парные/одиночные bb-теги снимаем, содержимое оставляем.
 */
export function cleanBitrixMarkup(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw).replace(/\r\n?/g, '\n');

  // [URL=href]text[/URL] → text (или href, если text пуст/совпадает с href)
  s = s.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_m, href, text) => {
    const t = String(text).trim();
    const h = String(href).trim();
    return !t || t === h ? h : `${t} (${h})`;
  });
  // [URL]href[/URL] → href
  s = s.replace(/\[url\]([\s\S]*?)\[\/url\]/gi, (_m, href) => String(href).trim());
  // картинки Битрикса — убираем целиком
  s = s.replace(/\[img[^\]]*\]([\s\S]*?)\[\/img\]/gi, '');

  // списки
  s = s.replace(/\[\*\]\s*/gi, '\n• ');
  s = s.replace(/\[\/?list[^\]]*\]/gi, '\n');

  // параграфы / переводы строк
  s = s.replace(/\[\/p\]/gi, '\n');
  s = s.replace(/\[p\]/gi, '');
  s = s.replace(/\[br\s*\/?\]/gi, '\n');

  // прочие bb-теги (B, I, U, S, COLOR=, SIZE=, FONT=, QUOTE, CODE, TABLE, TR, TD…) — снять, текст оставить
  s = s.replace(/\[\/?[a-z][a-z0-9]*(=[^\]]+)?\]/gi, '');

  // остатки HTML
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');

  // html-сущности
  const ent: Record<string, string> = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&laquo;': '«', '&raquo;': '»', '&mdash;': '—', '&ndash;': '–',
  };
  s = s.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&laquo;|&raquo;|&mdash;|&ndash;/gi, (m) => ent[m.toLowerCase()] ?? m);
  s = s.replace(/&#(\d+);/g, (_m, code) => { try { return String.fromCodePoint(Number(code)); } catch { return _m; } });

  // схлопнуть лишние пробелы/пустые строки (пустые строки от [P]/[BR] → один перевод строки)
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
}
