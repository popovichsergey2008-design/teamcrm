import { demoSummary, demoTitle, extractDemoDrafts, splitDemoPhrase } from './ai-demo-rules';

// суббота, 10 октября 2026
const NOW = new Date('2026-10-10T10:00:00');
const team = [{ id: '1', full_name: 'Борис Ким' }, { id: '2', full_name: 'Глеб Орлов' }];

describe('демо ИИ-созвона: разбор фразы правилами', () => {
  it('«и» делит, только когда дальше новое действие', () => {
    expect(splitDemoPhrase('Нужно обновить логотип к среде и созвониться с маркетологом'))
      .toEqual(['Нужно обновить логотип к среде', 'созвониться с маркетологом']);
    expect(splitDemoPhrase('Проверить вход и регистрацию на телефоне')).toEqual(['Проверить вход и регистрацию на телефоне']);
    expect(splitDemoPhrase('Подготовить презентацию к пятнице, а также назначить встречу с дизайнером')).toHaveLength(2);
    expect(splitDemoPhrase('')).toEqual([]);
  });

  it('название — без вводных слов и срока', () => {
    expect(demoTitle('Нужно обновить логотип к среде')).toBe('Обновить логотип');
    expect(demoTitle('давайте подготовим отчёт до конца недели.')).toBe('Подготовим отчёт');
    expect(demoTitle('созвониться с маркетологом завтра')).toBe('Созвониться с маркетологом');
  });

  it('пример из ТЗ: две задачи, срок — ближайшая среда, исполнитель — я, созвон — встреча', () => {
    const d = extractDemoDrafts('Нужно обновить логотип к среде и созвониться с маркетологом', NOW, team, '1');
    expect(d).toEqual([
      { title: 'Обновить логотип', kind: 'task', deadline: '2026-10-14', assigneeHint: null, assigneeId: '1' },
      { title: 'Созвониться с маркетологом', kind: 'meeting', deadline: null, assigneeHint: null, assigneeId: '1' },
    ]);
  });

  it('названного, но несуществующего человека не выдумываем; существующего находим', () => {
    const [x] = extractDemoDrafts('Пусть дизайнер обновит логотип', NOW, team, '1');
    expect(x).toMatchObject({ assigneeHint: 'дизайнер', assigneeId: null });
    const [y] = extractDemoDrafts('Поручи Глебу проверить вход', NOW, team, '1');
    expect(y).toMatchObject({ assigneeHint: null, assigneeId: '2' });
  });

  it('краткие итоги', () => {
    expect(demoSummary([{ title: 'Обновить логотип' }, { title: 'Созвониться с маркетологом' }]))
      .toBe('Вы запланировали два действия: обновить логотип и созвониться с маркетологом.');
    expect(demoSummary([{ title: 'Позвонить' }])).toBe('Вы запланировали одно действие: позвонить.');
  });
});
