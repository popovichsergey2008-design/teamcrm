import { parseAnswer } from './support-ai';

/**
 * Разбор ответа первой линии.
 *
 * Проверяем не «функция работает», а обещание: человек НИКОГДА не видит служебную
 * метку, а сломанная метка не портит ответ. Ошибиться здесь легко и молча — метку
 * увидит клиент в чате поддержки.
 */
describe('ответ помощника: снятие служебной метки', () => {
  it('снимает метку и понимает классификацию', () => {
    const r = parseAnswer(
      'Задачу можно поставить тремя способами.\nКнопка «Новая задача» на доске.\n'
      + '#META {"confidence":"high","intent":"how_to","skill":"tasks","priority":"normal","summary":"как поставить задачу"}',
    );
    expect(r.text).toBe('Задачу можно поставить тремя способами.\nКнопка «Новая задача» на доске.');
    expect(r.text).not.toContain('META');
    expect(r.confidence).toBe('high');
    expect(r.intent).toBe('how_to');
    expect(r.skill).toBe('tasks');
    expect(r.summary).toBe('как поставить задачу');
  });

  it('метка с пустой строкой после неё всё равно снимается', () => {
    const r = parseAnswer('Ответ.\n#META {"confidence":"low"}\n\n');
    expect(r.text).toBe('Ответ.');
    expect(r.confidence).toBe('low');
  });

  it('сломанная метка не портит ответ: средняя уверенность и никакой классификации', () => {
    const r = parseAnswer('Ответ.\n#META {это не json}');
    expect(r.text).toBe('Ответ.');
    expect(r.confidence).toBe('medium');
    expect(r.intent).toBeNull();
    expect(r.priority).toBe('normal');
  });

  it('метки нет вовсе — ответ остаётся как есть', () => {
    const r = parseAnswer('Просто ответ без метки.');
    expect(r.text).toBe('Просто ответ без метки.');
    expect(r.confidence).toBe('medium');
  });

  it('чужие значения в метке заменяются умолчаниями, а не ломают разбор', () => {
    const r = parseAnswer('Ответ.\n#META {"confidence":"уверен","priority":"срочно","skill":"   "}');
    expect(r.confidence).toBe('medium');
    expect(r.priority).toBe('normal');
    expect(r.skill).toBeNull();
  });

  it('длинные поля обрезаются: в очередь не должна уехать простыня', () => {
    const r = parseAnswer(`Ответ.\n#META {"summary":"${'я'.repeat(900)}","intent":"${'x'.repeat(90)}"}`);
    expect(r.summary?.length).toBe(500);
    expect(r.intent?.length).toBe(48);
  });
});
