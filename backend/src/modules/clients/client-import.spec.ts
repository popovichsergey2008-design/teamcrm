import { guessMapping, parseRow } from './client-import';

describe('импорт клиентов', () => {
  const headers = ['Название компании', 'ИНН', 'Контактное лицо', 'Телефон', 'E-mail', 'Сайт', 'Ответственный', 'Статус'];
  const mapping = guessMapping(headers);

  it('колонки угадываются по русским заголовкам', () => {
    expect(mapping).toEqual({
      'Название компании': 'name', ИНН: 'taxId', 'Контактное лицо': 'contactName', Телефон: 'phone',
      'E-mail': 'email', Сайт: 'website', Ответственный: 'owner', Статус: 'status',
    });
  });

  it('строка → клиент и основной контакт, телефон и почта нормализованы', () => {
    const r = parseRow(['ООО «Ромашка»', '77 0123 4567', 'Иван Петров', '8 (999) 123-45-67', 'Ivan@Romashka.ru', 'www.romashka.ru', 'Анна', 'Лид'], headers, mapping);
    expect(r.ok).toBe(true);
    expect(r.client.status).toBe('lead');
    expect(r.client.taxId).toBe('7701234567');
    expect(r.client.domain).toBe('romashka.ru');
    expect(r.client.ownerHint).toBe('Анна');
    expect(r.contact).toMatchObject({ firstName: 'Иван', lastName: 'Петров', phoneNorm: '+79991234567', emailNorm: 'ivan@romashka.ru' });
  });

  it('плохая строка — с причиной, а не падение', () => {
    expect(parseRow(['', '', '', '', '', '', '', ''], headers, mapping)).toMatchObject({ ok: false, error: 'нет названия' });
    expect(parseRow(['Acme', '', '', '', 'не-почта', '', '', ''], headers, mapping).ok).toBe(false);
  });
});
