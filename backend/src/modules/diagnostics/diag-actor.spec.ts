import { DiagService } from './diag.service';

/**
 * Гость в журнале диагностики.
 *
 * Колонка user_id — bigint. Пока в созвоны ходили только сотрудники, туда всегда
 * попадало число. С гостями («guest:<uuid>») неаккуратная запись роняла бы ВЕСЬ пакет
 * событий разом, а ошибки журнала проглатываются намеренно — поломка была бы немой.
 */
describe('Журнал диагностики: гость не роняет пакет', () => {
  const captured: unknown[][] = [];
  const db = {
    query: (_sql: string, params: unknown[]) => { captured.push(params); return Promise.resolve({ rows: [] } as any); },
  };
  const diag = new DiagService(db as any);

  beforeEach(() => { captured.length = 0; });

  it('нечисловой участник уходит в data.actor, а колонка остаётся пустой', async () => {
    await diag.writeMany([
      { tenantId: '2', scope: 'meet', refId: 'room-1', userId: 'guest:abc-123', side: 'server', event: 'join', data: { people: 2 } },
    ]);
    const params = captured[0];
    expect(params[3]).toBeNull();                       // user_id — пусто, а не 'guest:...'
    const data = JSON.parse(String(params[6]));
    expect(data).toEqual({ people: 2, actor: 'guest:abc-123' }); // кто это был — не потеряли
  });

  it('сотрудник пишется как раньше — числом и без подмены data', async () => {
    await diag.writeMany([
      { tenantId: '2', scope: 'meet', refId: 'room-1', userId: '42', side: 'server', event: 'join', data: { people: 2 } },
    ]);
    const params = captured[0];
    expect(params[3]).toBe('42');
    expect(JSON.parse(String(params[6]))).toEqual({ people: 2 });
  });

  it('событие без данных у гостя всё равно сохраняет, кто это был', async () => {
    await diag.writeMany([
      { scope: 'meet', refId: 'room-1', userId: 'guest:zz', side: 'server', event: 'leave' },
    ]);
    const params = captured[0];
    expect(params[3]).toBeNull();
    expect(JSON.parse(String(params[6]))).toEqual({ actor: 'guest:zz' });
  });
});
