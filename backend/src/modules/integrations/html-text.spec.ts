import { htmlToText, looksLikeHtml } from './html-text';

/**
 * Разбор разметки регулярками ошибается молча: съедает текст вместе с тегом, оставляет
 * половину сущности или склеивает слова из соседних ячеек. Поэтому проверяем именно те
 * случаи, которые приезжают из трекеров.
 */
describe('htmlToText', () => {
  it('снимает теги, оставляя смысл и переводы строк', () => {
    expect(htmlToText('<p>Сделать <strong>до пятницы</strong></p>')).toBe('Сделать до пятницы');
    expect(htmlToText('Первая<br>Вторая')).toBe('Первая\nВторая');
    expect(htmlToText('<div>Раз</div><div>Два</div>')).toBe('Раз\nДва');
  });

  it('список остаётся списком, а не одной строкой', () => {
    expect(htmlToText('<ul><li>Раз</li><li>Два</li></ul>')).toBe('• Раз\n• Два');
  });

  it('ссылка сохраняет текст, а без текста — адрес', () => {
    expect(htmlToText('<a href="https://x.ru/m">макет</a>')).toBe('макет (https://x.ru/m)');
    expect(htmlToText('<a href="https://x.ru/m"></a>')).toBe('https://x.ru/m');
    // адрес и текст совпали — второй раз его печатать незачем
    expect(htmlToText('<a href="https://x.ru">https://x.ru</a>')).toBe('https://x.ru');
  });

  it('сущности раскрываются, включая числовые', () => {
    expect(htmlToText('Тариф&nbsp;«Базовый»&nbsp;&mdash; 5&nbsp;000&nbsp;&#8381;'))
      .toBe('Тариф «Базовый» — 5 000 ₽');
    expect(htmlToText('a &amp; b &lt;тег&gt;')).toBe('a & b <тег>');
  });

  it('ячейки таблицы не склеиваются в одно слово', () => {
    expect(htmlToText('<table><tr><td>Итого</td><td>Москва</td></tr></table>')).toBe('Итого Москва');
  });

  it('скрипты и стили выносятся вместе с содержимым', () => {
    expect(htmlToText('<style>.a{color:red}</style>Текст')).toBe('Текст');
    expect(htmlToText('<script>alert(1)</script>Текст')).toBe('Текст');
  });

  it('картинка оставляет подпись, если она есть', () => {
    expect(htmlToText('<img src="a.png" alt="Схема"> дальше')).toBe('[Схема] дальше');
    expect(htmlToText('<img src="a.png"> дальше')).toBe('дальше');
  });

  it('чистый текст не портится', () => {
    expect(htmlToText('Просто текст с 5 < 7')).toBe('Просто текст с 5 < 7');
    expect(htmlToText('')).toBe('');
    expect(htmlToText(null)).toBe('');
  });

  it('разметка узнаётся, чтобы не чистить уже чистое', () => {
    expect(looksLikeHtml('<p>раз</p>')).toBe(true);
    expect(looksLikeHtml('Тариф&nbsp;«Базовый»')).toBe(true);
    expect(looksLikeHtml('обычный текст')).toBe(false);
    expect(looksLikeHtml('5 < 7 и 9 > 3')).toBe(false);
  });
});
