/**
 * HTML → человеческий текст.
 *
 * Внешние трекеры хранят описания и комментарии разметкой: YouGile отдаёт HTML,
 * Битрикс — свой bb-код с примесью HTML. Мы храним и показываем ПЛОСКИЙ текст, и
 * необработанное описание превращается в «&lt;p&gt;Сделать &lt;strong&gt;до пятницы&lt;/strong&gt;&lt;/p&gt;» —
 * читать это невозможно, а искать по такому тексту тем более.
 *
 * Задача не «отрендерить HTML», а «оставить смысл»: переводы строк там, где были блоки,
 * пункты у списков, адрес у ссылки, если текста у неё нет. Всё остальное — снять.
 *
 * Чистые функции, проверяются jest'ом: разбор разметки регулярками ошибается молча —
 * съедает текст вместе с тегом или оставляет половину сущности.
 */

/** Сущности, которые реально встречаются в выгрузках трекеров. */
const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&laquo;': '«', '&raquo;': '»',
  '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&middot;': '·',
};

/** Раскрытие сущностей, включая числовые. Делается ПОСЛЕ снятия тегов. */
export function decodeEntities(input: string): string {
  return String(input ?? '')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;|&laquo;|&raquo;|&mdash;|&ndash;|&hellip;|&middot;/gi,
      (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (m, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return m; }
    })
    .replace(/&#(\d+);/g, (m, code) => {
      try { return String.fromCodePoint(Number(code)); } catch { return m; }
    });
}

export function htmlToText(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = String(raw).replace(/\r\n?/g, '\n');

  // Скрипты и стили выносим целиком с содержимым: их текст — не текст задачи.
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  // Картинка не переносится в плоский текст, но её подпись — единственное, что от неё
  // остаётся осмысленным.
  s = s.replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, (_m, alt) => `[${String(alt).trim()}]`);
  s = s.replace(/<img[^>]*>/gi, '');

  // Ссылка: текст, а если его нет — адрес. Ссылка без того и другого бесполезна.
  s = s.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
    const t = decodeEntities(String(text).replace(/<[^>]+>/g, '')).trim();
    const h = String(href).trim();
    if (!t) return h;
    // Не дублируем адрес, если он и есть текст ссылки.
    return t === h ? h : `${t} (${h})`;
  });

  // Пункты списка — маркером: без него список слипается в одну строку.
  s = s.replace(/<li[^>]*>/gi, '\n• ');
  // Блочные теги — перевод строки на закрытии.
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // «li» здесь нет намеренно: открывающий тег уже начал строку маркером, и второй
  // перевод на закрытии разредил бы список пустыми строками.
  s = s.replace(/<\/(p|div|tr|h[1-6]|blockquote|pre|section|article)>/gi, '\n');
  // Ячейки таблицы разделяем пробелом, иначе слова склеиваются: «ИтогоМосква».
  s = s.replace(/<\/(td|th)>/gi, ' ');
  // Всё остальное снимаем, текст оставляем.
  s = s.replace(/<[^>]+>/g, '');

  s = decodeEntities(s);

  // Пробелы и пустые строки: разметка щедра на них, читателю они не нужны.
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Есть ли в тексте разметка — чтобы не гонять чистку по тому, что уже чистое. */
export function looksLikeHtml(raw: string | null | undefined): boolean {
  const s = String(raw ?? '');
  return /<[a-z/!][^>]*>/i.test(s) || /&(nbsp|amp|lt|gt|quot|#\d+);/i.test(s);
}
