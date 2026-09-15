import { mirrorText } from './telegram-mirror.text';

describe('письмо в сообщение бота', () => {
  it('ссылка отписки в чат не уходит: в ней личный токен', () => {
    const out = mirrorText('Новая задача: Прайс', [
      'Сергей поставил вам задачу.',
      '',
      'Открыть: https://anthill.team/projects/1/task/2',
      '',
      'Отписаться: https://anthill.team/api/notifications/unsubscribe?token=SECRET',
    ].join('\n'));

    expect(out).not.toContain('SECRET');
    expect(out).not.toMatch(/отписаться/i);
    expect(out).toContain('https://anthill.team/projects/1/task/2');
  });

  it('тема не повторяется, если письмо начинается с неё', () => {
    expect(mirrorText('Скоро встреча: Планёрка', 'Скоро встреча: Планёрка\nв 10:00'))
      .toBe('Скоро встреча: Планёрка\nв 10:00');
  });

  it('тема ставится первой строкой, когда в тексте её нет', () => {
    expect(mirrorText('Новая задача: Прайс', 'Сергей поставил вам задачу.'))
      .toBe('Новая задача: Прайс\n\nСергей поставил вам задачу.');
  });

  it('воздух письма схлопывается: в чате это половина экрана', () => {
    const out = mirrorText('Тема', 'Первая\n\n\n\nВторая\n\n\n');
    expect(out).toBe('Тема\n\nПервая\n\nВторая');
  });

  it('разделители письма выбрасываются', () => {
    expect(mirrorText('Тема', 'Суть\n-----\nЕщё')).toBe('Тема\n\nСуть\nЕщё');
  });

  it('длинное письмо режется по границе строки, а не посреди ссылки', () => {
    const body = `${'строка текста\n'.repeat(400)}хвост`;
    const out = mirrorText('Тема', body);

    expect(out.length).toBeLessThanOrEqual(3600);
    expect(out.endsWith('\n…')).toBe(true);
    expect(out.split('\n').at(-2)).toBe('строка текста');
  });

  it('пустое письмо оставляет хотя бы тему', () => {
    expect(mirrorText('Скоро встреча', '   \n\n')).toBe('Скоро встреча');
    expect(mirrorText('', 'Только тело')).toBe('Только тело');
  });
});
