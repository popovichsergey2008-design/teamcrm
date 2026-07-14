import { cleanBitrixMarkup } from './bitrix.text';

describe('cleanBitrixMarkup', () => {
  it('схлопывает [URL=x]x[/URL] в один URL', () => {
    expect(cleanBitrixMarkup('[URL=https://rostov-dental.ru/]https://rostov-dental.ru/[/URL]'))
      .toBe('https://rostov-dental.ru/');
  });

  it('ссылку с текстом отображает как "текст (url)"', () => {
    expect(cleanBitrixMarkup('[URL=https://x.ru/]наш сайт[/URL]')).toBe('наш сайт (https://x.ru/)');
  });

  it('снимает [P] и парные bb-теги, оставляя текст', () => {
    expect(cleanBitrixMarkup('[P][B]Заголовок[/B][/P]')).toBe('Заголовок');
  });

  it('список сайтов в [P][URL] превращает в чистые строки', () => {
    const raw = '[P][URL=https://ulybkasibiri.ru/]https://ulybkasibiri.ru/[/URL][/P]\n' +
      '[P][URL=https://alldent32.ru/]https://alldent32.ru/[/URL][/P]';
    expect(cleanBitrixMarkup(raw)).toBe('https://ulybkasibiri.ru/\nhttps://alldent32.ru/');
  });

  it('убирает [IMG], html-теги и сущности', () => {
    expect(cleanBitrixMarkup('[IMG]https://a/b.png[/IMG]текст&nbsp;тут <b>жирный</b>&amp;ещё'))
      .toBe('текст тут жирный&ещё');
  });

  it('[BR] и </p> дают перевод строки', () => {
    expect(cleanBitrixMarkup('первая[BR]вторая')).toBe('первая\nвторая');
  });

  it('пустой/undefined → пустая строка', () => {
    expect(cleanBitrixMarkup('')).toBe('');
    expect(cleanBitrixMarkup(null)).toBe('');
    expect(cleanBitrixMarkup(undefined)).toBe('');
  });

  it('обычный текст без разметки не портится', () => {
    expect(cleanBitrixMarkup('Просто задача про клинику в Самаре')).toBe('Просто задача про клинику в Самаре');
  });
});
