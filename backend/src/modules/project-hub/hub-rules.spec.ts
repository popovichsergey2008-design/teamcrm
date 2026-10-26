import {
  addedLabel, addedTotal, buildCandidates, classifyFile, classifyUrl, extractUrls, isJunkFile, isJunkUrl,
  normalizeUrl, parseJsonLoose, phoneInText, placeByRules, telegramInText, validateModelAnswer, validCategory,
} from './hub-rules';

describe('Инфоцентр: ссылки', () => {
  it('достаёт ссылки из текста без хвостовой пунктуации и повторов', () => {
    expect(extractUrls('Макет: https://www.figma.com/file/AbC/Landing-v2?node-id=1, и ещё (https://github.com/org/app).'))
      .toEqual(['https://www.figma.com/file/AbC/Landing-v2?node-id=1', 'https://github.com/org/app']);
    expect(extractUrls('см. www.example.ru/page и www.example.ru/page')).toEqual(['www.example.ru/page']);
    expect(extractUrls(null)).toEqual([]);
  });

  it('нормальный вид: https, без www, меток рекламы, якоря и косой черты в конце', () => {
    expect(normalizeUrl('http://WWW.Figma.com/file/AbC/Landing/?utm_source=tg#x')).toBe('https://figma.com/file/AbC/Landing');
    expect(normalizeUrl('www.site.ru')).toBe('https://site.ru');
    expect(normalizeUrl('https://site.ru/a?b=1&utm_medium=x')).toBe('https://site.ru/a?b=1');
    expect(normalizeUrl('ftp://site.ru')).toBeNull();
    expect(normalizeUrl('https://localhost')).toBeNull();
    expect(normalizeUrl('просто текст')).toBeNull();
  });

  it('мусор: своя система, созвоны, сокращатели, картинки, IP', () => {
    expect(isJunkUrl('https://qevo.one/projects/3')).toBe(true);
    expect(isJunkUrl('https://app.anthill.team/x')).toBe(true);
    expect(isJunkUrl('https://crm.example.com/x', { appHost: 'crm.example.com' })).toBe(true);
    expect(isJunkUrl('https://meet.google.com/abc-defg-hij')).toBe(true);
    expect(isJunkUrl('https://us02web.zoom.us/j/123')).toBe(true);
    expect(isJunkUrl('https://bit.ly/3abc')).toBe(true);
    expect(isJunkUrl('https://cdn.site.ru/shot.PNG')).toBe(true);
    expect(isJunkUrl('https://10.0.0.1/admin')).toBe(true);
    expect(isJunkUrl('https://github.com/org/app')).toBe(false);
  });

  it('домены → раздел и категория', () => {
    expect(classifyUrl('https://www.figma.com/file/AbC123/Landing-v2?node-id=1')).toEqual({ section: 'knowledge', category: 'design', title: 'Макет Figma: Landing v2' });
    expect(classifyUrl('https://figma.com/design/AbC123')?.category).toBe('design');
    expect(classifyUrl('https://github.com/org/app/pull/5')).toEqual({ section: 'knowledge', category: 'repo', title: 'Репозиторий org/app' });
    expect(classifyUrl('https://gitlab.company.ru/team/api')?.category).toBe('repo');
    expect(classifyUrl('https://api.site.ru/swagger/index.html')?.category).toBe('api');
    expect(classifyUrl('https://site.ru/api-docs')?.category).toBe('api');
    expect(classifyUrl('https://docs.google.com/document/d/1x/edit')).toEqual({ section: 'knowledge', category: 'doc', title: 'Документ Google' });
    expect(classifyUrl('https://docs.google.com/spreadsheets/d/1x')?.title).toBe('Таблица Google');
    expect(classifyUrl('https://www.notion.so/team/Brief-0123456789abcdef0123456789abcdef')?.title).toBe('Notion: Brief');
    expect(classifyUrl('https://t.me/qevo_news')).toEqual({ section: 'passport', category: 'social', title: 'Telegram @qevo_news' });
    expect(classifyUrl('https://t.me/QevoHelpBot')).toEqual({ section: 'passport', category: 'bot', title: 'Бот @QevoHelpBot' });
    expect(classifyUrl('https://t.me/+AbCdEf')).toBeNull(); // приглашение в группу
    expect(classifyUrl('https://vk.com/qevo')).toEqual({ section: 'passport', category: 'social', title: 'ВКонтакте' });
    expect(classifyUrl('https://www.youtube.com/@qevo')?.category).toBe('social');
    expect(classifyUrl('https://www.youtube.com/watch?v=1')).toBeNull(); // ролик — не канал
    expect(classifyUrl('https://example.com/blog/post')).toBeNull(); // правила не знают — решит модель
    expect(classifyUrl('https://qevo.one/x')).toBeNull();
  });

  it('свой домен проекта: админка и приложение — в паспорт, страницы сайта — нет', () => {
    const ctx = { projectDomains: ['shop.ru'] };
    expect(classifyUrl('https://admin.shop.ru', ctx)).toEqual({ section: 'passport', category: 'admin', title: 'Админка admin.shop.ru' });
    expect(classifyUrl('https://shop.ru/wp-admin/', ctx)?.category).toBe('admin');
    expect(classifyUrl('https://app.shop.ru/login', ctx)?.category).toBe('app');
    expect(classifyUrl('https://shop.ru/catalog', ctx)).toBeNull();
  });
});

describe('Инфоцентр: файлы', () => {
  it('по имени и типу', () => {
    expect(classifyFile('ТЗ_лендинг_v2.pdf', 'application/pdf')).toEqual({ section: 'knowledge', category: 'spec', title: 'ТЗ лендинг v2' });
    expect(classifyFile('Бриф клиента.docx', null)?.category).toBe('spec');
    expect(classifyFile('product-spec.md', null)?.category).toBe('spec');
    expect(classifyFile('Брендбук 2026.pdf', null)?.category).toBe('brand');
    expect(classifyFile('logo.svg', 'image/svg+xml')?.category).toBe('brand');
    expect(classifyFile('Inter-Bold.ttf', null)).toEqual({ section: 'knowledge', category: 'brand', title: 'Шрифт: Inter-Bold' });
    expect(classifyFile('Регламент выгрузки отчётов.pdf', null)?.category).toBe('regulation');
    expect(classifyFile('Инструкция.docx', null)?.category).toBe('regulation');
    expect(classifyFile('main.fig', null)?.category).toBe('design');
  });

  it('границы слова: «логов» — не логотип, «тзадачи» — не ТЗ', () => {
    expect(classifyFile('выгрузка логов.txt', 'text/plain')).toBeNull();
    expect(classifyFile('счёт.pdf', 'application/pdf')).toBeNull();
    expect(classifyFile('фото.jpg', 'image/jpeg', 'новый логотип')?.category).toBe('brand'); // подпись помогает
  });

  it('скриншоты и фото без подписи — мусор, с подписью — кандидат для модели', () => {
    expect(isJunkFile('Screenshot 2026-10-25 at 10.00.00.png', 'image/png')).toBe(true);
    expect(isJunkFile('IMG_1234.jpg', 'image/jpeg', '')).toBe(true);
    expect(isJunkFile('макет.png', 'image/png', '')).toBe(true);
    expect(isJunkFile('макет.png', 'image/png', 'вариант главной для заказчика')).toBe(false);
    expect(isJunkFile('logo.png', 'image/png', '')).toBe(false);
    expect(isJunkFile('отчёт.pdf', 'application/pdf', '')).toBe(false);
  });
});

describe('Инфоцентр: кандидаты и повторы', () => {
  const origin = { type: 'chat_message' as const, id: '1', chatId: '5' };

  it('повторы в сутках схлопываются, уже лежащее — пропускается, мусор — отсекается', () => {
    const c = buildCandidates([
      { text: 'Макет https://figma.com/file/A/Main и https://qevo.one/x', origin },
      { text: 'ещё раз http://www.figma.com/file/A/Main/?utm_source=tg', origin: { ...origin, id: '2' } },
      { text: 'репо https://github.com/org/app', origin: { ...origin, id: '3' } },
      { text: '', files: [{ id: '10', name: 'Screenshot 1.png', contentType: 'image/png' }, { id: '11', name: 'ТЗ.pdf', contentType: 'application/pdf' }], origin },
      { text: 'тот же файл', files: [{ id: '11', name: 'ТЗ.pdf', contentType: 'application/pdf' }], origin },
    ], { urls: new Set(['https://github.com/org/app']), fileIds: new Set() });
    expect(c.map((x) => x.url ?? x.fileName)).toEqual(['https://figma.com/file/A/Main', 'ТЗ.pdf']);
    expect(c.map((x) => x.ref)).toEqual(['c1', 'c2']);
    expect(c[0].origin.id).toBe('1'); // первое упоминание
  });

  it('убранный человеком файл не возвращается', () => {
    const c = buildCandidates([{ text: '', files: [{ id: '11', name: 'ТЗ.pdf', contentType: null }], origin }],
      { urls: new Set(), fileIds: new Set(['11']) });
    expect(c).toEqual([]);
  });

  it('правила раскладывают известное, остальное — модели', () => {
    const c = buildCandidates([{ text: 'https://figma.com/file/A/Main https://example.com/article', origin }], { urls: new Set(), fileIds: new Set() });
    const { placed, rest } = placeByRules(c);
    expect(placed.get('c1')?.category).toBe('design');
    expect(rest.map((x) => x.url)).toEqual(['https://example.com/article']);
  });

  it('итог прогона и подпись бейджа', () => {
    expect(addedTotal({ links: 1, decisions: 2 })).toBe(3);
    expect(addedTotal(null)).toBe(0);
    expect(addedLabel({ decisions: 2, links: 1 })).toBe('+2 решения, +1 ссылка');
    expect(addedLabel({ files: 5, contacts: 1, notes: 21 })).toBe('+5 файлов, +1 контакт, +21 заметка');
  });

  it('категории по разделам', () => {
    expect(validCategory('knowledge', 'design')).toBe(true);
    expect(validCategory('passport', 'design')).toBe(false);
    expect(validCategory('team', null)).toBe(true);
  });
});

describe('Инфоцентр: проверка ответа модели', () => {
  const sources = new Map([
    ['s1', 'Созвон: утвердили подрядчика Иван Петров, студия «Пиксель», телефон +7 (999) 123-45-67, почта ivan@pixel.ru'],
    ['s2', 'Сообщение: заказчик просит сдвинуть запуск на декабрь'],
  ]);
  const refs = new Set(['c2', 'c3']);

  it('ссылки только на кандидатов, разделы и категории из списка', () => {
    const a = validateModelAnswer({
      items: [
        { ref: 'c2', section: 'knowledge', category: 'doc', title: 'Статья о конкурентах' },
        { ref: 'c9', section: 'knowledge', category: 'doc', title: 'выдуманный' },
        { ref: 'c3', section: 'knowledge', category: 'social', title: 'не та категория' },
        { ref: 'c2', section: 'knowledge', category: 'doc', title: 'повтор' },
        { ref: 'c3', section: 'team', category: 'other', title: 'команда только контактами' },
      ],
    }, { refs }, sources);
    expect(a.items).toEqual([{ ref: 'c2', section: 'knowledge', category: 'doc', title: 'Статья о конкурентах' }]);
  });

  it('контакты: имя из текста, телефон и почта — только если буквально есть', () => {
    const a = validateModelAnswer({
      contacts: [
        { name: 'Иван Петров', role: 'подрядчик, дизайн', phone: '89991234567', email: 'IVAN@pixel.ru', telegram: '@ivan_pixel', ref: 's1' },
        { name: 'Мария Сидорова', role: 'бухгалтер', phone: '+79990000000', ref: 's1' },
        { name: 'Иван Петров', ref: 's1' },
        { name: 'Кто-то', ref: 's7' },
      ],
    }, { refs }, sources);
    expect(a.contacts).toEqual([{
      name: 'Иван Петров', role: 'подрядчик, дизайн', ref: 's1', phone: '89991234567', email: 'ivan@pixel.ru', telegram: null,
    }]);
  });

  it('заметки — только с источником и не пустые', () => {
    const a = validateModelAnswer({ notes: [{ text: 'Запуск переносится на декабрь по просьбе заказчика', ref: 's2' }, { text: 'коротко', ref: 's2' }, { text: 'Без источника, но длинно', ref: 'x' }] }, { refs }, sources);
    expect(a.notes).toEqual([{ text: 'Запуск переносится на декабрь по просьбе заказчика', ref: 's2' }]);
  });

  it('мусор вместо JSON — пустой ответ, JSON в обёртке — читается', () => {
    expect(validateModelAnswer(parseJsonLoose('не знаю'), { refs }, sources)).toEqual({ items: [], contacts: [], notes: [] });
    expect(parseJsonLoose('```json\n{"items":[]}\n```')).toEqual({ items: [] });
    expect(validateModelAnswer(null, { refs }, sources).items).toEqual([]);
  });

  it('телефон и telegram сверяются по сути, а не по написанию', () => {
    expect(phoneInText('8 999 123 45 67', 'звоните +7 (999) 123-45-67')).toBe(true);
    expect(phoneInText('123', 'код 123')).toBe(false);
    expect(telegramInText('@ivan_pixel', 'пишите в t.me/ivan_pixel')).toBe(true);
    expect(telegramInText('ivan_pixel', 'пишите Ивану')).toBe(false);
  });
});
