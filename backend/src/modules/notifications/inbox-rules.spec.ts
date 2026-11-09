import { groupInbox, inboxKind, InboxRowLite, validSnooze } from './inbox-rules';

const row = (id: string, eventKey: string, at: string, extra: Partial<InboxRowLite> = {}): InboxRowLite => ({
  id, event_key: eventKey, title: `t${id}`, body: '', path: null, created_at: new Date(at), read_at: null,
  task_id: '1220', task_title: 'Сворачивание таблицы', project_id: '130', actor_name: null, details: null, ...extra,
});

describe('#4807 §6 — «Входящие»', () => {
  it('тип по событию: решение, упоминание, назначено, ИИ, созвон, шум', () => {
    expect(inboxKind('task.approval')).toBe('decision');
    expect(inboxKind('chat.mention')).toBe('mention');
    expect(inboxKind('task.assignee')).toBe('assigned');
    expect(inboxKind('assistant.proposal')).toBe('ai');
    expect(inboxKind('meeting.postcall')).toBe('meeting');
    expect(inboxKind('task.commented')).toBe('comment');
    expect(inboxKind('task.status')).toBe('change');
    expect(inboxKind('support.reply')).toBe('system');
  });

  it('5 комментариев к задаче за сутки — одна строка с авторами', () => {
    const g = groupInbox([
      row('9', 'task.commented', '2026-11-09T12:00:00Z', { actor_name: 'Сергей' }),
      row('8', 'task.commented', '2026-11-09T11:00:00Z', { actor_name: 'Анна', read_at: new Date() }),
      row('7', 'task.commented', '2026-11-09T10:00:00Z', { actor_name: 'Сергей' }),
      row('6', 'task.commented', '2026-11-09T09:00:00Z', { actor_name: 'Анна' }),
      row('5', 'task.commented', '2026-11-09T08:00:00Z', { actor_name: 'Глеб' }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ count: 5, ids: ['9', '8', '7', '6', '5'], actors: ['Сергей', 'Анна', 'Глеб'], unread: true });
    expect(g[0].title).toBe('5 новых комментариев к #1220');
  });

  it('упоминания не склеиваются; старше суток — новая строка', () => {
    const g = groupInbox([
      row('3', 'task.mention', '2026-11-09T12:00:00Z'),
      row('2', 'task.mention', '2026-11-09T11:00:00Z'),
      row('1', 'task.commented', '2026-11-09T10:00:00Z'),
      row('0', 'task.commented', '2026-11-07T10:00:00Z'),
    ]);
    expect(g.map((x) => x.ids)).toEqual([['3'], ['2'], ['1'], ['0']]);
  });

  it('отложить — только в будущее и не дальше года', () => {
    const now = new Date('2026-11-09T10:00:00Z');
    expect(validSnooze(new Date('2026-11-09T11:00:00Z'), now)).toBe(true);
    expect(validSnooze(new Date('2026-11-09T09:00:00Z'), now)).toBe(false);
    expect(validSnooze(new Date('2028-01-01T00:00:00Z'), now)).toBe(false);
    expect(validSnooze(new Date('nope'), now)).toBe(false);
  });
});

describe('#4807 §6.5 — тишина и настройки по типам', () => {
  const { modeAllowed, pushAllowed, offWhere } = jest.requireActual('./inbox-rules');
  it('решения и упоминания отключить нельзя — только убрать push', () => {
    expect(modeAllowed('decision', 'off')).toBe(false);
    expect(modeAllowed('mention', 'off')).toBe(false);
    expect(modeAllowed('mention', 'inbox')).toBe(true);
    expect(modeAllowed('comment', 'off')).toBe(true);
  });
  it('push — только если тип в режиме «Входящие и push»', () => {
    const modes = new Map([['comment', 'inbox'], ['change', 'off'], ['mention', 'push']]);
    expect(pushAllowed('task.commented', modes)).toBe(false);
    expect(pushAllowed('task.status', modes)).toBe(false);
    expect(pushAllowed('task.mention', modes)).toBe(true);
    expect(pushAllowed('task.assignee', modes)).toBe(true);
    expect(pushAllowed('chat.message', modes)).toBe(true);
  });
  it('выключенные типы — условием SQL; ничего не выключено — TRUE', () => {
    const p: unknown[] = [];
    expect(offWhere([], p)).toBe('TRUE');
    const sql = offWhere(['comment', 'meeting', 'system'], p);
    expect(sql).toContain("NOT LIKE 'meeting.%'");
    expect(p[0]).toEqual(['task.commented']);
    expect(sql).toContain('$2::text[]');
  });
});
