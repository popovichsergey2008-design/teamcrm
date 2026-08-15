/**
 * Дымовой тест загрузки корневого модуля.
 *
 * Ловит класс ошибок, невидимый ни для типизации, ни для обычных юнит-тестов:
 * если DTO объявлен ПОСЛЕ контроллера, который ссылается на него в декораторе,
 * метаданные вычисляются раньше объявления класса и весь модуль падает с
 * «Cannot access ... before initialization». Раньше такое всплывало только в e2e,
 * где разом отваливались все сьюты.
 */
describe('AppModule', () => {
  it('загружается без ошибок инициализации', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const mod = require('./app.module');
      expect(mod.AppModule).toBeDefined();
    }).not.toThrow();
  });
});
