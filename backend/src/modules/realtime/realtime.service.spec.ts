import { RealtimeService } from './realtime.service';

/**
 * security/client-изоляция (master фича №9): события в клиентскую комнату
 * НЕ должны содержать финансовых полей. Проверяем транспортный слой.
 */
describe('RealtimeService — client financial isolation', () => {
  function makeFakeServer() {
    const emitted: Record<string, any[]> = {};
    const server: any = {
      to(room: string) {
        return {
          emit(event: string, payload: any) {
            emitted[room] = emitted[room] ?? [];
            emitted[room].push({ event, payload });
          },
        };
      },
    };
    return { server, emitted };
  }

  it('strips financial fields for client room, keeps them for internal room', () => {
    const { server, emitted } = makeFakeServer();
    const svc = new RealtimeService();
    svc.setServer(server);

    svc.emit('1', '42', 'task.moved', {
      id: '7',
      title: 'Build API',
      cost_current: '1234.56',
      budget: '99999',
      assignee_id: '3',
    });

    const internal = emitted['project:1:42'][0].payload;
    const client = emitted['project:1:42:client'][0].payload;

    expect(internal.cost_current).toBe('1234.56');
    expect(internal.budget).toBe('99999');

    expect(client.cost_current).toBeUndefined();
    expect(client.budget).toBeUndefined();
    expect(client.title).toBe('Build API');
    expect(client.assignee_id).toBe('3');
  });

  it('strips financial fields nested in arrays/objects', () => {
    const { server, emitted } = makeFakeServer();
    const svc = new RealtimeService();
    svc.setServer(server);

    svc.emit('1', '42', 'task.updated', {
      id: '7',
      nested: { hourly_rate: '50', label: 'ok' },
      list: [{ amount: '10', name: 'a' }],
    });

    const client = emitted['project:1:42:client'][0].payload;
    expect(client.nested.hourly_rate).toBeUndefined();
    expect(client.nested.label).toBe('ok');
    expect(client.list[0].amount).toBeUndefined();
    expect(client.list[0].name).toBe('a');
  });
});
