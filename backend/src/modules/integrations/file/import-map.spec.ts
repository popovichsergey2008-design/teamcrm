import { guessMapping, parseBool, parseDate, parseHours, parsePriority, splitLabels } from './import-map';
import { columnIndex, decodeText, parseCsv, sniffDelimiter, splitHeader } from './table-read';

/**
 * Импорт ошибается молча и целиком: неверно угаданная колонка уносит смысл всей
 * выгрузки, а неверно прочитанная кодировка превращает названия в «Ð—Ð°Ð´Ð°Ñ‡Ð°».
 * Здесь проверяется ровно то, на чём спотыкаются реальные файлы из Excel, Trello и
 * Notion — а не «функция что-то возвращает».
 */

describe('чтение CSV', () => {
  it('русский Excel: точка с запятой и windows-1251', () => {
    // тот же текст в 1251: без определения кодировки получится мусор
    const cp1251 = Buffer.from([
      0xc7, 0xe0, 0xe4, 0xe0, 0xf7, 0xe0, // «Задача»
      0x3b, // ;
      0xd1, 0xf0, 0xee, 0xea, // «Срок»
    ]);
    const text = decodeText(cp1251);
    expect(text).toBe('Задача;Срок');
    expect(sniffDelimiter(text)).toBe(';');
    expect(parseCsv(text)).toEqual([['Задача', 'Срок']]);
  });

  it('BOM не попадает в первый заголовок', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Задача,Срок', 'utf8')]);
    expect(parseCsv(decodeText(buf))[0][0]).toBe('Задача');
  });

  it('кавычки: запятая и перевод строки внутри значения', () => {
    const csv = 'Название,Описание\n"Сверстать, наконец","Первая строка\nВторая строка"\n';
    expect(parseCsv(csv)).toEqual([
      ['Название', 'Описание'],
      ['Сверстать, наконец', 'Первая строка\nВторая строка'],
    ]);
  });

  it('удвоенная кавычка внутри значения — это кавычка', () => {
    expect(parseCsv('a\n"Проект ""Восход"""')).toEqual([['a'], ['Проект "Восход"']]);
  });

  it('разделитель определяется по заголовку, а не по всему файлу', () => {
    // в описаниях запятых больше, но заголовок разделён точкой с запятой
    const csv = 'Название;Описание\nЗадача;"раз, два, три, четыре, пять"';
    expect(parseCsv(csv)).toEqual([['Название', 'Описание'], ['Задача', 'раз, два, три, четыре, пять']]);
  });

  it('короткие строки дополняются до ширины заголовка', () => {
    const { headers, rows } = splitHeader(parseCsv('Название,Срок,Исполнитель\nЗадача,,\nВторая'));
    expect(headers).toEqual(['Название', 'Срок', 'Исполнитель']);
    expect(rows).toEqual([['Задача', '', ''], ['Вторая', '', '']]);
  });

  it('пустые строки в конце файла не превращаются в задачи', () => {
    const { rows } = splitHeader(parseCsv('Название\nЗадача\n\n\n'));
    expect(rows).toEqual([['Задача']]);
  });

  it('буква колонки xlsx превращается в номер', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('Z9')).toBe(25);
    expect(columnIndex('AA1')).toBe(26);
  });
});

describe('угадывание колонок', () => {
  it('русская выгрузка', () => {
    const m = guessMapping(['Задача', 'Ответственный', 'Срок', 'Статус', 'Приоритет', 'Описание']);
    expect(m.title).toBe(0);
    expect(m.assignee).toBe(1);
    expect(m.deadline).toBe(2);
    expect(m.column).toBe(3);
    expect(m.priority).toBe(4);
    expect(m.description).toBe(5);
  });

  it('выгрузка Trello', () => {
    const m = guessMapping(['Card Name', 'Card Description', 'List', 'Labels', 'Due Date', 'Members']);
    expect(m.title).toBe(0);
    expect(m.description).toBe(1);
    expect(m.column).toBe(2);
    expect(m.labels).toBe(3);
    expect(m.deadline).toBe(4);
  });

  it('одна колонка не занимает два поля, а одно поле не берёт две колонки', () => {
    const m = guessMapping(['Название', 'Название задачи']);
    expect(m.title).toBe(0);
    expect(Object.values(m).filter((v) => v === 1)).toHaveLength(0);
  });

  it('незнакомые заголовки остаются человеку', () => {
    expect(guessMapping(['Ерунда', 'Что-то своё'])).toEqual({});
    // безымянная колонка получает имя, которое НЕ угадывается как поле
    expect(guessMapping(splitHeader([['', '']]).headers)).toEqual({});
  });
});

describe('разбор значений', () => {
  it('даты: ISO, русская точка, серийное число Excel', () => {
    expect(parseDate('2026-09-07')?.toISOString().slice(0, 10)).toBe('2026-09-07');
    expect(parseDate('2026-09-07T14:30')?.toISOString().slice(0, 16)).toBe('2026-09-07T14:30');
    // 03.04.2026 — третье апреля: в русских выгрузках день идёт первым
    expect(parseDate('03.04.2026')?.toISOString().slice(0, 10)).toBe('2026-04-03');
    expect(parseDate('7/9/2026')?.toISOString().slice(0, 10)).toBe('2026-09-07');
    expect(parseDate('01.02.26')?.toISOString().slice(0, 10)).toBe('2026-02-01');
    // Excel отдаёт дату числом от 30.12.1899
    expect(parseDate('46272')?.toISOString().slice(0, 10)).toBe('2026-09-07');
  });

  it('несуществующие и мусорные даты не переносятся вовсе', () => {
    expect(parseDate('31.02.2026')).toBeNull();
    expect(parseDate('13.13.2026')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('когда-нибудь')).toBeNull();
    expect(parseDate('5')).toBeNull(); // обычное число — не дата
  });

  it('приоритет: незнакомое слово — обычный, а не отказ', () => {
    expect(parsePriority('Срочно')).toBe('urgent');
    expect(parsePriority('critical')).toBe('urgent');
    expect(parsePriority('Высокий')).toBe('high');
    expect(parsePriority('Low')).toBe('low');
    expect(parsePriority('розовый')).toBe('normal');
    expect(parsePriority('')).toBe('normal');
  });

  it('«да/нет» во всех видах', () => {
    for (const yes of ['да', 'Да', 'YES', 'true', '1', 'Done', 'закрыта']) expect(parseBool(yes)).toBe(true);
    for (const no of ['нет', 'false', '0', '', 'в работе']) expect(parseBool(no)).toBe(false);
  });

  it('метки и часы', () => {
    expect(splitLabels('срочно, дизайн; фронт')).toEqual(['срочно', 'дизайн', 'фронт']);
    expect(splitLabels('')).toEqual([]);
    expect(parseHours('8')).toBe(8);
    expect(parseHours('8,5 ч')).toBe(8.5);
    expect(parseHours('нет')).toBeNull();
    expect(parseHours('-3')).toBe(3); // знак не читаем: «-3 ч» в выгрузке значит «3 часа»
  });
});
