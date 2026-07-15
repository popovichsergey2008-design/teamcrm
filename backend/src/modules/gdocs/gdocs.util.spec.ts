import { extractGoogleLinks } from './gdocs.util';

describe('extractGoogleLinks', () => {
  it('находит document/spreadsheet/presentation/file и определяет тип', () => {
    const text =
      'бриф https://docs.google.com/document/d/1F6OiT-wuKyEl43SeCUowOqQHq5lzmYDuns8fcvpk4so/edit?tab=t.0 ' +
      'таблица https://docs.google.com/spreadsheets/d/1Wh9DEfYWHpgMZSSel_vOuXV54-Mq9ofR/edit?usp=sharing ' +
      'слайды https://docs.google.com/presentation/d/1abcDEF_ghIJKlmnop12345/edit ' +
      'файл https://drive.google.com/file/d/1eFZMx3IwOIXdY816-hejezAcbV84C78X/view?usp=sharing';
    const links = extractGoogleLinks(text);
    expect(links.map((l) => l.docType)).toEqual(['document', 'spreadsheet', 'presentation', 'file']);
    expect(links[0].docKey).toBe('1F6OiT-wuKyEl43SeCUowOqQHq5lzmYDuns8fcvpk4so');
  });

  it('дедуплицирует одинаковые ссылки', () => {
    const url = 'https://docs.google.com/document/d/1F6OiT-wuKyEl43SeCUowOqQHq5lzmYDuns8fcvpk4so/edit';
    expect(extractGoogleLinks(`${url} и снова ${url}`).length).toBe(1);
  });

  it('пустой/без ссылок → []', () => {
    expect(extractGoogleLinks('обычный текст без ссылок')).toEqual([]);
    expect(extractGoogleLinks(null)).toEqual([]);
  });
});
