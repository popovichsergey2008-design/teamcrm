import { actionInfinitive, declineName, firstName, guessGender, pastVerb, plural, toInfinitive, weekdayOn, whenSaid } from './ru-grammar';

describe('русская грамматика секретаря', () => {
  it('имя из полного имени', () => {
    expect(firstName('Глеб Иванов')).toBe('Глеб');
    expect(firstName('Иванов Глеб')).toBe('Глеб');
    expect(firstName('Иванов Глеб Петрович')).toBe('Глеб');
    expect(firstName('Анна Сергеевна')).toBe('Анна');
    expect(firstName('Борис')).toBe('Борис');
    expect(firstName('John Smith')).toBe('John');
    expect(firstName('')).toBe('');
  });

  it('пол: отчество, фамилия, окончание имени; не уверены — null', () => {
    expect(guessGender('Глеб')).toBe('m');
    expect(guessGender('Анна')).toBe('f');
    expect(guessGender('Илья')).toBe('m');
    expect(guessGender('Никита Петров')).toBe('m');
    expect(guessGender('Саша')).toBeNull();
    expect(guessGender('Саша Петрова')).toBe('f');
    expect(guessGender('Женя Иванович')).toBe('m');
    expect(guessGender('Игорь')).toBe('m');
    expect(guessGender('Любовь')).toBe('f');
    expect(guessGender('Владелец')).toBe('m');
    expect(guessGender('John')).toBeNull();
    expect(pastVerb('обещал', 'm')).toBe('обещал');
    expect(pastVerb('обещал', 'f')).toBe('обещала');
    expect(pastVerb('обещал', null)).toBe('обещал(а)');
  });

  it('имя в дательном', () => {
    expect(declineName('Глеб', 'dat')).toBe('Глебу');
    expect(declineName('Сергей', 'dat')).toBe('Сергею');
    expect(declineName('Анна', 'dat')).toBe('Анне');
    expect(declineName('Мария', 'dat')).toBe('Марии');
    expect(declineName('Илья', 'dat')).toBe('Илье');
    expect(declineName('Игорь', 'dat')).toBe('Игорю');
    expect(declineName('Дмитрий', 'dat')).toBe('Дмитрию');
    expect(declineName('Ольга', 'dat')).toBe('Ольге');
    expect(declineName('John', 'dat')).toBe('John');
  });

  it('имя в родительном и творительном', () => {
    expect(declineName('Глеб', 'gen')).toBe('Глеба');
    expect(declineName('Сергей', 'gen')).toBe('Сергея');
    expect(declineName('Анна', 'gen')).toBe('Анны');
    expect(declineName('Ольга', 'gen')).toBe('Ольги');
    expect(declineName('Мария', 'gen')).toBe('Марии');
    expect(declineName('Илья', 'gen')).toBe('Ильи');
    expect(declineName('Сергей', 'ins')).toBe('Сергеем');
    expect(declineName('Глеб', 'ins')).toBe('Глебом');
    expect(declineName('Анна', 'ins')).toBe('Анной');
    expect(declineName('Маша', 'ins')).toBe('Машей');
    expect(declineName('Константин', 'ins')).toBe('Константином');
    expect(declineName('Любовь', 'dat')).toBe('Любови');
  });

  it('день недели и «когда»', () => {
    expect(weekdayOn(2)).toBe('во вторник');
    expect(weekdayOn(3)).toBe('в среду');
    expect(weekdayOn(5)).toBe('в пятницу');
    expect(weekdayOn(0)).toBe('в воскресенье');
    // 2026-10-20 — вторник
    expect(whenSaid('2026-10-20', '2026-10-21')).toBe('во вторник');
    expect(whenSaid('2026-10-21', '2026-10-21')).toBe('сегодня');
    expect(whenSaid('2026-10-01', '2026-10-21')).toBe('1 октября');
    expect(plural(24, 'час', 'часа', 'часов')).toBe('часа');
    expect(plural(21, 'час', 'часа', 'часов')).toBe('час');
    expect(plural(11, 'час', 'часа', 'часов')).toBe('часов');
  });

  it('инфинитив из 1-го лица — по словарю документа', () => {
    const cases: [string, string][] = [
      ['скину', 'прислать'], ['сделаю', 'сделать'], ['уточню', 'уточнить'], ['проверю', 'проверить'], ['пришлю', 'прислать'],
      ['отправлю', 'отправить'], ['подготовлю', 'подготовить'], ['позвоню', 'позвонить'], ['напишу', 'написать'],
    ];
    for (const [a, b] of cases) expect(toInfinitive(a)).toBe(b);
  });

  it('инфинитив — общий разбор по суффиксам', () => {
    const cases: [string, string][] = [
      ['согласую', 'согласовать'], ['протестирую', 'протестировать'], ['узнаю', 'узнать'], ['посчитаю', 'посчитать'],
      ['добавлю', 'добавить'], ['оформлю', 'оформить'], ['закрою', 'закрыть'], ['настрою', 'настроить'], ['починю', 'починить'],
      ['выясню', 'выяснить'], ['сверю', 'сверить'], ['подключу', 'подключить'], ['завершу', 'завершить'], ['покажу', 'показать'],
      ['закажу', 'заказать'], ['выложу', 'выложить'], ['загружу', 'загрузить'], ['подпишу', 'подписать'], ['посмотрю', 'посмотреть'],
      ['соберу', 'собрать'], ['разберусь', 'разобраться'], ['займусь', 'заняться'], ['договорюсь', 'договориться'],
      ['созвонюсь', 'созвониться'], ['сдам', 'сдать'], ['передам', 'передать'], ['отвечу', 'ответить'], ['возьму', 'взять'],
      ['найду', 'найти'], ['проведу', 'провести'], ['принесу', 'принести'], ['верну', 'вернуть'], ['вышлю', 'выслать'],
      ['перешлю', 'переслать'], ['назначу', 'назначить'], ['оплачу', 'оплатить'], ['свяжусь', 'связаться'], ['исправлю', 'исправить'],
    ];
    for (const [a, b] of cases) expect([a, toInfinitive(a)]).toEqual([a, b]);
    expect(toInfinitive('смета')).toBeNull();
    expect(toInfinitive('hello')).toBeNull();
  });

  it('действие обещания целиком', () => {
    expect(actionInfinitive('скину смету к вечеру')).toBe('прислать смету к вечеру');
    expect(actionInfinitive('уточню у юриста завтра')).toBe('уточнить у юриста завтра');
    expect(actionInfinitive('Проверю')).toBe('проверить');
    expect(actionInfinitive('я пришлю смету сегодня.')).toBe('прислать смету сегодня');
    expect(actionInfinitive('завтра отправлю договор')).toBe('отправить договор завтра');
    expect(actionInfinitive('смогу прислать отчёт')).toBe('прислать отчёт');
    expect(actionInfinitive('беру на себя договор')).toBe('взять на себя договор');
    expect(actionInfinitive('за мной договор с банком')).toBe('за мной договор с банком');
  });
});
