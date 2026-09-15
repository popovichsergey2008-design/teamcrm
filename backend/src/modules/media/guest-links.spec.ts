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
    last_used_at: null, created_at: new Date(), tenant_name: 'Борис и КО', ...over,
  });

  const build = (row: any) => {
    const repo = {
      findByHash: () => Promise.resolve(row),
      markUsed: jest.fn(() => Promise.resolve()),
      create: jest.fn(), list: jest.fn(() => Promise.resolve([])), revoke: jest.fn(),
    };
    const media = { getRoom: () => undefined, iceServers: () => [{ urls: 'stun:x' }] };
    const jwt = {
      signAsync: (payload: unknown) => Promise.resolve(`signed:${JSON.stringify(payload)}`),
      verify: (t: string) => JSON.parse(t.replace('signed:', '')),
    };
    const config = { getOrThrow: () => 'secret', get: () => 'https://anthill.team' };
    return new GuestLinksService(repo as any, media as any, jwt as any, config as any);
  };

  it('действующая ссылка показывает организацию и то, что встреча ещё не идёт', async () => {
    const info = await build(link()).describe('t');
    expect(info).toEqual({ valid: true, orgName: 'Борис и КО', label: 'ООО Вектор', roomActive: false, hostPresent: false });
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
});
