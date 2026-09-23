import {
  digestItems,
  digestKey, digestText, greetingFor, humanHours, KindStats, localParts, mutedKinds, PingCandidate,
  pingKey, pingText, reactionRate, repeatDue, withinWorkHours, WorkHours,
} from './ping-rules';

const work: WorkHours = {
  workStart: '09:00',
  workEnd: '18:00',
  weekendDays: [0, 6],
  holidays: ['2026-01-01'],
};

// среда, 2026-08-26, 12:00 UTC
const noonUtc = new Date('2026-08-26T12:00:00Z');

const candidate = (p: Partial<PingCandidate> = {}): PingCandidate => ({
  kind: 'overdue', userId: '1', taskId: '10', subjectId: '10',
  title: 'Договор с подрядчиком', projectName: 'Стройка', hours: 30, timezone: 'Europe/Moscow', ...p,
});

describe('Смарт-пинги — правила', () => {
  it('местное время считается по поясу получателя, а не сервера', () => {
    expect(localParts(noonUtc, 'Europe/Moscow').hour).toBe(15);
    expect(localParts(noonUtc, 'Asia/Novosibirsk').hour).toBe(19);
    expect(localParts(noonUtc, 'Europe/Moscow').dow).toBe(3); // среда
  });

  it('неизвестный пояс не заставляет молчать — считаем по московскому', () => {
    expect(localParts(noonUtc, 'Marsia/Olympus').hour).toBe(15);
    expect(localParts(noonUtc, null).hour).toBe(15);
  });

  it('в рабочие часы пишем, ночью и в выходной — нет', () => {
    expect(withinWorkHours(noonUtc, 'Europe/Moscow', work)).toBe(true);
    // 03:00 по Москве
    expect(withinWorkHours(new Date('2026-08-26T00:00:00Z'), 'Europe/Moscow', work)).toBe(false);
    // тот же момент в Новосибирске — уже 07:00, до начала дня
    expect(withinWorkHours(new Date('2026-08-26T00:00:00Z'), 'Asia/Novosibirsk', work)).toBe(false);
    // суббота
    expect(withinWorkHours(new Date('2026-08-29T09:00:00Z'), 'Europe/Moscow', work)).toBe(false);
  });

  it('праздник — не рабочий день, даже если это будни', () => {
    // 1 января 2026 — четверг
    expect(withinWorkHours(new Date('2026-01-01T09:00:00Z'), 'Europe/Moscow', work)).toBe(false);
  });

  it('конец рабочего дня — граница закрытая: в 18:00 уже не пишем', () => {
    expect(withinWorkHours(new Date('2026-08-26T14:59:00Z'), 'Europe/Moscow', work)).toBe(true); // 17:59
    expect(withinWorkHours(new Date('2026-08-26T15:00:00Z'), 'Europe/Moscow', work)).toBe(false); // 18:00
  });

  it('половинки часа тоже считаются: день с 9:30 до 17:45', () => {
    const half = { ...work, workStart: '09:30', workEnd: '17:45' };
    expect(withinWorkHours(new Date('2026-08-26T06:15:00Z'), 'Europe/Moscow', half)).toBe(false); // 09:15
    expect(withinWorkHours(new Date('2026-08-26T06:45:00Z'), 'Europe/Moscow', half)).toBe(true); // 09:45
    expect(withinWorkHours(new Date('2026-08-26T14:50:00Z'), 'Europe/Moscow', half)).toBe(false); // 17:50
  });

  it('часы превращаются в человеческие сроки', () => {
    expect(humanHours(5)).toBe('5 ч');
    expect(humanHours(24)).toBe('1 день');
    expect(humanHours(50)).toBe('2 дня');
    expect(humanHours(130)).toBe('5 дней');
    expect(humanHours(264)).toBe('11 дней'); // «одиннадцать», а не «один»
  });

  it('текст называет задачу и говорит фактом', () => {
    expect(pingText(candidate())).toBe('Срок прошёл 1 день назад: «Договор с подрядчиком» (Стройка)');
    expect(pingText(candidate({ kind: 'due_soon', hours: 5 }))).toContain('Срок через 5 ч');
    expect(pingText(candidate({ kind: 'stuck_review', hours: 72 }))).toContain('Ждёт вашей проверки 3 дня');
    expect(pingText(candidate({ kind: 'silent', hours: 120 }))).toContain('Что со статусом?');
    // проект не назван — предложение всё равно остаётся целым
    expect(pingText(candidate({ projectName: null }))).toBe('Срок прошёл 1 день назад: «Договор с подрядчиком»');
  });

  it('повод живёт одной строкой: даты в ключе больше нет', () => {
    // С датой в ключе повод заводился заново каждое утро — отсюда и брались
    // 35 сообщений «срок прошёл» одному человеку за три дня.
    expect(pingKey(candidate())).toBe('overdue:10');
    expect(pingKey(candidate({ kind: 'silent' }))).toBe('silent:10');
  });

  it('оборванные нитки зовут по имени того, кто держит очередь', () => {
    expect(pingText(candidate({ kind: 'approval_stuck', title: 'Согласовать смету', hours: 30 })))
      .toBe('Ждёт вашего решения 1 день: «Согласовать смету»');
    expect(pingText(candidate({ kind: 'mention_silent', title: 'Кто возьмёт клиента?', hours: 26 })))
      .toContain('Вас позвали 1 день назад и ждут ответа');
  });

  it('в сводке чужое ожидание идёт раньше собственных молчащих задач', () => {
    const text = digestText([
      candidate({ kind: 'silent', title: 'Лендинг', subjectId: '12' }),
      candidate({ kind: 'approval_stuck', title: 'Смета', subjectId: 'a1' }),
      candidate({ kind: 'mention_silent', title: 'Вопрос в ленте', subjectId: 'm1' }),
    ]);
    expect(text.indexOf('Ждёт вашего решения')).toBeLessThan(text.indexOf('Вас позвали'));
    expect(text.indexOf('Вас позвали')).toBeLessThan(text.indexOf('Без движения'));
  });

  it('сводка — одна на человека в день, по его местным суткам', () => {
    expect(digestKey('7', noonUtc, 'Europe/Moscow')).toBe('digest:7:2026-08-26');
    // 23:30 по Москве и 00:30 следующего дня в Новосибирске — разные сутки у разных людей
    const late = new Date('2026-08-26T20:30:00Z');
    expect(digestKey('7', late, 'Europe/Moscow')).toBe('digest:7:2026-08-26');
    expect(digestKey('7', late, 'Asia/Novosibirsk')).toBe('digest:7:2026-08-27');
  });
});

describe('Затухающие повторы', () => {
  const at = (days: number) => new Date(noonUtc.getTime() + days * 86_400_000);

  it('о новом поводе говорим сразу', () => {
    expect(repeatDue(1, null, noonUtc)).toBe(true);
  });

  it('второй раз — через сутки, третий — через три дня, дальше реже', () => {
    expect(repeatDue(1, noonUtc, at(0.5))).toBe(false);
    expect(repeatDue(1, noonUtc, at(1))).toBe(true);
    expect(repeatDue(2, noonUtc, at(2))).toBe(false);
    expect(repeatDue(2, noonUtc, at(3))).toBe(true);
    expect(repeatDue(3, noonUtc, at(6))).toBe(false);
    expect(repeatDue(3, noonUtc, at(7))).toBe(true);
  });

  it('дальше пятого раза пауза не растёт бесконечно — две недели', () => {
    expect(repeatDue(9, noonUtc, at(13))).toBe(false);
    expect(repeatDue(9, noonUtc, at(14))).toBe(true);
  });
});

describe('Утренняя сводка', () => {
  it('собирается по срочности и не превращается в простыню', () => {
    const items = [
      candidate({ title: 'Договор' }),
      candidate({ kind: 'overdue', title: 'Смета', taskId: '11' }),
      candidate({ kind: 'silent', title: 'Лендинг', taskId: '12' }),
      candidate({ kind: 'stuck_review', title: 'Макеты', taskId: '13' }),
      candidate({ kind: 'overdue', title: 'Отчёт', taskId: '14' }),
      candidate({ kind: 'overdue', title: 'Прайс', taskId: '15' }),
    ];
    const text = digestText(items);

    expect(text.startsWith('Доброе утро! Коротко о делах:')).toBe(true);
    // просрочка первой строкой: то, что уже сорвано, важнее остального
    expect(text.indexOf('Просрочено (4)')).toBeLessThan(text.indexOf('Ждёт вашей проверки'));
    expect(text).toContain('и ещё 1'); // четыре задачи, перечислены три
    expect(text).toContain('Без движения (1): «Лендинг»');
    expect(text.split('\n').length).toBe(4); // приветствие + три группы
  });

  it('без поводов сводки нет вовсе: «у вас всё хорошо» — это тоже шум', () => {
    expect(digestText([])).toBe('');
  });
});

describe('Секретарь мерит себя откликом', () => {
  const stats = (p: Partial<KindStats> = {}): KindStats => ({ kind: 'overdue', sent: 0, acted: 0, ...p });

  it('повод, на который перестали отвечать, приглушается', () => {
    const muted = mutedKinds([
      stats({ kind: 'silent', sent: 40, acted: 1 }), // 2,5% — шум
      stats({ kind: 'overdue', sent: 20, acted: 9 }), // 45% — работает
    ]);
    expect(muted).toEqual(['silent']);
  });

  it('на трёх отправках выводов не делаем', () => {
    expect(mutedKinds([stats({ kind: 'due_soon', sent: 3, acted: 0 })])).toEqual([]);
  });

  it('приглушённый повод не исчезает, а ждёт неделю', () => {
    const day = 86_400_000;
    const sentAt = new Date(noonUtc.getTime() - 3 * day);
    expect(repeatDue(2, sentAt, noonUtc)).toBe(true); // обычный — через три дня
    expect(repeatDue(2, sentAt, noonUtc, true)).toBe(false); // приглушённый ещё молчит
    expect(repeatDue(2, new Date(noonUtc.getTime() - 8 * day), noonUtc, true)).toBe(true);
  });

  it('доля ответов считается по всем поводам разом', () => {
    expect(reactionRate([stats({ sent: 10, acted: 2 }), stats({ kind: 'silent', sent: 10, acted: 0 })])).toBe(10);
    expect(reactionRate([])).toBe(0);
  });
});

describe('Приветствие сводки', () => {
  it('зависит от местного времени получателя, а не сервера', () => {
    // 06:10 UTC — утро в Москве и уже день в Новосибирске
    const morning = new Date('2026-08-26T06:10:00Z');
    expect(greetingFor(morning, 'Europe/Moscow')).toBe('Доброе утро');
    expect(greetingFor(morning, 'Asia/Novosibirsk')).toBe('Добрый день');
    expect(greetingFor(new Date('2026-08-26T16:00:00Z'), 'Europe/Moscow')).toBe('Добрый вечер');
  });
});

/** Состав сводки (задача #1368): по нему панель даёт действие на каждую задачу. */
describe('digestItems', () => {
  it('перечисляет задачи и помечает свои', () => {
    const items = digestItems([
      candidate({ kind: 'overdue', title: 'Сверстать форму', taskId: '10', projectId: '1' }),
      candidate({ kind: 'stuck_review', title: 'Проверить макет', taskId: '11', projectId: '1' }),
      candidate({ kind: 'silent', title: 'Обновить справку', taskId: '12', projectId: '2' }),
    ]);
    // порядок — как в тексте сводки: сначала то, что держит других
    expect(items.map((i) => i.title)).toEqual(['Сверстать форму', 'Проверить макет', 'Обновить справку']);
    // «ждёт вашей проверки» — задача чужая: планировать её себе нельзя
    expect(items.find((i) => i.taskId === '11')?.mine).toBe(false);
    expect(items.find((i) => i.taskId === '10')?.mine).toBe(true);
    expect(items.find((i) => i.taskId === '12')?.projectId).toBe('2');
  });

  it('одна задача — одна строка, даже если поводов несколько', () => {
    const items = digestItems([
      candidate({ kind: 'overdue', title: 'Сверстать форму', taskId: '10', projectId: '1' }),
      candidate({ kind: 'silent', title: 'Сверстать форму', taskId: '10', projectId: '1' }),
    ]);
    expect(items).toHaveLength(1);
  });

  it('поводы без задачи в список не попадают', () => {
    expect(digestItems([candidate({ kind: 'mention_silent', taskId: null })])).toHaveLength(0);
  });
});
