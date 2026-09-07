import { cardHash, descriptionWithLinks, isCardDone, labelColor, labelNames, priorityFromLabels } from './trello.map';
import type { TrCard, TrLabel } from './trello.client';

/**
 * Правила переноса Trello ошибаются молча: «выполнено» живёт в двух разных полях,
 * приоритета в Trello нет вовсе (его обозначают цветом метки), а хеш карточки решает,
 * доедет ли правка при повторном прогоне. Ни одна из этих ошибок не роняет импорт —
 * видно только по неверной доске.
 */

const label = (name: string, color: string | null = null): TrLabel => ({ id: name, name, color });
const card = (over: Partial<TrCard> = {}): TrCard => ({
  id: 'c1', name: 'Карточка', desc: '', closed: false, due: null,
  idList: 'l1', idMembers: [], labels: [], pos: 1, ...over,
});

describe('Trello: приоритет по меткам', () => {
  it('слово важнее цвета: команда пишет «Срочно» и красит как хочет', () => {
    expect(priorityFromLabels([label('Срочно', 'green')])).toBe('urgent');
    expect(priorityFromLabels([label('Важное', 'blue')])).toBe('high');
    expect(priorityFromLabels([label('Потом', 'red')])).toBe('low');
  });

  it('без слов работает цвет, как принято в Trello', () => {
    expect(priorityFromLabels([label('', 'red')])).toBe('urgent');
    expect(priorityFromLabels([label('', 'orange')])).toBe('high');
    expect(priorityFromLabels([label('', 'green')])).toBe('low');
  });

  it('непонятное остаётся обычным: неверный приоритет хуже никакого', () => {
    expect(priorityFromLabels([])).toBe('normal');
    expect(priorityFromLabels([label('Дизайн', 'purple')])).toBe('normal');
  });
});

describe('Trello: что считать выполненным', () => {
  it('архив карточки и отметка срока — оба означают «сделано»', () => {
    expect(isCardDone(card())).toBe(false);
    expect(isCardDone(card({ closed: true }))).toBe(true);
    expect(isCardDone(card({ dueComplete: true }))).toBe(true);
  });
});

describe('Trello: метки и описание', () => {
  it('безымянные метки не переносятся, дубли схлопываются', () => {
    expect(labelNames([label('Фронт'), label(''), label('Фронт')])).toEqual(['Фронт']);
    expect(labelColor('red')).toBe('#d64545');
    expect(labelColor('неизвестный')).toBe('#6b7280');
    expect(labelColor(null)).toBe('#6b7280');
  });

  it('внешние вложения уезжают в описание ссылками, а не пропадают', () => {
    const out = descriptionWithLinks('Сверстать блок', [{ name: 'Макет', url: 'https://figma.com/x' }]);
    expect(out).toContain('Сверстать блок');
    expect(out).toContain('[Макет](https://figma.com/x)');
    // без ссылок описание не обрастает лишними заголовками
    expect(descriptionWithLinks('Просто текст', [])).toBe('Просто текст');
  });
});

describe('Trello: хеш карточки', () => {
  it('не меняется, пока не изменилось переносимое', () => {
    const a = card({ name: 'Задача', desc: 'текст' });
    expect(cardHash(a, '7')).toBe(cardHash(card({ name: 'Задача', desc: 'текст' }), '7'));
    // порядок меток на карточке роли не играет — это одно и то же состояние
    const withLabels = card({ labels: [label('Фронт'), label('Бэк')] });
    const reordered = card({ labels: [label('Бэк'), label('Фронт')] });
    expect(cardHash(withLabels, null)).toBe(cardHash(reordered, null));
  });

  it('меняется от всего, что мы переносим', () => {
    const base = card({ name: 'Задача', desc: 'текст', idList: 'l1', due: '2026-10-01T10:00:00Z' });
    const h = cardHash(base, '7');
    expect(cardHash(card({ ...base, name: 'Другая' }), '7')).not.toBe(h);
    expect(cardHash(card({ ...base, desc: 'иначе' }), '7')).not.toBe(h);
    expect(cardHash(card({ ...base, idList: 'l2' }), '7')).not.toBe(h); // переехала в другой список
    expect(cardHash(card({ ...base, due: '2026-11-01T10:00:00Z' }), '7')).not.toBe(h);
    expect(cardHash(card({ ...base, dueComplete: true }), '7')).not.toBe(h);
    expect(cardHash(base, '9')).not.toBe(h); // сменился исполнитель — в том числе после ручной привязки
    const withCheck = card({
      ...base,
      checklists: [{ id: 'k1', name: 'Шаги', checkItems: [{ id: 'i1', name: 'Раз', state: 'complete', pos: 1 }] }],
    });
    expect(cardHash(withCheck, '7')).not.toBe(h);
  });
});
