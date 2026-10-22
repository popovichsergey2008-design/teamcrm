import { commitmentCardText, detectCommitment, looksCancelled, looksFulfilled, parseDeadline, similarity } from './commitment-rules';

const MON = { date: '2026-10-12', hour: 11, minute: 0, isoDow: 1 };

describe('обещания: распознавание', () => {
  it('«Я отправлю смету сегодня» — обещание со сроком', () => {
    const d = detectCommitment('Я отправлю смету сегодня', MON);
    expect(d?.action).toBe('отправлю смету сегодня');
    expect(d?.deadline).toEqual({ kind: 'local', date: '2026-10-12', time: '18:00', text: 'сегодня' });
    expect(d!.confidence).toBeGreaterThanOrEqual(0.85);
  });
  it('«Проверю завтра», «Сделаю до пятницы», «Беру»', () => {
    expect(detectCommitment('Ок, проверю завтра', MON)?.deadline).toMatchObject({ date: '2026-10-13' });
    expect(detectCommitment('Сделаю до пятницы', MON)?.deadline).toMatchObject({ date: '2026-10-16' });
    expect(detectCommitment('Беру на себя договор с банком', MON)?.action).toContain('договор с банком');
  });
  it('не обещание: вопрос, условие, отрицание, «попробую», цитата', () => {
    expect(detectCommitment('Пришлю смету сегодня?', MON)).toBeNull();
    expect(detectCommitment('Если успею, пришлю смету', MON)).toBeNull();
    expect(detectCommitment('Не сделаю до пятницы, извини', MON)).toBeNull();
    expect(detectCommitment('Попробую прислать завтра', MON)).toBeNull();
    expect(detectCommitment('> я пришлю смету сегодня\nспасибо', MON)).toBeNull();
    expect(detectCommitment('Он пришлёт смету', MON)).toBeNull();
  });
  it('срок: время, «через 2 дня», дата', () => {
    expect(parseDeadline('пришлю к 15:30', MON)).toEqual({ kind: 'local', date: '2026-10-12', time: '15:30', text: 'к 15:30' });
    expect(parseDeadline('пришлю к 9:00', MON)).toMatchObject({ date: '2026-10-13' }); // уже прошло — завтра
    expect(parseDeadline('сделаю через 2 дня', MON)).toEqual({ kind: 'relative', minutes: 2880, text: 'через 2 дня' });
    expect(parseDeadline('сдам до 15.10', MON)).toMatchObject({ date: '2026-10-15' });
    expect(parseDeadline('пришлю 3 ноября', MON)).toMatchObject({ date: '2026-11-03' });
    expect(parseDeadline('пришлю', MON)).toBeNull();
  });
});

describe('обещания: выполнение и отмена', () => {
  it('файл, ссылка, «отправил», «готово»', () => {
    expect(looksFulfilled({ body: '', hasFile: true })).toBe(true);
    expect(looksFulfilled({ body: 'держи https://docs.example.com/x', hasFile: false })).toBe(true);
    expect(looksFulfilled({ body: 'Отправил на почту', hasFile: false })).toBe(true);
    expect(looksFulfilled({ body: 'завтра посмотрю', hasFile: false })).toBe(false);
  });
  it('отмена', () => {
    expect(looksCancelled('Уже не нужно, спасибо')).toBe(true);
    expect(looksCancelled('нужно до пятницы')).toBe(false);
  });
  it('похожесть действия и задачи', () => {
    expect(similarity('отправлю смету для банка', 'Смета для банка')).toBeGreaterThanOrEqual(0.5);
    expect(similarity('проверю договор', 'Верстка лендинга')).toBe(0);
  });
});

describe('обещания: ответ в чате (#1525)', () => {
  it('ответ обещавшего на сообщение с обещанием — выполнено', () => {
    expect(looksFulfilled({ body: 'по смете — вечером созвонимся', hasFile: false, repliesToPromise: true })).toBe(true);
    expect(looksFulfilled({ body: 'по смете — вечером созвонимся', hasFile: false, repliesToPromise: false })).toBe(false);
  });
});

describe('обещания: текст карточки дословно по документу (#1525)', () => {
  const base = { sourceType: 'meeting' as const, saidWhen: 'во вторник', overdueText: null, hoursPassed: 24.03 };
  it('руководителю: «Глеб на созвоне во вторник обещал прислать смету…»', () => {
    const t = commitmentCardText({ ...base, self: false, speakerFullName: 'Глеб Иванов', action: 'скину смету' });
    expect(t.text).toBe('Глеб на созвоне во вторник обещал прислать смету. Прошло 24 часа. Создать задачу в проект или напомнить Глебу в 1 клик?');
    expect(t.remindLabel).toBe('Напомнить Глебу');
  });
  it('обещавшему — о нём самом', () => {
    const t = commitmentCardText({ ...base, self: true, speakerFullName: 'Глеб Иванов', action: 'скину смету' });
    expect(t.text).toBe('Вы на созвоне во вторник обещали прислать смету. Прошло 24 часа. Создать задачу в проект или напомнить себе в 1 клик?');
    expect(t.remindLabel).toBe('Напомнить мне завтра');
  });
  it('женское имя, чат, личка, задача, просроченный срок', () => {
    expect(commitmentCardText({ ...base, sourceType: 'chat', chatKind: 'group', self: false, speakerFullName: 'Анна Петрова', action: 'уточню у юриста' }).text)
      .toBe('Анна в чате во вторник обещала уточнить у юриста. Прошло 24 часа. Создать задачу в проект или напомнить Анне в 1 клик?');
    expect(commitmentCardText({ ...base, sourceType: 'chat', chatKind: 'dm', self: false, speakerFullName: 'Сергей', action: 'проверю', saidWhen: 'в среду' }).text)
      .toBe('Сергей в личной переписке в среду обещал проверить. Прошло 24 часа. Создать задачу в проект или напомнить Сергею в 1 клик?');
    expect(commitmentCardText({ ...base, sourceType: 'task', taskTitle: 'Лендинг', self: false, speakerFullName: 'Саша', action: 'сделаю макет завтра', overdueText: 'завтра' }).text)
      .toBe('Саша в комментарии к задаче «Лендинг» во вторник обещал(а) сделать макет завтра. Срок «завтра» прошёл. Создать задачу в проект или напомнить Саше в 1 клик?');
  });
  it('без глагола — цитатой', () => {
    expect(commitmentCardText({ ...base, self: false, speakerFullName: 'Глеб', action: 'за мной договор', hoursPassed: 21 }).text)
      .toBe('Глеб на созвоне во вторник обещал: «за мной договор». Прошёл 21 час. Создать задачу в проект или напомнить Глебу в 1 клик?');
  });
});
