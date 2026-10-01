import { MediaService } from './media.service';

/**
 * Кому кнопка «Идёт созвон» предлагает войти.
 *
 * Раньше — всем сотрудникам в любой созвон компании, включая разговор человека,
 * забывшего выйти. Теперь войти по кнопке можно только в свой созвон; в чужой
 * стучатся (это проверяет шлюз), а здесь — что чужой созвон в меню не предлагается.
 */
describe('Доступ к идущему созвону', () => {
  const room = (over: Record<string, unknown> = {}) => ({
    id: 'r1', tenantId: '2', projectId: null, startedAt: 1, aiEnabled: false,
    participants: new Map([['5', { userId: '5', displayName: 'Ольга' }]]),
    allowed: new Set(['5']),
    ...over,
  });
  const svc = (...rooms: any[]) => {
    const s = Object.create(MediaService.prototype) as MediaService;
    (s as any).rooms = new Map(rooms.map((r) => [r.id, r]));
    return s;
  };

  it('начавший и позванные видят созвон своим, остальные — нет', async () => {
    const s = svc(room({ allowed: new Set(['5', '7']) }));
    expect((await s.activeRooms('2', '7'))[0].canJoin).toBe(true);
    const stranger = (await s.activeRooms('2', '9'))[0];
    expect(stranger.canJoin).toBe(false);
    // кто в созвоне — видно (статус «занят»), просто войти нельзя
    expect(stranger.participants.map((p: any) => p.userId)).toEqual(['5']);
  });

  it('комнату ссылки или события признаёт своей база, и только для таких комнат', async () => {
    const isMember = jest.fn(async () => true);
    const s = svc(room({ id: 'linked', linked: true, allowed: new Set() }), room({ id: 'plain', allowed: new Set() }));
    const rows = await s.activeRooms('2', '9', isMember);
    expect(rows.find((r) => r.id === 'linked')?.canJoin).toBe(true);
    expect(rows.find((r) => r.id === 'plain')?.canJoin).toBe(false);
    expect(isMember).toHaveBeenCalledTimes(1);
  });

  it('пустая комната и чужая организация в список не попадают', async () => {
    const s = svc(room({ id: 'empty', participants: new Map() }), room({ id: 'other', tenantId: '3' }));
    expect(await s.activeRooms('2', '5')).toEqual([]);
  });
});
