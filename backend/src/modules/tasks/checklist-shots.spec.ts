import { SHOTS_ITEM, withShotsItem } from './checklist-shots';

describe('#4889: пункт про скриншоты в проверках', () => {
  it('дописывается последним к проверкам', () => {
    expect(withShotsItem(['Открыть доску', 'Проверить поиск'])).toEqual(['Открыть доску', 'Проверить поиск', SHOTS_ITEM]);
  });
  it('без чек-листа ничего не появляется', () => {
    expect(withShotsItem([])).toEqual([]);
    expect(withShotsItem(['  '])).toEqual([]);
  });
  it('не дублируется, если про снимки уже сказано', () => {
    expect(withShotsItem(['Сделать скрин до и после'])).toHaveLength(1);
    expect(withShotsItem(['Приложить было/стало'])).toHaveLength(1);
    expect(withShotsItem(['Attach screenshot'])).toHaveLength(1);
  });
});
