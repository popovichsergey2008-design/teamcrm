import { stripPasteJunk } from './paste-junk';

describe('мусор из буфера (#1559)', () => {
  it('стиль ячейки Google Таблиц убирается, текст остаётся', () => {
    expect(stripPasteJunk('<!--td {border: 1px solid #cccccc;}br {mso-data-placement:same-cell;}-->Изистом Новосибирск'))
      .toBe('Изистом Новосибирск');
    expect(stripPasteJunk('a<style>td{}</style>b')).toBe('ab');
    expect(stripPasteJunk('обычный текст < 5 и > 3')).toBe('обычный текст < 5 и > 3');
    expect(stripPasteJunk(null)).toBeNull();
  });
});
