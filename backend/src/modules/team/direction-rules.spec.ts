import { directionsFromText, listItemsCount } from './direction-rules';

describe('направления задачи по тексту', () => {
  it.each([
    ['Сделать API авторизации для Панорамы складов', 'backend'],
    ['Переделать выгрузку остатков в 1С', 'backend'],
    ['Поправить кнопку на странице оформления заказа', 'frontend'],
    ['Сверстать лендинг под акцию', 'frontend'],
    ['Написать 5 статей для блога ВРТОРГ', 'content'],
    ['ТЗ для копирайтера на инфостатьи', 'content'],
    ['Нарисовать баннер и макет в фигме', 'design'],
    ['Протестировать оплату на телефоне', 'qa'],
    ['Собрать дашборд по конверсии', 'analytics'],
  ])('«%s» → %s', (text, skill) => {
    expect(directionsFromText(text)[0]).toBe(skill);
  });

  it('несколько направлений — все, от главного к второстепенному', () => {
    const d = directionsFromText('API для формы заказа и кнопка на странице, плюс текст для страницы');
    expect(d).toEqual(expect.arrayContaining(['backend', 'frontend', 'content']));
    expect(d[0]).toBe('frontend'); // «страниц» дважды, «кнопк», «форм»
  });

  it('слова нет — молчим, а не угадываем', () => {
    expect(directionsFromText('Позвонить клиенту по договору')).toEqual([]);
  });

  it('часть слова не считается: «ботинки» — не бот', () => {
    expect(directionsFromText('Купить ботинки')).toEqual([]);
  });
});

describe('пункты ТЗ', () => {
  it('считает нумерованные и маркированные строки', () => {
    expect(listItemsCount('ТЗ:\n1. Сделать API\n2) Сверстать форму\n- Написать текст\nитог')).toBe(3);
    expect(listItemsCount('Просто одно поручение')).toBe(0);
  });
});
