/**
 * Извлечение текста из вложений — чтобы «найди договор по номеру» искало по СОДЕРЖИМОМУ,
 * а не по имени файла.
 *
 * Что поддерживаем и почему именно это:
 *   • простой текст, markdown, csv, json — читаются как есть;
 *   • docx и xlsx — это zip с XML внутри, разбираются без тяжёлых библиотек;
 *   • pdf — самый частый формат договоров и счетов, ради него взята pdf-parse.
 *
 * Чего НЕ делаем: распознавания текста на картинках и сканах. Это отдельный
 * распознаватель с ценой за страницу, и делать вид, что скан проиндексирован,
 * нельзя — человек будет искать в нём и не находить, считая, что система сломалась.
 */
import JSZip from 'jszip';
// Точечный импорт: у пакета в index.js есть отладочная ветка, читающая тестовый файл с диска.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

/** Больше — не индексируем: разбор гигантского файла заблокирует очередь. */
export const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** Обрезаем текст: смысл документа задаётся началом, а эмбеддинги стоят денег. */
export const MAX_TEXT_CHARS = 200_000;

type Kind = 'plain' | 'docx' | 'xlsx' | 'pdf' | null;

const ext = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();

/** Чем разбирать файл. Смотрим и на расширение, и на тип: у импортных файлов тип часто врёт. */
export function detectKind(fileName: string, contentType = ''): Kind {
  const e = ext(fileName);
  const ct = contentType.toLowerCase();
  if (e === 'pdf' || ct === 'application/pdf') return 'pdf';
  if (e === 'docx' || ct.includes('wordprocessingml')) return 'docx';
  if (e === 'xlsx' || ct.includes('spreadsheetml')) return 'xlsx';
  if (['txt', 'md', 'csv', 'log', 'json', 'yml', 'yaml'].includes(e)) return 'plain';
  if (ct.startsWith('text/') || ct === 'application/json') return 'plain';
  return null;
}

/** XML в текст: теги прочь, абзацы и ячейки — через перевод строки. */
export function xmlToText(xml: string): string {
  return xml
    .replace(/<\/w:p>|<\/a:p>|<\/text:p>/g, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

async function fromZipXml(buf: Buffer, entries: string[]): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const parts: string[] = [];
  for (const name of entries) {
    const file = zip.file(name);
    if (file) parts.push(xmlToText(await file.async('string')));
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * Текст файла или null, если формат не поддержан либо в нём нечего искать.
 * Ошибку разбора не считаем сбоем системы: битый или защищённый паролем PDF —
 * обычное дело, из-за него не должна падать индексация остального.
 */
export async function extractText(
  buf: Buffer,
  fileName: string,
  contentType = '',
): Promise<{ text: string; kind: Exclude<Kind, null> } | null> {
  if (buf.length > MAX_FILE_BYTES) return null;
  const kind = detectKind(fileName, contentType);
  if (!kind) return null;

  try {
    let text = '';
    if (kind === 'plain') {
      text = buf.toString('utf8');
    } else if (kind === 'docx') {
      text = await fromZipXml(buf, ['word/document.xml']);
    } else if (kind === 'xlsx') {
      // В xlsx текст ячеек лежит в общей таблице строк — для поиска этого достаточно.
      text = await fromZipXml(buf, ['xl/sharedStrings.xml']);
    } else {
      text = (await pdfParse(buf)).text ?? '';
    }

    text = text.replace(/\u0000/g, '').trim(); // из pdf иногда лезут нулевые байты
    if (text.length < 3) return null; // скан без текстового слоя — честно считаем, что содержимого нет
    return { text: text.slice(0, MAX_TEXT_CHARS), kind };
  } catch {
    return null;
  }
}
