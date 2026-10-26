import {
  autoWorthy, descriptionCallsExample, descriptionImageContext, descriptionImageIds, descriptionText, edits,
  fingerprint, hasProblems, headline, initialRole, kindByRules, looksVisual, matchShots, mentionedNumber,
  needsResult, pageUrls, parseChange, parseCheck, parseSplit, points, remarksText, resultMessage, ruleRole,
  saysExample, seesImages, settleVerdict, Shot, sideOf, splitItems, summarize,
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

  it('без «стало» — «результат не приложен»; но мнение модели «выполнено» не глушим — «стоит посмотреть»', () => {
    expect(settleVerdict({ model: m('unclear'), hasModel: true, modelSees: true, hasAfterShots: false, hasAfterOther: false }).verdict).toBe('no_result');
    expect(settleVerdict({ model: m('not_fixed'), hasModel: true, modelSees: true, hasAfterShots: false, hasAfterOther: false }).verdict).toBe('no_result');
    expect(settleVerdict({ model: null, hasModel: false, modelSees: false, hasAfterShots: false, hasAfterOther: false }).verdict).toBe('no_result');
    // #4657: модель сочла пункт подтверждённым по снимкам — показываем её объяснение, решает человек
    const r = settleVerdict({ model: m('fixed', 'на снимке 2 отчёт с блоками «Было/Стало»'), hasModel: true, modelSees: true, hasAfterShots: false, hasAfterOther: false });
    expect(r.verdict).toBe('unclear');
    expect(r.reason).toMatch(/ИИ считает, что пункт выполнен: на снимке 2 отчёт/);
    // без причины — не мнение, а пустое слово: остаётся «без результата»
    expect(settleVerdict({ model: m('fixed', ''), hasModel: true, modelSees: true, hasAfterShots: false, hasAfterOther: false }).verdict).toBe('no_result');
  });

  it('чек-лист приёмки: без модели — проверить по отчёту исполнителя, без отчёта — без результата', () => {
    const eyes = settleVerdict({ model: null, hasModel: false, modelSees: false, hasAfterShots: false, hasAfterOther: true, kind: 'functional' });
    expect(eyes).toEqual({ verdict: 'eyes', reason: 'ИИ не подключён — проверьте пункт по отчёту исполнителя сами.' });
    expect(settleVerdict({ model: null, hasModel: false, modelSees: false, hasAfterShots: false, hasAfterOther: false, kind: 'functional' }).reason)
      .toMatch(/не написал, что проверил/);
  });

  it('разбор: тип задачи и роли снимков — только известные номера и роли, не результат исполнителя', () => {
    const raw = JSON.stringify({
      kind: 'functional',
      shot_roles: [
        { shot: 1, role: 'example' }, { shot: 2, role: 'reference' }, { shot: 3, role: 'after' },
        { shot: 9, role: 'example' }, { shot: 1, role: 'before' }, { shot: 4, role: 'example' },
      ],
      items: [{ n: 1, verdict: 'unclear', reason: 'нет' }],
    });
    // снимок 4 — результат исполнителя: его роль модели не решать
    const r = parseCheck(raw, 1, 4, (n) => n !== 4);
    expect(r?.kind).toBe('functional');
    expect(r?.roles).toEqual([{ shot: 1, role: 'example' }, { shot: 2, role: 'reference' }]);
    expect(parseCheck(JSON.stringify({ kind: 'странный', items: [{ n: 1, verdict: 'fixed' }] }), 1)?.kind).toBeNull();
    // старый промпт (клон компании) ролей не знает — разбор не ломается
    expect(parseCheck('{"items":[{"n":1,"verdict":"fixed","reason":"да"}]}', 1)?.roles).toEqual([]);
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
    expect(resultMessage(s, 'ai')).toBe('Посмотрите, мы проверили и нашли ошибки: 2 из 6 правок не внесены; ещё 1 стоит посмотреть.');
    expect(headline(s)).toBe('Мы проверили 6 правок: 3 исправлено, 2 не внесено, 1 стоит посмотреть');
    expect(resultMessage(summarize(v('fixed', 'not_fixed')), 'ai')).toBe('Посмотрите, мы проверили и нашли ошибки: 1 из 2 правок не внесены.');
  });

  it('без модели не притворяемся проверившими', () => {
    expect(resultMessage(summarize(v('eyes', 'eyes')), 'eyes')).toMatch(/сравните снимки глазами/);
  });

  it('ошибок нет, но есть непонятные — так и говорим', () => {
    expect(resultMessage(summarize(v('fixed', 'unclear')), 'ai')).toMatch(/ошибок не нашли, но 1 из 2 правок стоит посмотреть глазами/);
  });

  it('«нашли ошибки» — только при невнесённых; без результата у всех — «проверять нечего»', () => {
    const none = summarize(v('no_result', 'no_result', 'no_result', 'no_result'));
    expect(hasProblems(none)).toBe(false);
    expect(needsResult(none)).toBe(true);
    for (const mode of ['ai', 'eyes'] as const) {
      for (const kind of ['visual', 'functional'] as const) {
        expect(resultMessage(none, mode, kind)).toBe('Исполнитель пока не приложил результат — проверять нечего.');
      }
    }
    expect(headline(none)).toBe('4 правки — результат пока не приложен');
    expect(headline(none, 'functional')).toBe('Чек-лист приёмки, 4 пункта: 4 без результата');
  });

  it('смешанный случай — честно по числам, без слова «ошибки»', () => {
    const s = summarize(v('fixed', 'fixed', 'no_result', 'unclear'));
    expect(resultMessage(s, 'ai')).toBe('Посмотрите, что получилось: 2 исправлено, 1 без результата, 1 стоит посмотреть.');
    expect(resultMessage(s, 'ai', 'functional')).toBe('Посмотрите, что получилось: 2 подтверждено, 1 без результата, 1 стоит посмотреть.');
    const eyes = resultMessage(summarize(v('eyes', 'no_result')), 'eyes');
    expect(eyes).toBe('Мы собрали отчёт «было/стало» по 2 правкам — ИИ не подключён, сравните снимки глазами. По 1 из 2 правок результат пока не приложен.');
    for (const msg of [resultMessage(s, 'ai'), eyes]) expect(msg).not.toMatch(/ошибк/);
  });

  it('чек-лист приёмки: «подтверждено», пункты, а не правки', () => {
    expect(resultMessage(summarize(v('fixed', 'fixed')), 'ai', 'functional')).toBe('Посмотрите, мы проверили: 2 из 2 пунктов подтверждены отчётом исполнителя.');
    expect(resultMessage(summarize(v('eyes')), 'eyes', 'functional')).toMatch(/чек-лист приёмки по одному пункту — ИИ не подключён/);
    expect([1, 3, 5, 21].map(points)).toEqual(['1 пункт', '3 пункта', '5 пунктов', '21 пункт']);
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
    // одни «без результата» — не «не внесены»
    expect(remarksText([{ n: 1, title: 'А', verdict: 'no_result', reason: '' }])).toBe('По отчёту «было/стало» нет результата по пунктам:\n1. А');
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

describe('«Было/стало»: роль снимка постановщика', () => {
  it('слова «образец»: пример, макет, как должно, по аналогии — да; «например» и стрелки — нет', () => {
    for (const t of ['Пример отчёта', 'образец страницы', 'макет', 'как должно выглядеть', 'Так должно быть', 'по аналогии с главной', 'референс', 'для примера']) {
      expect([t, saysExample(t)]).toEqual([t, true]);
    }
    for (const t of ['например, заголовок', 'стрелкой показал, где поправить', 'было так', '', null]) {
      expect([t, saysExample(t)]).toEqual([t, false]);
    }
  });

  it('описание называет вложения образцом — только когда в одной фразе и «образец», и «скрин/вложение»', () => {
    expect(descriptionCallsExample('Сделать отчёт. Образец отчёта — на скринах во вложении.')).toBe(true);
    expect(descriptionCallsExample('Скрины ниже — для примера, как должно получиться')).toBe(true);
    expect(descriptionCallsExample('Сделать по образцу. Скрин ошибки во вложении.')).toBe(false);
    expect(descriptionCallsExample('Поменять подзаголовок, скрин во вложении')).toBe(false);
  });

  it('текст рядом с картинкой описания: подряд идущие картинки делят подпись', () => {
    const html = '<p>Образец отчёта:</p><img data-file-id="1"><img data-file-id="2"><p>Поменять заголовок</p><img data-file-id="3">';
    const ctx = descriptionImageContext(html);
    expect(ctx.get('1')).toBe('Образец отчёта:');
    expect(ctx.get('2')).toBe('Образец отчёта: Поменять заголовок');
    expect(ctx.get('3')).toBe('Поменять заголовок');
    expect(ruleRole({ context: ctx.get('1') })).toBe('example');
    expect(ruleRole({ context: ctx.get('3') })).toBe('before');
  });

  it('по умолчанию — «было», как раньше; общая фраза описания делает образцом снимок без подписи', () => {
    expect(ruleRole({ context: null })).toBe('before');
    expect(ruleRole({ context: 'вот тут поправить', descriptionCallsExample: false })).toBe('before');
    expect(ruleRole({ context: null, descriptionCallsExample: true })).toBe('example');
  });

  it('роль руками главнее всего; результат исполнителя без ручной правки — «стало»', () => {
    expect(initialRole('before', 'after', 'before')).toEqual({ role: 'after', by: 'manual' });
    expect(initialRole('after', 'none', 'before')).toEqual({ role: 'none', by: 'manual' });
    expect(initialRole('after', null, 'example')).toEqual({ role: 'after', by: 'rule' });
    expect(initialRole('before', null, 'example')).toEqual({ role: 'example', by: 'rule' });
    expect(initialRole('before', undefined, 'before')).toEqual({ role: 'before', by: 'rule' });
  });
});

describe('«Было/стало»: правка вида или приёмка функции', () => {
  it('правки текста и вида узнаём, критерии приёмки — нет', () => {
    for (const t of ['Подзаголовок блока «Возможности»', 'Заменить «А» на «Б»', 'Иконка карточки «Задача из сообщения»', 'Поправить отступы в шапке', 'Убрать кнопку «Скачать»']) {
      expect([t, looksVisual(t)]).toEqual([t, true]);
    }
    for (const t of ['Открыть завершённую задачу и запустить проверку', 'Убедиться, что формируется отчёт с блоками «Было» и «Стало»',
      'Проверить итог: «Посмотрите, мы проверили и нашли/не нашли ошибки»', 'Принять/отклонить работу', 'Экспорт в CSV работает']) {
      expect([t, looksVisual(t)]).toEqual([t, false]);
    }
  });

  it('есть снимки «было» — визуальные правки; нет и пункты не похожи на правки — приёмка функции', () => {
    expect(kindByRules([{ title: 'Убедиться, что отчёт строится' }], 1)).toBe('visual');
    expect(kindByRules([{ title: 'Убедиться, что отчёт строится' }, { title: 'Принять работу' }], 0)).toBe('functional');
    expect(kindByRules([{ title: 'Убедиться, что отчёт строится' }, { title: 'Иконка карточки' }], 0)).toBe('visual');
  });
});

describe('«Было/стало»: автозапуск после сдачи', () => {
  const x = [{}];
  it('нужен результат: снимок «стало» или отчёт исполнителя при снимках «было»; образцы — не в счёт', () => {
    expect(autoWorthy({ before: [], after: x, afterMessages: [], afterDocs: [] })).toBe(true);
    expect(autoWorthy({ before: x, after: [], afterMessages: x, afterDocs: [] })).toBe(true);
    expect(autoWorthy({ before: x, after: [], afterMessages: [], afterDocs: x })).toBe(true);
    // одни снимки постановщика без слова исполнителя — проверять нечего
    expect(autoWorthy({ before: x, after: [], afterMessages: [], afterDocs: [] })).toBe(false);
    // образцы в before не попадают — и без картинок «было» задача проверяется кнопкой
    expect(autoWorthy({ before: [], after: [], afterMessages: x, afterDocs: [] })).toBe(false);
  });
});

/**
 * Случай с прода (#4657, отчёт 3): постановщик приложил три скрина — макет желаемого
 * отчёта «QEVO — правки на сайте: до и после», — а пункты взяты из чек-листа и это
 * критерии приёмки функции. Исполнитель ничего не приложил и не написал. Прежний код
 * положил скрины в «Было» пункта 2, поставил всем «без результата» и написал «нашли
 * ошибки», перебив модель, которая сочла пункт 2 подтверждённым.
 */
describe('#4657: три скрина-образца и четыре пункта приёмки', () => {
  const titles = [
    'Открыть завершённую задачу и запустить проверку «было/стало»',
    'Убедиться, что формируется отчёт с блоками «Было» и «Стало» по каждому пункту',
    'Проверить итог: «Посмотрите, мы проверили и нашли/не нашли ошибки»',
    'Принять или отклонить работу из отчёта',
  ];
  const items = titles.map((title) => ({ title }));
  const shots = ['1226', '1227', '1228'].map((id) => shot(id, { by: 'Константин', name: `4657_${id}.png` }));
  const nothing = { hasAfterShots: false, hasAfterOther: false };

  it('без модели и без подписей: итог — «результат не приложен», без слова «ошибки», сам не запускается', () => {
    const roles = shots.map(() => ruleRole({ context: null }));
    expect(roles).toEqual(['before', 'before', 'before']);
    const verdicts = items.map(() => settleVerdict({ model: null, hasModel: false, modelSees: false, ...nothing, kind: kindByRules(items, 3) }));
    expect(verdicts.every((v) => v.verdict === 'no_result')).toBe(true);
    const s = summarize(verdicts);
    const msg = resultMessage(s, 'eyes', kindByRules(items, 3));
    expect(msg).toBe('Исполнитель пока не приложил результат — проверять нечего.');
    expect(msg).not.toMatch(/ошибк/);
    expect(hasProblems(s)).toBe(false);
    expect(autoWorthy({ before: shots, after: [], afterMessages: [], afterDocs: [] })).toBe(false);
  });

  it('описание называет скрины образцом — правила кладут их в образцы, задача — приёмка функции', () => {
    const roles = shots.map(() => ruleRole({ context: null, descriptionCallsExample: descriptionCallsExample('Образец отчёта — на скринах во вложении.') }));
    expect(roles).toEqual(['example', 'example', 'example']);
    expect(kindByRules(items, 0)).toBe('functional');
  });

  it('модель: снимки — образец, задача — приёмка; её «пункт 2 подтверждён» — «стоит посмотреть», а не «без результата»', () => {
    const answer = JSON.stringify({
      kind: 'functional',
      shot_roles: [{ shot: 1, role: 'example' }, { shot: 2, role: 'example' }, { shot: 3, role: 'example' }],
      items: [
        { n: 1, verdict: 'unclear', reason: 'Нет подтверждения запуска.' },
        { n: 2, verdict: 'fixed', reason: 'На снимках сформирован графический отчёт с блоками «Было/Стало».' },
        { n: 3, verdict: 'unclear', reason: 'Итоговой фразы не видно.' },
        { n: 4, verdict: 'unclear', reason: 'Кнопок не видно.' },
      ],
      summary: 'Сформирован сам графический отчёт (пункт 2 подтверждён).',
    });
    const parsed = parseCheck(answer, 4, 3, () => true)!;
    expect(parsed.kind).toBe('functional');
    expect(parsed.roles.map((r) => r.role)).toEqual(['example', 'example', 'example']);

    const verdicts = items.map((_, i) => settleVerdict({
      model: parsed.items.find((m) => m.n === i + 1) ?? null, hasModel: true, modelSees: true, ...nothing, kind: parsed.kind!,
    }));
    expect(verdicts.map((v) => v.verdict)).toEqual(['no_result', 'unclear', 'no_result', 'no_result']);
    expect(verdicts[1].reason).toMatch(/ИИ считает, что пункт выполнен/);
    const s = summarize(verdicts);
    const msg = resultMessage(s, 'ai', 'functional');
    expect(msg).toBe('Посмотрите, что получилось: 3 без результата, 1 стоит посмотреть.');
    expect(msg).not.toMatch(/ошибк/);
    expect(headline(s, 'functional')).toBe('Чек-лист приёмки, 4 пункта: 3 без результата, 1 стоит посмотреть');
  });

  it('исполнитель отписался словами — в приёмке это «стало», скринов не требуем', () => {
    const m = { n: 1, verdict: 'fixed' as const, reason: 'Исполнитель пишет, что запустил проверку на задаче #12.', from: null, to: null, beforeShots: [], afterShots: [] };
    expect(settleVerdict({ model: m, hasModel: true, modelSees: true, hasAfterShots: false, hasAfterOther: true, kind: 'functional' }).verdict).toBe('fixed');
    expect(resultMessage(summarize([{ verdict: 'fixed' }, { verdict: 'fixed' }, { verdict: 'fixed' }, { verdict: 'fixed' }]), 'ai', 'functional'))
      .toBe('Посмотрите, мы проверили: 4 из 4 пунктов подтверждены отчётом исполнителя.');
  });
});
