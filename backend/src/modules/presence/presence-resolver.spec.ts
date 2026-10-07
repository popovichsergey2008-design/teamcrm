import { resolvePresence } from './presence-resolver';

const NOW = new Date('2026-10-07T12:00:00Z');
const later = '2026-10-07T13:00:00Z';
const earlier = '2026-10-07T11:00:00Z';
const base = { online: true, inCall: false, focus: null, manual: null } as const;

describe('resolvePresence: одно состояние из нескольких источников', () => {
  it('никого и ничего — свободен, без сети — не в сети', () => {
    expect(resolvePresence({ ...base }, NOW).status).toBe('available');
    expect(resolvePresence({ ...base, online: false }, NOW).status).toBe('offline');
  });

  it('созвон важнее глубокого фокуса и «занят»', () => {
    const p = resolvePresence({ ...base, inCall: true, manual: 'busy', focus: { kind: 'deep', note: null, taskId: '5', until: later } }, NOW);
    expect(p.status).toBe('in_meeting');
    expect(p.source).toBe('meeting');
  });

  it('глубокий фокус важнее «занят», и время окончания приходит', () => {
    const p = resolvePresence({ ...base, manual: 'busy', focus: { kind: 'deep', note: null, taskId: '5', until: later } }, NOW);
    expect(p.status).toBe('deep_focus');
    expect(p.until).toBe(new Date(later).toISOString());
    expect(p.taskId).toBe('5');
  });

  it('сессия глубокой работы — фокус с её номером', () => {
    const p = resolvePresence({ ...base, session: { id: '9', taskId: '5', plannedEndAt: later } }, NOW);
    expect(p.status).toBe('deep_focus');
    expect(p.focusSessionId).toBe('9');
  });

  it('истёкший фокус не действует сам, без расписания', () => {
    expect(resolvePresence({ ...base, focus: { kind: 'deep', note: null, taskId: null, until: earlier } }, NOW).status).toBe('available');
    expect(resolvePresence({ ...base, session: { id: '9', taskId: null, plannedEndAt: earlier } }, NOW).status).toBe('available');
  });

  it('«занят» руками — не беспокоить; «отошёл» и перерыв — перерыв', () => {
    expect(resolvePresence({ ...base, manual: 'busy' }, NOW).status).toBe('do_not_disturb');
    expect(resolvePresence({ ...base, manual: 'away' }, NOW).status).toBe('break');
    expect(resolvePresence({ ...base, focus: { kind: 'break', note: null, taskId: null, until: later } }, NOW).status).toBe('break');
  });

  it('«созвон» руками — на созвоне, даже без комнаты', () => {
    const p = resolvePresence({ ...base, focus: { kind: 'call', note: 'с клиентом', taskId: null, until: null } }, NOW);
    expect(p.status).toBe('in_meeting');
    expect(p.note).toBe('с клиентом');
  });

  it('работа над задачей — доступен, но видно над чем', () => {
    const p = resolvePresence({ ...base, focus: { kind: 'task', note: 'Отчёт', taskId: '7', until: null } }, NOW);
    expect(p.status).toBe('available');
    expect(p.taskId).toBe('7');
  });

  it('закрытый день — до утра, даже в сети', () => {
    expect(resolvePresence({ ...base, workdayClosedUntil: later }, NOW).status).toBe('workday_closed');
    expect(resolvePresence({ ...base, workdayClosedUntil: earlier }, NOW).status).toBe('available');
  });
});
