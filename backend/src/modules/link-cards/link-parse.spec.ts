import { linkKey, parseQevoLink, sheetTitle } from './link-parse';

describe('#4902 п. 3: разбор ссылок на объекты Qevo', () => {
  it('задача — с любым из наших хостов и относительным путём', () => {
    const want = { kind: 'task', id: '4863', projectId: '130' };
    for (const u of [
      'https://app.qevo.one/projects/130/task/4863',
      'https://qevo.one/projects/130/task/4863',
      'https://dev.qevo.one/projects/130/task/4863/',
      'http://anthill.team/projects/130/task/4863',
      'https://app.teamsmrt.com/projects/130/task/4863?x=1#c',
      'https://app.qevo.one/projects/130/task/4863/check',
      '/projects/130/task/4863',
    ]) expect(parseQevoLink(u)).toEqual(want);
  });

  it('встреча и итоги созвона, файл', () => {
    expect(parseQevoLink('https://app.qevo.one/meetings/77')).toEqual({ kind: 'meeting', id: '77' });
    expect(parseQevoLink('https://app.qevo.one/meetings/77/postcall')).toEqual({ kind: 'meeting', id: '77' });
    expect(parseQevoLink('/meetings/77?t=735')).toEqual({ kind: 'meeting', id: '77' });
    expect(parseQevoLink('https://app.qevo.one/api/files/12')).toEqual({ kind: 'file', id: '12' });
    expect(parseQevoLink('/api/files/12')).toEqual({ kind: 'file', id: '12' });
  });

  it('Google-таблица — по номеру документа, хвосты не мешают', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz_0123456789-xy';
    expect(parseQevoLink(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toEqual({ kind: 'sheet', id });
    expect(parseQevoLink(`https://docs.google.com/spreadsheets/d/${id}`)).toEqual({ kind: 'sheet', id });
    // документ — не таблица; короткий «номер» — не номер
    expect(parseQevoLink(`https://docs.google.com/document/d/${id}/edit`)).toBeNull();
    expect(parseQevoLink('https://docs.google.com/spreadsheets/d/abc/edit')).toBeNull();
  });

  it('чужие сайты и не-объекты — не карточки', () => {
    for (const u of [
      'https://evil.com/projects/1/task/2',
      'https://qevo.one.evil.com/projects/1/task/2',
      'https://notqevo.one/projects/1/task/2',
      '//evil.com/projects/1/task/2',
      'javascript:alert(1)',
      'https://app.qevo.one/projects/130',
      'https://app.qevo.one/projects/130/task/abc',
      'https://app.qevo.one/chat/5',
      'https://app.qevo.one/api/files/play/12',
      '',
      'просто текст',
    ]) expect(parseQevoLink(u)).toBeNull();
  });

  it('ключ объекта не зависит от хоста', () => {
    const a = parseQevoLink('https://app.qevo.one/projects/130/task/4863')!;
    const b = parseQevoLink('/projects/130/task/4863')!;
    expect(linkKey(a)).toBe(linkKey(b));
    expect(linkKey(a)).toBe('task:4863');
  });
});

describe('#4902 п. 3: название Google-таблицы', () => {
  it('срезает хвост «— Google Таблицы» и разворачивает сущности', () => {
    expect(sheetTitle('<html><title>Бюджет Q4 &amp; план - Google Таблицы</title>')).toBe('Бюджет Q4 & план');
    expect(sheetTitle('<title>Plan – Google Sheets</title>')).toBe('Plan');
  });
  it('служебные страницы — без названия', () => {
    expect(sheetTitle('<title>Google Sheets</title>')).toBeNull();
    expect(sheetTitle('<title>Google Sheets: Sign-in</title>')).toBeNull();
    expect(sheetTitle('<title>Вход – Google Аккаунты</title>')).toBeNull();
    expect(sheetTitle('нет заголовка')).toBeNull();
    expect(sheetTitle('<title>Входящие заявки - Google Таблицы</title>')).toBe('Входящие заявки');
  });
});
