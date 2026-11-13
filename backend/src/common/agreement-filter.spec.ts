import { isJunkPhrase, isRealAgreement, likeLearned, normalizePhrase } from './agreement-filter';

describe('договорённости со встреч (#4891, п. 8)', () => {
  it('пустые реплики — не договорённости', () => {
    expect(isRealAgreement('сейчас мит закрою, и у меня ничего нету')).toBe(false);
    expect(isRealAgreement('Меня слышно?')).toBe(false);
    expect(isRealAgreement('ну ладно')).toBe(false);
  });
  it('действие или результат — договорённость', () => {
    expect(isRealAgreement('Пришлю смету до пятницы')).toBe(true);
    expect(isRealAgreement('Константин подготовит отчёт по продажам')).toBe(true);
    expect(isRealAgreement('КП клиенту — за Анной')).toBe(true);
  });
  it('«Это не обещание» учит фильтр: похожая фраза отсеивается', () => {
    const learned = [normalizePhrase('Я потом посмотрю, может, напишу')];
    expect(likeLearned('потом посмотрю может напишу', learned)).toBe(true);
    expect(isRealAgreement('Я потом посмотрю, может напишу', learned)).toBe(false);
    expect(isRealAgreement('Напишу договор к среде', learned)).toBe(true);
  });
  it('бриф не цитирует пустое и отмеченное', () => {
    expect(isJunkPhrase('у меня ничего нет')).toBe(true);
    expect(isJunkPhrase('Используем Postgres для отчётов')).toBe(false);
    expect(isJunkPhrase('Используем Postgres для отчётов', [normalizePhrase('используем postgres для отчётов')])).toBe(true);
  });
});
