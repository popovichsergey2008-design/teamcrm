import { tidyTitle, plainOf, titleFromText, TITLE_MAX } from './task-title';

describe('название задачи по описанию (#4699)', () => {
  it('чистит ответ модели', () => {
    expect(tidyTitle('Название: «исправить окно бота».\nвторая строка')).toBe('Исправить окно бота');
    expect(tidyTitle('  \n"Починить вход"  ')).toBe('Починить вход');
    expect(tidyTitle('')).toBe('');
  });

  it('без модели — первая фраза описания, без разметки и ссылок', () => {
    expect(titleFromText('в кево бот выпадает окно, нижняя часть не видна. Показано на скрине'))
      .toBe('В кево бот выпадает окно, нижняя часть не видна');
    expect(titleFromText('**Срочно** сделать [макет](https://x.ru/a) https://y.ru\nещё')).toBe('Срочно сделать макет');
    expect(titleFromText('![снимок](/api/files/12)\n- проверить оплату')).toBe('Проверить оплату');
  });

  it('длинное режет по слову', () => {
    const t = titleFromText('слово '.repeat(40));
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX + 1);
    expect(t.endsWith('…')).toBe(true);
    expect(t).not.toMatch(/\s…$/);
  });

  it('разметка не остаётся', () => {
    expect(plainOf('## Заголовок\n1. пункт ~~старое~~')).toBe('Заголовок\nпункт старое');
  });
});
