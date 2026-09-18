import { AiGateway } from './ai-gateway';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Очередь к модели.
 *
 * Проверяем обещание, а не реализацию: живой разговор не должен ждать ночной отчёт, а
 * при заторе фоновое откладывается — но не живое. Ошибка здесь не падает, она просто
 * заставляет человека ждать, и заметить её в работе почти невозможно.
 */
describe('очередь обращений к модели', () => {
  it('живое идёт вперёд фонового, даже если фоновое встало раньше', async () => {
    const gw = new AiGateway();
    // Забиваем все места долгими задачами, чтобы остальные встали в очередь.
    const busy = Array.from({ length: 6 }, () => gw.run('user', () => wait(40)));
    const order: string[] = [];

    const bg = gw.run('index', async () => { order.push('index'); });
    const back = gw.run('background', async () => { order.push('background'); });
    await wait(1);
    const live = gw.run('support', async () => { order.push('support'); });

    await Promise.all([...busy, bg, back, live]);
    expect(order[0]).toBe('support');
    expect(order).toEqual(['support', 'background', 'index']);
  });

  it('при равной важности — кто дольше ждёт', async () => {
    const gw = new AiGateway();
    const busy = Array.from({ length: 6 }, () => gw.run('user', () => wait(30)));
    const order: number[] = [];
    const a = gw.run('support', async () => { order.push(1); });
    const b = gw.run('support', async () => { order.push(2); });
    await Promise.all([...busy, a, b]);
    expect(order).toEqual([1, 2]);
  });

  it('при заторе фоновое откладывается, а живое проходит', async () => {
    const gw = new AiGateway();
    const busy = Array.from({ length: 6 }, () => gw.run('user', () => wait(60)));
    // 40 ожидающих — порог сброса нагрузки
    const queued = Array.from({ length: 41 }, () => gw.run('user', () => wait(1)));

    await expect(gw.run('index', async () => 'ok')).rejects.toThrow('ai_busy');
    const live = gw.run('support', async () => 'ok');
    await expect(live).resolves.toBe('ok');

    await Promise.all([...busy, ...queued]);
    expect(gw.stats().shed).toBe(1);
  });

  it('место освобождается даже когда задача упала', async () => {
    const gw = new AiGateway();
    await expect(gw.run('user', async () => { throw new Error('провал'); })).rejects.toThrow('провал');
    expect(gw.stats().inflight).toBe(0);
    await expect(gw.run('user', async () => 'ok')).resolves.toBe('ok');
  });
});
