import {
  askStems, askWhom, composeAnswer, createLabel, extractAssignments, Facts, isAssignment, isContextQuestion, itemsFromModel,
  leadingAddress, linksIn, mergeWithRules, missingOf, pickSimilar, questionKind, remindTargets, replyText, similarity,
  sourcedModelLines, splitAssignments,
} from './chat-actions.rules';

const users = [
  { id: '1', name: 'Борис Честнов' },
  { id: '2', name: 'Глеб Иванов' },
  { id: '3', name: 'Сергей Попович' },
  { id: '4', name: 'Алексей Смирнов' },
];
// среда, 11.11.2026
const now = new Date(2026, 10, 11, 10, 0, 0);
const ctx = { users, now, authorId: '1' };

describe('п. 7: поручения в сообщении', () => {
  it('находит все поручения: кому, что, срок', () => {
    const items = extractAssignments('Глеб, обнови логотип на сайте к пятнице. Сергей — подготовь презентацию для клиента до 20 ноября.', ctx);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ assigneeId: '2', deadline: '2026-11-13' });
    expect(items[0].title).toMatch(/^Обнови логотип на сайте/);
    expect(items[1]).toMatchObject({ assigneeId: '3', deadline: '2026-11-20' });
    expect(items[1].title).toMatch(/презентацию/);
  });

  it('нумерованный список под шапкой: исполнитель и срок шапки достаются пунктам', () => {
    const items = extractAssignments('Глеб, к пятнице:\n1. сделать баннер\n2. обновить страницу тарифов', ctx);
    expect(items.map((i) => i.assigneeId)).toEqual(['2', '2']);
    expect(items.map((i) => i.deadline)).toEqual(['2026-11-13', '2026-11-13']);
  });

  it('@упоминание с фамилией — обращение, а не название', () => {
    const a = leadingAddress('@Глеб Иванов, проверь форму оплаты', users);
    expect(a.userId).toBe('2');
    expect(a.rest).toBe('проверь форму оплаты');
    const items = extractAssignments('@Глеб Иванов проверь форму оплаты завтра', ctx);
    expect(items[0]).toMatchObject({ assigneeId: '2', deadline: '2026-11-12' });
    expect(items[0].title).toMatch(/^Проверь форму оплаты/);
  });

  it('не хватает исполнителя — подсвечивается; личка — адресат', () => {
    const [one] = extractAssignments('Нужно обновить документацию по API', ctx);
    expect(missingOf(one)).toEqual(['assignee', 'deadline']);
    const [dm] = extractAssignments('Нужно обновить документацию по API', { ...ctx, dmPeerId: '3' });
    expect(dm.assigneeId).toBe('3');
    const [mention] = extractAssignments('Нужно обновить документацию по API', { ...ctx, mentionIds: ['4'] });
    expect(mention.assigneeId).toBe('4');
  });

  it('«сделаю сам» — исполнитель автор', () => {
    const [x] = extractAssignments('Сделаю сам отчёт за неделю к понедельнику', ctx);
    expect(x.assigneeId).toBe('1');
    expect(x.deadline).toBe('2026-11-16');
  });

  it('обычная болтовня — не поручения', () => {
    for (const t of ['Привет всем!', 'Спасибо, отлично получилось', 'Вчера решили, что запускаем позже', 'Новости хорошие', 'Алексей молодец']) {
      expect(extractAssignments(t, ctx)).toEqual([]);
    }
    expect(isAssignment('Можешь подготовить смету?', users, now)).toBe(true);
    // вопрос об ответственности — не поручение (это п. 8)
    expect(extractAssignments('Видео я должен был создавать? Чёт я не в материале', ctx)).toEqual([]);
  });

  it('деление на предложения и строки', () => {
    expect(splitAssignments('Первое. Второе предложение\nтретья строка')).toEqual(['Первое.', 'Второе предложение', 'третья строка']);
  });

  it('ответ модели: исполнитель только из команды, срок только будущий', () => {
    const m = itemsFromModel({ tasks: [
      { title: 'обновить логотип', assignee: 'Глебу', deadline: '2026-11-13', quote: 'Глеб, обнови логотип' },
      { title: 'созвон с подрядчиком', assignee: 'дизайнер', deadline: '2020-01-01', quote: 'созвонись завтра' },
    ] }, ctx)!;
    expect(m[0]).toMatchObject({ title: 'Обновить логотип', assigneeId: '2', deadline: '2026-11-13' });
    expect(m[1]).toMatchObject({ assigneeId: null, assigneeHint: 'дизайнер', deadline: '2026-11-12' });
    expect(itemsFromModel('мусор', ctx)).toBeNull();
    const merged = mergeWithRules([{ ...m[1], key: '1', assigneeHint: null }], [], { ...ctx, mentionIds: ['3'] });
    expect(merged[0].assigneeId).toBe('3');
  });
});

describe('похожие задачи и подпись кнопки', () => {
  it('сходство по основам слов', () => {
    expect(similarity('Обновить логотип на сайте', 'обновление логотипа сайта')).toBeGreaterThanOrEqual(0.8);
    expect(similarity('Обновить логотип', 'Собрать отчёт по продажам')).toBe(0);
  });

  it('берёт не больше двух, сначала открытые', () => {
    const s = pickSimilar('Обновить логотип на сайте', [
      { id: '10', title: 'Логотип на сайте — обновить', projectId: '1', status: 'Готово', closed: true },
      { id: '11', title: 'Обновить логотип сайта', projectId: '1', status: 'В работе', closed: false },
      { id: '12', title: 'Счёт клиенту', projectId: '1', status: null, closed: false },
    ]);
    expect(s.map((x) => x.id)).toEqual(['11', '10']);
  });

  it('подпись: создать/связать/всё создано', () => {
    expect(createLabel([{}, {}, {}])).toBe('Создать 3');
    expect(createLabel([{}, { linkTaskId: '5' }, { skip: true }])).toBe('Создать 1 и связать 1');
    expect(createLabel([{ taskId: '1' }])).toBe('Всё создано');
  });
});

describe('п. 8: «Кто за это отвечает?»', () => {
  it('вид вопроса', () => {
    expect(questionKind('Видео я должен был создавать? Чёт я не в материале')).toBe('me');
    expect(questionKind('Кто делает лендинг?')).toBe('who');
    expect(questionKind('Где лежит файл с макетом?')).toBe('where');
    expect(questionKind('а где ТЗ на интеграцию')).toBe('where');
    expect(questionKind('Когда будет готов релиз?')).toBe('when');
    expect(questionKind('Отличная работа')).toBe('general');
    expect(isContextQuestion('кто за это отвечает?')).toBe(true);
  });

  it('предметные слова вопроса', () => {
    expect(askStems('Видео я должен был создавать? Чёт я не в материале')).toEqual(['виде']);
    expect(askStems('Где ТЗ на интеграцию?')).toEqual(['тз', 'интег']);
  });

  const facts: Facts = {
    tasks: [
      { id: '4864', title: 'Промо-видео', projectId: '7', projectName: 'Сайт', assigneeId: '2', assignee: 'Глеб Иванов', authorId: '1', author: 'Борис Честнов', status: 'В работе', deadline: '2026-11-20', closed: false, files: [], links: ['https://example.com/brief'], score: 3 },
    ],
    meetings: [
      { id: '55', title: 'Планёрка', at: '2026-11-10T09:00:00Z', what: 'draft', text: 'смонтировать видео', assigneeId: '3', assignee: 'Сергей Попович', taskId: null },
    ],
    files: [],
  };

  it('у каждой строки правил — источник', () => {
    const me = composeAnswer('me', facts, '3');
    expect(me[0].text).toMatch(/исполнитель — Глеб Иванов, не вы/);
    expect(me.every((l) => l.sources.length > 0)).toBe(true);
    expect(composeAnswer('me', facts, '2')[0].text).toMatch(/^Да, это на вас: задача #4864/);
    expect(composeAnswer('where', facts, '3')[0].text).toMatch(/https:\/\/example.com\/brief/);
    expect(composeAnswer('who', { tasks: [], meetings: [], files: [] }, '3')).toEqual([]);
  });

  it('строки модели без настоящего источника выбрасываются', () => {
    const lines = sourcedModelLines({ lines: [
      { text: 'Видео делает Глеб', sources: ['t4864'] },
      { text: 'Сроки сдвинули', sources: ['t999'] },
      { text: 'Без источника', sources: [] },
      { text: 'Монтаж поручили Сергею', sources: ['M55', 't4864'] },
    ] }, facts);
    expect(lines.map((l) => l.text)).toEqual(['Видео делает Глеб', 'Монтаж поручили Сергею']);
    expect(lines[1].sources.map((s) => s.kind)).toEqual(['meeting', 'task']);
  });

  it('кому напомнить и кого спросить', () => {
    expect(remindTargets(facts, '1').map((p) => p.userId)).toEqual(['2', '3']);
    expect(remindTargets(facts, '2').map((p) => p.userId)).toEqual(['3']);
    expect(askWhom(facts, '3', null)).toMatchObject({ userId: '1', taskId: '4864' });
    expect(askWhom({ tasks: [], meetings: [], files: [] }, '3', { id: '2', name: 'Глеб' })).toMatchObject({ userId: '2', taskId: null });
    expect(askWhom({ tasks: [], meetings: [], files: [] }, '3', { id: '3', name: 'Я' })).toBeNull();
  });

  it('ответ в чат — с источниками', () => {
    const t = replyText([{ text: 'Видео делает Глеб.', sources: [{ kind: 'task', id: '4864', title: 'Промо-видео' }] }]);
    expect(t).toBe('Видео делает Глеб. (источник: #4864)');
    expect(linksIn('см. https://a.ru/x и https://a.ru/x')).toEqual(['https://a.ru/x']);
  });
});
