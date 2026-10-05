import { GuestLinksService } from './guest-links.service';

/**
 * Встреча по постоянной ссылке (ТЗ-14): состояние и кого пускать.
 *
 * Состояние не хранится, а считается от часов сервера — поэтому проверяем расчёт:
 * «слишком рано», «ранний вход», «открыта», «идёт», «завершена», «отменена».
 */
const MIN = 60_000;
const now = Date.parse('2026-10-06T08:00:00Z');
const link = (over: Record<string, unknown> = {}) => ({
  starts_at: new Date(now + 60 * MIN), expires_at: new Date(now + 6 * 60 * MIN),
  revoked_at: null, cancelled_at: null, ended_at: null, early_join_min: 15, ...over,
});

describe('Состояние встречи', () => {
  const st = (over = {}, live = false, at = now) => GuestLinksService.meetingState(link(over) as any, live, at);

  it('за час — «слишком рано», за 10 минут — ранний вход, после начала — открыта', () => {
    expect(st()).toBe('scheduled');
    expect(st({}, false, now + 50 * MIN)).toBe('early');
    expect(st({}, false, now + 61 * MIN)).toBe('open');
  });

  it('ранний вход берётся из настроек встречи', () => {
    expect(st({ early_join_min: 0 }, false, now + 59 * MIN)).toBe('scheduled');
    expect(st({ early_join_min: 60 }, false, now + 1 * MIN)).toBe('early');
  });

  it('кто-то внутри — идёт; отменена и завершена — так и говорим', () => {
    expect(st({}, true)).toBe('live');
    expect(st({ cancelled_at: new Date() }, true)).toBe('cancelled');
    expect(st({ ended_at: new Date() })).toBe('ended');
    expect(st({}, false, now + 7 * 60 * MIN)).toBe('ended');
    expect(st({ revoked_at: new Date() })).toBe('unavailable');
  });
});

describe('Кого пускать во встречу', () => {
  const people = [
    { user_id: '1', full_name: 'Организатор', is_organizer: true, is_co_organizer: false, status: 'accepted' },
    { user_id: '2', full_name: 'Соорганизатор', is_organizer: false, is_co_organizer: true, status: 'accepted' },
    { user_id: '3', full_name: 'Участник', is_organizer: false, is_co_organizer: false, status: 'invited' },
    { user_id: '4', full_name: 'Отказался', is_organizer: false, is_co_organizer: false, status: 'declined' },
  ];
  const svc = (row: Record<string, unknown>) => {
    const repo = {
      meetingOfRoom: async () => ({ id: '9', created_by: '1', event_id: '7', access_policy: 'trusted', ...link(), ...row }),
      meetingPeople: async () => people,
      setEnded: jest.fn(async () => undefined),
    };
    return { s: new GuestLinksService(repo as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any), repo };
  };
  const at = (min: number) => ({ starts_at: new Date(Date.now() + min * MIN), expires_at: new Date(Date.now() + 6 * 60 * MIN) });

  it('организатор и соорганизатор входят всегда, даже раньше времени («начать раньше»)', async () => {
    const { s } = svc(at(60));
    expect((await s.meetingAccess('1', 'r', '1', false))?.verdict).toBe('direct');
    expect((await s.meetingAccess('1', 'r', '2', false))).toMatchObject({ verdict: 'direct', host: true });
  });

  it('участник: за час — рано; в раннем окне — ждёт; с начала — сразу (trusted)', async () => {
    expect((await svc(at(60)).s.meetingAccess('1', 'r', '3', false))?.verdict).toBe('early');
    expect((await svc(at(10)).s.meetingAccess('1', 'r', '3', false))?.verdict).toBe('knock');
    expect((await svc(at(10)).s.meetingAccess('1', 'r', '3', true))?.verdict).toBe('direct'); // организатор начал раньше
    expect((await svc(at(-1)).s.meetingAccess('1', 'r', '3', false))?.verdict).toBe('direct');
  });

  it('«нужен организатор» — ждут, пока он не внутри; «зал ожидания» — все через зал', async () => {
    expect((await svc({ ...at(-1), access_policy: 'host_required' }).s.meetingAccess('1', 'r', '3', false))?.verdict).toBe('knock');
    expect((await svc({ ...at(-1), access_policy: 'host_required' }).s.meetingAccess('1', 'r', '3', true))?.verdict).toBe('direct');
    expect((await svc({ ...at(-1), access_policy: 'waiting_room' }).s.meetingAccess('1', 'r', '3', true))?.verdict).toBe('knock');
  });

  it('незваный коллега и отказавшийся — стучатся; отменённая встреча — закрыта', async () => {
    expect((await svc(at(-1)).s.meetingAccess('1', 'r', '5', false))?.verdict).toBe('knock');
    expect((await svc(at(-1)).s.meetingAccess('1', 'r', '4', false))?.verdict).toBe('knock');
    expect((await svc({ ...at(-1), cancelled_at: new Date() }).s.meetingAccess('1', 'r', '3', false))).toMatchObject({ verdict: 'closed', reason: 'cancelled' });
  });

  it('после «Завершить для всех» участник не входит, а организатор, войдя, открывает встречу снова', async () => {
    const ended = svc({ ...at(-30), ended_at: new Date() });
    expect((await ended.s.meetingAccess('1', 'r', '3', false))).toMatchObject({ verdict: 'closed', reason: 'ended' });
    expect((await ended.s.meetingAccess('1', 'r', '1', false))?.verdict).toBe('direct');
    expect(ended.repo.setEnded).toHaveBeenCalledWith('9', false);
  });
});
