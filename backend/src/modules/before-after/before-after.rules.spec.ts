import {
  descriptionImageIds, descriptionText, edits, fingerprint, hasProblems, headline, matchShots, mentionedNumber,
  pageUrls, parseChange, parseCheck, parseSplit, remarksText, resultMessage, seesImages, settleVerdict, Shot,
  sideOf, splitItems, summarize,
} from './before-after.rules';
import { urlAllowed } from './page-shot';

const shot = (fileId: string, extra: Partial<Shot> = {}): Shot => ({
  fileId, name: `${fileId}.png`, mime: 'image/png', by: null, at: null, origin: 'attachment', ...extra,
});

describe('«Было/стало»: пункты правок', () => {
  it('чек-лист важнее описания, отметка «сделано» переносится как есть', () => {
    const r = splitItems({
      checklist: [{ text: 'Подзаголовок блока «Возможности»', done: true }, { text: 'Иконка карточки', done: false }],
      description: '<ol><li>Совсем другое</li><li>И ещё</li></ol>',
    });
    expect(r.source).toBe('checklist');
    expect(r.items.map((i) => i.title)).toEqual(['Подзаголовок блока «Возможности»', 'Иконка карточки']);
    expect(r.items[0].done).toBe(true);
  });

  it('список в описании: картинка под пунктом — к этому пункту, до первого — без привязки', () => {
    const html = '<p>Правки по сайту:</p><p><img data-file-id="10" alt="общий"></p>'
      + '<ol><li>Подзаголовок «Возможности»</li></ol><p><img data-file-id="11"></p>'
      + '<p>2) Карточка «Пульс команды»</p><p>в мобильной версии тоже</p><p><img data-file-id="12"></p>';
    const r = splitItems({ checklist: [], description: html });
    expect(r.source).toBe('list');
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toMatchObject({ title: 'Подзаголовок «Возможности»', descImages: ['11'] });
    expect(r.items[1]).toMatchObject({ title: 'Карточка «Пульс команды»', detail: 'в мобильной версии тоже', descImages: ['12'] });
    expect(r.looseImages).toEqual(['10']);
  });

  it('маркеры «—», «•», «*» и простой текст без HTML тоже список', () => {
    const r = splitItems({ checklist: [], description: 'Сделать:\n— убрать «Готовый ответ»\n• поменять иконку\n* поправить отступ' });
    expect(r.items.map((i) => i.title)).toEqual(['убрать «Готовый ответ»', 'поменять иконку', 'поправить отступ']);
  });

  it('один пункт — не список: делить будет модель или задача пойдёт целиком', () => {
    const r = splitItems({ checklist: [], description: '<p>Поменять заголовок на главной</p><p><img data-file-id="5"></p>' });
    expect(r.source).toBeNull();
    expect(r.items).toEqual([]);
    expect(r.looseImages).toEqual(['5']);
  });

  it('описание: текст без разметки и картинки по порядку', () => {
    const html = '<p>Было&nbsp;так &laquo;A&raquo;</p><img data-file-id="3"><p>и <b>так</b></p><img data-file-id="4">';
    expect(descriptionText(html)).toBe('Было так «A»\nи так');
    expect(descriptionImageIds(html)).toEqual(['3', '4']);
  });

  it('ответ модели о пунктах: JSON-массив, а если сломан — нумерованный список', () => {
    expect(parseSplit('```json\n["Поменять подзаголовок", "Заменить иконку"]\n```')).toEqual(['Поменять подзаголовок', 'Заменить иконку']);
    expect(parseSplit('1. Первое\n2. Второе')).toEqual(['Первое', 'Второе']);
    expect(parseSplit('нет пунктов')).toEqual([]);
  });
});

describe('«Было: … → Стало: …» из формулировки', () => {
  it.each([
    ['Заменить «помощник внутри переписки» на «помощник внутри приложения»', 'помощник внутри переписки', 'помощник внутри приложения'],
    ['вместо "Все задачи" — "Общие задачи"', 'Все задачи', 'Общие задачи'],
    ['Было «Старт», стало «Начать»', 'Старт', 'Начать'],
    ['«ANTHILL» → «QEVO»', 'ANTHILL', 'QEVO'],
  ])('%s', (text, from, to) => {
    expect(parseChange(text)).toEqual({ from, to });
  });

  it('«убрать «…»» — новое значение пустое (убрано)', () => {
    expect(parseChange('Убрать надпись «Бета»')).toEqual({ from: 'Бета', to: '' });
  });

  it('без кавычек ничего не придумываем', () => {
    expect(parseChange('Поправить отступы в шапке')).toBeNull();
  });
});

describe('«Было/стало»: чей файл', () => {
  const base = {
    creatorId: '1', doers: new Set(['2']), boundary: new Date('2026-10-20T10:00:00Z'),
    agentFiles: new Set(['90']), descriptionFiles: new Set(['80']),
  };
  const file = (fileId: string, uploadedBy: string, at = '2026-10-21T10:00:00Z') => ({
    fileId, name: 'a.png', mime: 'image/png', uploadedBy, uploaderName: null, at: new Date(at),
  });

  it('постановщик и прочие — «было», исполнитель — «стало»', () => {
    expect(sideOf(file('1', '1'), base)).toBe('before');
    expect(sideOf(file('2', '2'), base)).toBe('after');
    // руководитель со стрелками на снимке — тоже замечания
    expect(sideOf(file('3', '7'), base)).toBe('before');
  });

  it('описание — всегда «было», файл агента — всегда «стало»', () => {
    expect(sideOf(file('80', '2'), base)).toBe('before');
    expect(sideOf(file('90', '1'), base)).toBe('after');
  });

  it('задача «сам себе» — по времени: до начала работы «было», после — «стало»', () => {
    const self = { ...base, doers: new Set(['1']) };
    expect(sideOf(file('4', '1', '2026-10-20T09:00:00Z'), self)).toBe('before');
    expect(sideOf(file('5', '1', '2026-10-20T11:00:00Z'), self)).toBe('after');
  });
});

describe('«Было/стало»: снимки по пунктам', () => {
  const items = [
    { title: 'Подзаголовок блока «Возможности»', descImages: ['11'] },
    { title: 'Карточка «Пульс команды»' },
    { title: 'Иконка карточки «Задача из сообщения»' },
  ];

  it('номер в подписи, слова пункта и место в описании', () => {
    const r = matchShots(items, [
      shot('11'),
      shot('20', { caption: 'п. 3 готово' }),
      shot('21', { caption: 'Поправил карточку пульса команды' }),
      shot('22', { caption: 'что-то ещё' }),
    ]);
    expect(r.byItem.map((b) => b.map((s) => s.fileId))).toEqual([['11'], ['21'], ['20']]);
    expect(r.loose.map((s) => s.fileId)).toEqual(['22']);
  });

  it('поровну и без привязок — по порядку', () => {
    const r = matchShots([{ title: 'А' }, { title: 'Б' }], [shot('1'), shot('2')]);
    expect(r.byItem.map((b) => b.map((s) => s.fileId))).toEqual([['1'], ['2']]);
    expect(r.loose).toEqual([]);
  });

  it('один пункт — все снимки его', () => {
    const r = matchShots([{ title: 'Вся задача' }], [shot('1'), shot('2')]);
    expect(r.byItem[0]).toHaveLength(2);
  });

  it('номер называют по-разному', () => {
    expect(mentionedNumber('пункт 2 сделал')).toBe(2);
    expect(mentionedNumber('#4 и всё')).toBe(4);
    expect(mentionedNumber('3) иконка')).toBe(3);
    expect(mentionedNumber('версия 2026')).toBeNull();
  });
});

describe('«Было/стало»: ответ модели и вердикт', () => {
  it('разбор: лишние номера и неизвестные вердикты не пролезают', () => {
    const r = parseCheck('Вот: {"items":[{"n":1,"verdict":"fixed","reason":"на снимке 2 новый текст","before_shots":[1],"after_shots":[2]},'
      + '{"n":7,"verdict":"fixed"},{"n":2,"verdict":"maybe","reason":""}],"summary":"Проверил"}', 2);
    expect(r?.items).toHaveLength(2);
    expect(r?.items[0]).toMatchObject({ n: 1, verdict: 'fixed', afterShots: [2] });
    expect(r?.items[1].verdict).toBe('unclear');
    expect(parseCheck('не JSON', 2)).toBeNull();
  });

  const m = (verdict: 'fixed' | 'not_fixed' | 'unclear', reason = 'видно') => ({
    n: 1, verdict, reason, from: null, to: null, beforeShots: [], afterShots: [],
  });

  it('без «стало» — «результат не приложен», что бы ни сказала модель', () => {
    expect(settleVerdict({ model: m('fixed'), hasModel: true, modelSees: true, hasAfterShots: false, hasAfterOther: false }).verdict).toBe('no_result');
  });

  it('без модели — «проверьте глазами», без выдумок', () => {
    expect(settleVerdict({ model: null, hasModel: false, modelSees: false, hasAfterShots: true, hasAfterOther: false }).verdict).toBe('eyes');
  });

  it('модель не видит картинок, а кроме картинок ничего — глазами', () => {
    expect(settleVerdict({ model: m('fixed'), hasModel: true, modelSees: false, hasAfterShots: true, hasAfterOther: false }).verdict).toBe('eyes');
    // есть отчёт исполнителя словами — по нему модель судить может
    expect(settleVerdict({ model: m('fixed'), hasModel: true, modelSees: false, hasAfterShots: true, hasAfterOther: true }).verdict).toBe('fixed');
  });

  it('«не исправлено» без причины — не вывод', () => {
    expect(settleVerdict({ model: m('not_fixed', ''), hasModel: true, modelSees: true, hasAfterShots: true, hasAfterOther: false }).verdict).toBe('unclear');
    expect(settleVerdict({ model: m('not_fixed', 'на снимке прежний текст'), hasModel: true, modelSees: true, hasAfterShots: true, hasAfterOther: false }).verdict).toBe('not_fixed');
  });

  it('модель с картинками — по ответившей модели, а не по выбранной', () => {
    expect(seesImages('kimi-k3')).toBe(true);
    expect(seesImages('kimi-k2.6')).toBe(false);
    expect(seesImages('gpt-4o-mini')).toBe(true);
    expect(seesImages('claude-3-5-sonnet-latest')).toBe(true);
    expect(seesImages('meta-llama/llama-3.3-70b-instruct:free')).toBe(false);
    expect(seesImages('mock-llm')).toBe(false);
  });
});

describe('«Было/стало»: итог и сообщения', () => {
  const v = (...vs: ('fixed' | 'not_fixed' | 'unclear' | 'no_result' | 'eyes')[]) => vs.map((verdict) => ({ verdict }));

  it('всё внесено — «не нашли ошибок»', () => {
    const s = summarize(v('fixed', 'fixed', 'fixed'));
    expect(hasProblems(s)).toBe(false);
    expect(resultMessage(s, 'ai')).toBe('Посмотрите, мы проверили и не нашли ошибок: 3 из 3 правок внесены.');
    expect(headline(s)).toBe('Мы проверили 3 правки: 3 исправлено');
  });

  it('две не внесены — «нашли ошибки: 2 из 6»', () => {
    const s = summarize(v('fixed', 'fixed', 'not_fixed', 'fixed', 'not_fixed', 'unclear'));
    expect(hasProblems(s)).toBe(true);
    expect(resultMessage(s, 'ai')).toBe('Посмотрите, мы проверили и нашли ошибки: 2 из 6 правок не внесены.');
    expect(headline(s)).toBe('Мы проверили 6 правок: 3 исправлено, 2 не внесено, 1 — проверьте');
  });

  it('без модели не притворяемся проверившими', () => {
    expect(resultMessage(summarize(v('eyes', 'eyes')), 'eyes')).toMatch(/сравните снимки глазами/);
  });

  it('ошибок нет, но есть непонятные — так и говорим', () => {
    expect(resultMessage(summarize(v('fixed', 'unclear')), 'ai')).toMatch(/1 из 2 правок нужно посмотреть глазами/);
  });

  it('склонение «правка»', () => {
    expect([1, 2, 5, 11, 21, 22].map(edits)).toEqual(['1 правка', '2 правки', '5 правок', '11 правок', '21 правка', '22 правки']);
  });

  it('замечания исполнителю — только по невнесённым', () => {
    const t = remarksText([
      { n: 1, title: 'Подзаголовок', verdict: 'fixed', reason: '' },
      { n: 2, title: 'Иконка', verdict: 'not_fixed', reason: 'иконка прежняя' },
      { n: 3, title: 'Отступ', verdict: 'no_result', reason: 'Результат не приложен' },
    ]);
    expect(t).toBe('По отчёту «было/стало» не внесены правки:\n2. Иконка — иконка прежняя\n3. Отступ — Результат не приложен');
    expect(remarksText([{ n: 1, title: 'А', verdict: 'fixed', reason: '' }])).toBe('');
  });

  it('отпечаток: те же материалы — тот же, другие — другой', () => {
    expect(fingerprint({ a: [1, 2] })).toBe(fingerprint({ a: [1, 2] }));
    expect(fingerprint({ a: [1, 2] })).not.toBe(fingerprint({ a: [2, 1] }));
  });
});

describe('«Было/стало»: снимок страницы', () => {
  it('ссылки из текста: без своих адресов, файлов и хвостовой пунктуации', () => {
    expect(pageUrls([
      'Сайт https://example.com/landing, и задача https://qevo.one/projects/1/task/2',
      'картинка https://cdn.example.com/a.png и https://www.example.org/about).',
    ], ['qevo.one'])).toEqual(['https://example.com/landing', 'https://www.example.org/about']);
  });

  it('во внутреннюю сеть браузер не пускаем — ни по адресу, ни по имени', async () => {
    const resolve = async (h: string) => (h === 'inside.example.com' ? ['10.0.0.5'] : ['93.184.216.34']);
    expect(await urlAllowed('http://127.0.0.1/', resolve)).toBe(false);
    expect(await urlAllowed('http://169.254.169.254/latest/meta-data', resolve)).toBe(false);
    expect(await urlAllowed('http://localhost:3000/', resolve)).toBe(false);
    expect(await urlAllowed('https://inside.example.com/', resolve)).toBe(false);
    expect(await urlAllowed('file:///etc/passwd', resolve)).toBe(false);
    expect(await urlAllowed('https://example.com/', resolve)).toBe(true);
    expect(await urlAllowed('data:image/png;base64,AAAA', resolve)).toBe(true);
  });
});
