import { GuestLinksService } from './guest-links.service';

/**
 * Правила гостевой ссылки — без базы и без сети.
 *
 * Проверяется то, что решает вопрос доступа: почему именно отказали (человеку нужно
 * знать, просить новую ссылку или писать организатору) и то, что гостевой токен
 * нельзя перепутать с токеном сотрудника.
 */
describe('Гостевая ссылка в созвон', () => {
  const hourFromNow = () => new Date(Date.now() + 3600_000);
  const link = (over: Partial<any> = {}) => ({
    id: '1', tenant_id: '2', room_id: 'room-1', project_id: null, label: 'ООО Вектор',
    created_by: '5', expires_at: hourFromNow(), revoked_at: null, max_uses: null, uses: 0,
    last_used_at: null, created_at: new Date(), tenant_name: 'Борис и КО',
    chat_id: null, starts_at: null, event_id: null, reminded_at: null, ...over,
  });

  const calls = { realtime: jest.fn(), push: jest.fn(() => Promise.resolve()), telegram: jest.fn(() => Promise.resolve()) };
  const build = (row: any, extra: Record<string, unknown> = {}) => {
    const repo = {
      findByHash: () => Promise.resolve(row),
      markUsed: jest.fn(() => Promise.resolve()),
      create: jest.fn((i: any) => Promise.resolve({ id: '9', expires_at: i.expiresAt, starts_at: i.startsAt, label: i.label })),
      list: jest.fn(() => Promise.resolve([])), revoke: jest.fn(),
      activeForRoom: () => Promise.resolve(row),
      eventPeople: () => Promise.resolve(['7', '5']),
      ...extra,
    };
    const media = { getRoom: () => undefined, iceServers: () => [{ urls: 'stun:x' }] };
    const jwt = {
      signAsync: (payload: unknown) => Promise.resolve(`signed:${JSON.stringify(payload)}`),
      verify: (t: string) => JSON.parse(t.replace('signed:', '')),
    };
    const config = { getOrThrow: () => 'secret', get: () => 'https://anthill.team' };
    calls.realtime.mockClear(); calls.push.mockClear(); calls.telegram.mockClear();
    return new GuestLinksService(
      repo as any, media as any, jwt as any, config as any,
      { emitToUsers: calls.realtime } as any, { meetHost: calls.push } as any, { push: calls.telegram } as any,
    );
  };

  it('действующая ссылка показывает организацию и то, что встреча ещё не идёт', async () => {
    const info = await build(link()).describe('t');
    expect(info).toEqual({ valid: true, orgName: 'Борис и КО', label: 'ООО Вектор', roomActive: false, hostPresent: false, startsAt: null, opensAt: null, hasChat: false,
    });
  });

  it.each([
    ['отозвана', { revoked_at: new Date() }, 'revoked'],
    ['просрочена', { expires_at: new Date(Date.now() - 1000) }, 'expired'],
    ['исчерпана', { max_uses: 1, uses: 1 }, 'used-up'],
  ])('%s — причина отказа названа прямо', async (_name, over, reason) => {
    expect(await build(link(over)).describe('t')).toEqual({ valid: false, reason });
  });

  it('несуществующая ссылка не отличается по ответу от чужой — «unknown» и всё', async () => {
    expect(await build(null).describe('t')).toEqual({ valid: false, reason: 'unknown' });
  });

  it('вход выдаёт токен на ОДНУ комнату и отмечает использование ссылки', async () => {
    const svc = build(link());
    const r = await svc.join('t', '  Сергей из Вектора  ');
    const payload = JSON.parse(r.token.replace('signed:', ''));
    expect(payload).toMatchObject({ kind: 'guest', tenantId: '2', roomId: 'room-1', name: 'Сергей из Вектора' });
    expect(r.userId).toBe(`guest:${payload.gid}`);
    expect(r.roomId).toBe('room-1');
  });

  it('без имени не пускаем: в стенограмме и в списке участников должно быть, кто говорит', async () => {
    await expect(build(link()).join('t', ' ')).rejects.toThrow();
    await expect(build(link()).join('t', 'Я')).rejects.toThrow();
  });

  it('отозванной ссылкой войти нельзя, и отказ объясняется словами', async () => {
    await expect(build(link({ revoked_at: new Date() })).join('t', 'Сергей'))
      .rejects.toThrow(/отозвали/);
  });

  it('токен сотрудника гостевым не считается — и наоборот', () => {
    const svc = build(link());
    // «сотрудник» — обычный access-токен: kind нет, есть sub/role
    expect(svc.verify(`signed:${JSON.stringify({ sub: '5', tenantId: '2', role: 'owner' })}`)).toBeNull();
    // мусор вместо токена не роняет разбор
    expect(svc.verify('не токен')).toBeNull();
    const guest = svc.verify(`signed:${JSON.stringify({ kind: 'guest', gid: 'g1', tenantId: '2', roomId: 'room-1', name: 'Гость' })}`);
    expect(guest?.roomId).toBe('room-1');
  });

  describe('встреча назначена на время («завтра в 9»)', () => {
    const inMin = (m: number) => new Date(Date.now() + m * 60_000);

    it('гость видит время встречи и момент, с которого можно войти', async () => {
      const at = inMin(24 * 60);
      const info = await build(link({ starts_at: at })).describe('t') as any;
      expect(info.startsAt).toBe(at.toISOString());
      expect(new Date(info.opensAt).getTime()).toBe(at.getTime() - 15 * 60_000);
    });

    it('в созвон раньше времени не пускаем, а в переписку — пускаем', async () => {
      await expect(build(link({ starts_at: inMin(60) })).join('t', 'Сергей')).rejects.toThrow(/15 минут/);
      const r = await build(link({ starts_at: inMin(60), chat_id: '3' })).join('t', 'Сергей');
      expect(r.chatId).toBe('3');
      // за десять минут до начала — уже можно
      await expect(build(link({ starts_at: inMin(10) })).join('t', 'Сергей')).resolves.toBeTruthy();
    });

    it('срок ссылки не кончается раньше встречи, даже если выбрали «сутки»', async () => {
      const svc = build(null);
      const at = inMin(7 * 24 * 60);
      const r = await svc.create('2', '5', { startsAt: at.toISOString(), ttlHours: 24 });
      expect(new Date(r.expiresAt).getTime()).toBeGreaterThanOrEqual(at.getTime() + 4 * 3600_000);
    });

    it('прошедшее время встречи не принимаем', async () => {
      await expect(build(null).create('2', '5', { startsAt: inMin(-60).toISOString() })).rejects.toThrow(/прошло/);
    });

    it('гость постучал в пустую комнату — зовём автора и сотрудников события, без повторов', async () => {
      const svc = build(link({ starts_at: inMin(5), event_id: '11' }));
      expect(await svc.callHost('2', 'room-1', 'Сергей')).toBe(true);
      expect(calls.realtime).toHaveBeenCalledWith('2', ['5', '7'], 'meet.guest-call-host', expect.objectContaining({ kind: 'waiting', roomId: 'room-1' }));
      expect(calls.push).toHaveBeenCalledTimes(2);
      // переподключился и стучит снова — второй раз не будим
      expect(await svc.callHost('2', 'room-1', 'Сергей')).toBe(true);
      expect(calls.realtime).toHaveBeenCalledTimes(1);
    });

    it('гость пришёл за сутки — никого не будим', async () => {
      const svc = build(link({ starts_at: inMin(24 * 60) }));
      expect(await svc.callHost('2', 'room-1', 'Сергей')).toBe(false);
      expect(await svc.opensLater('2', 'room-1')).not.toBeNull();
      expect(calls.realtime).not.toHaveBeenCalled();
    });

    it('перед встречей напоминаем один раз, даже если проходов два', async () => {
      const due = link({ starts_at: inMin(8) });
      let marked = false;
      const svc = build(due, {
        dueReminders: () => Promise.resolve([due]),
        markReminded: () => { const first = !marked; marked = true; return Promise.resolve(first); },
      });
      expect(await svc.remindDue()).toBe(1);
      expect(await svc.remindDue()).toBe(0);
      expect(calls.realtime).toHaveBeenCalledTimes(1);
      expect(calls.realtime.mock.calls[0][3]).toMatchObject({ kind: 'soon' });
    });
  });
});
