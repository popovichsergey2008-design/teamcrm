import { guessColor, looksLikeSticker, parseWhen, stripCommand } from './sticker-rules';

// четверг, 19 ноября 2026, 14:00 местного
const now = new Date(2026, 10, 19, 14, 0);

describe('стикеры: дата и время из текста (#4997, шаг 1.2)', () => {
  it('день недели и время', () => {
    expect(parseWhen('в пятницу в 15:00 отправить КП Улыбке', now)).toEqual({ date: '2026-11-20', time: '15:00' });
  });
  it('завтра / послезавтра / утром / вечером', () => {
    expect(parseWhen('завтра в 10 позвонить Ивану', now)).toEqual({ date: '2026-11-20', time: '10:00' });
    expect(parseWhen('послезавтра утром врач', now)).toEqual({ date: '2026-11-21', time: '09:00' });
    expect(parseWhen('вечером купить хлеб', now)).toEqual({ date: '2026-11-19', time: '18:00' });
  });
  it('через N часов / через неделю', () => {
    expect(parseWhen('через 2 часа созвон', now)).toEqual({ date: '2026-11-19', time: '16:00' });
    expect(parseWhen('через неделю отчёт', now)).toEqual({ date: '2026-11-26', time: null });
  });
  it('25-го и конец месяца', () => {
    expect(parseWhen('25-го оплатить хостинг', now)).toEqual({ date: '2026-11-25', time: null });
    expect(parseWhen('10-го счёт', now)).toEqual({ date: '2026-12-10', time: null });
    expect(parseWhen('в конце месяца отчёт за ноябрь', now)).toEqual({ date: '2026-11-30', time: null });
  });
  it('без даты — без даты; время прошло — завтра', () => {
    expect(parseWhen('видео про стикеры', now)).toEqual({ date: null, time: null });
    expect(parseWhen('в 9 утра зарядка', now)).toEqual({ date: '2026-11-20', time: '09:00' });
  });
});

describe('стикеры: цвет и намерение', () => {
  it('цвет по смыслу', () => {
    expect(guessColor('идея — скидка за приглашение друга')).toBe('green');
    expect(guessColor('срочно отправить счёт')).toBe('pink');
    expect(guessColor('позвонить Ивану')).toBe('blue');
    expect(guessColor('купить подарок маме')).toBe('lilac');
    expect(guessColor('упростить онбординг')).toBe('yellow');
  });
  it('стикер, а не задача', () => {
    expect(looksLikeSticker('напомни в понедельник продлить домен')).toBe(true);
    expect(looksLikeSticker('мысль: сделать видео про стикеры')).toBe(true);
    expect(looksLikeSticker('поставь задачу Ивану не забыть отчёт')).toBe(false);
    expect(looksLikeSticker('что у меня на завтра?')).toBe(false);
  });
  it('команда из начала убирается', () => {
    expect(stripCommand('напомни в понедельник продлить домен')).toBe('В понедельник продлить домен');
    expect(stripCommand('мысль: сделать видео про стикеры')).toBe('Сделать видео про стикеры');
  });
});
