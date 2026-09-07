import JSZip from 'jszip';

/**
 * Чтение таблицы из файла: CSV и XLSX.
 *
 * Без новых зависимостей намеренно. XLSX — это zip с XML внутри, а `jszip` у нас уже
 * стоит (им распаковываются вложения). Тянуть ради чтения таблицы библиотеку на
 * полтора мегабайта незачем: нам нужны значения ячеек, а не формулы и оформление.
 *
 * Разбор вынесен отдельным модулем и проверяется тестами, потому что ошибается молча
 * и в самых частых местах:
 *  - русский Excel сохраняет CSV в windows-1251 и с ТОЧКОЙ С ЗАПЯТОЙ. Прочитанный как
 *    UTF-8, такой файл превращается в «Ð—Ð°Ð´Ð°Ñ‡Ð°», и человек винит систему;
 *  - в описании задачи бывают переводы строк и запятые — значит, кавычки обязательны;
 *  - в xlsx текст лежит НЕ в ячейке, а в общей таблице строк, и без неё вместо
 *    названий получаются числа.
 */

/** Ограничения прогона: файл больше — это уже не «переезд», а выгрузка базы. */
export const MAX_ROWS = 5000;

/** Кодировка: сначала пробуем UTF-8, при негодности — windows-1251. */
export function decodeText(buf: Buffer): string {
  // BOM — прямое указание, спорить не с чем
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  const utf8 = buf.toString('utf8');
  // U+FFFD появляется там, где байты не складываются в UTF-8: это и есть признак 1251
  if (!utf8.includes('�')) return utf8;
  try {
    return new TextDecoder('windows-1251').decode(buf);
  } catch {
    return utf8; // экзотическая сборка Node без ICU — читаем как есть, чем ничего
  }
}

/**
 * Разделитель определяем по ПЕРВОЙ СТРОКЕ вне кавычек.
 *
 * Считать по всему файлу нельзя: запятые в описаниях перевесят точки с запятой в
 * заголовке, и таблица развалится на одну колонку.
 */
export function sniffDelimiter(firstLine: string): string {
  const candidates = [';', ',', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch === d) count++;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/**
 * Разбор CSV.
 *
 * Свой, а не библиотечный: правил здесь ровно три (кавычки, удвоенная кавычка внутри
 * кавычек, перевод строки внутри кавычек), и все три проверены тестами. Библиотека
 * добавила бы зависимость и свои умолчания поверх этих трёх правил.
 */
export function parseCsv(text: string, delimiter?: string): string[][] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const d = delimiter ?? sniffDelimiter(clean.split('\n')[0] ?? '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { cell += '"'; i++; } // удвоенная кавычка — это кавычка
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === d) { row.push(cell); cell = ''; continue; }
    if (ch === '\n') {
      row.push(cell); cell = '';
      rows.push(row); row = [];
      continue;
    }
    cell += ch;
  }
  row.push(cell);
  rows.push(row);

  // пустые строки в конце файла — не данные, а следы редактора
  while (rows.length && rows[rows.length - 1].every((c) => !c.trim())) rows.pop();
  return rows.map((r) => r.map((c) => c.trim()));
}

/** XML-сущности: в выгрузках они встречаются в каждом втором названии с кавычками. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&'); // последним: иначе «&amp;lt;» развернётся дважды
}

/** Буква колонки → номер: A→0, Z→25, AA→26. Пропущенные ячейки в xlsx не пишутся вовсе. */
export function columnIndex(ref: string): number {
  const letters = (/^([A-Z]+)/.exec(ref.toUpperCase()) ?? ['', ''])[1];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, n - 1);
}

/** Текст всех `<t>` внутри куска XML: у строки с форматированием их несколько. */
function textOf(xml: string): string {
  const parts = [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]));
  return parts.join('');
}

/**
 * Чтение первого листа xlsx.
 *
 * Берём именно первый лист: выгрузки кладут данные на него, а выбор листа — вопрос,
 * который человеку задавать незачем, пока он не понадобился по-настоящему.
 */
export async function readXlsx(buf: Buffer): Promise<string[][]> {
  const zip = await JSZip.loadAsync(buf);
  const sheetFile = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!sheetFile) throw new Error('В файле нет листов с данными');

  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string');
  const shared = sharedXml
    ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
    : [];

  const sheet = await zip.file(sheetFile)!.async('string');
  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2];
      const ref = (/r="([A-Z]+\d+)"/.exec(attrs) ?? ['', ''])[1];
      const type = (/t="([^"]+)"/.exec(attrs) ?? ['', ''])[1];
      let value = '';
      if (type === 's') {
        const idx = Number((/<v>([\s\S]*?)<\/v>/.exec(body) ?? ['', ''])[1]);
        value = shared[idx] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(body);
      } else {
        value = unescapeXml((/<v>([\s\S]*?)<\/v>/.exec(body) ?? ['', ''])[1] ?? '');
      }
      const at = ref ? columnIndex(ref) : cells.length;
      while (cells.length < at) cells.push(''); // пустые ячейки в xlsx не хранятся
      cells[at] = value.trim();
    }
    // пустые ячейки в конце строки уравняем позже, по ширине заголовка
    rows.push(cells);
  }
  while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop();
  return rows;
}

/** Что за файл и как его читать. По расширению, а не по MIME: MIME браузеры врут. */
export async function readTable(fileName: string, buf: Buffer): Promise<string[][]> {
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  if (ext === 'xlsx' || ext === 'xlsm') return readXlsx(buf);
  if (ext === 'xls') {
    // старый бинарный формат — не zip и не текст; честно говорим, что делать
    throw new Error('Старый формат .xls не читается. Сохраните файл как .xlsx или .csv');
  }
  return parseCsv(decodeText(buf));
}

/**
 * Таблица → заголовок и строки.
 *
 * Первая строка — заголовок: так устроены все выгрузки. Строки короче заголовка
 * дополняем пустыми ячейками, иначе сопоставление колонок разъезжается на строках,
 * где последние поля пустые, — а это половина реальных файлов.
 */
export function splitHeader(table: string[][]): { headers: string[]; rows: string[][] } {
  if (!table.length) return { headers: [], rows: [] };
  // Безымянной колонке имя даём НЕ «Колонка N»: такое имя само попадёт под угадывание
  // и займёт поле «Колонка (статус)».
  const headers = table[0].map((h, i) => (h.trim() || `Без названия ${i + 1}`));
  const rows = table.slice(1, MAX_ROWS + 1)
    .filter((r) => r.some((c) => c && c.trim()))
    .map((r) => {
      const out = headers.map((_, i) => (r[i] ?? '').trim());
      return out;
    });
  return { headers, rows };
}
