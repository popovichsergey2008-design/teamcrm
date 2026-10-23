import { ChatsService } from './chats.service';

/** #4640: пакетная пересылка — порядок, «всё или ничего», доступ к исходному чату. */
describe('Пересылка нескольких сообщений', () => {
  const make = (rows: any[], member = true) => {
    const repo = {
      get: jest.fn(async (_t: string, id: string) => ({ id, kind: 'group', title: `чат ${id}` })),
      isMember: jest.fn(async () => member),
      forwardSources: jest.fn(async () => rows),
      addForwardedBatch: jest.fn(async (i: any) => i.items.map((_: any, k: number) => String(100 + k))),
      messageById: jest.fn(async (id: string) => ({ id, body: `m${id}` })),
      memberIds: jest.fn(async () => ['1', '2']),
      notifyModes: jest.fn(async () => ({})),
    };
    const realtime = { emitToUsers: jest.fn() };
    const push = { chatMessage: jest.fn(async () => undefined) };
    const svc = Object.assign(Object.create(ChatsService.prototype), { repo, realtime, push }) as ChatsService;
    return { svc, repo, realtime, push };
  };
  const user = { userId: '1', role: 'member' };
  const row = (id: string, chat = '10', extra: any = {}) => ({
    id, chat_id: chat, body: `текст ${id}`, author_name: 'Анна', forwarded_author: null, fileIds: [], ...extra,
  });

  it('кладёт по порядку из базы, с автором оригинала и вложениями, одно уведомление', async () => {
    const { svc, repo, realtime, push } = make([
      row('1'), row('2', '10', { forwarded_author: 'Пётр', fileIds: ['7', '8'] }), row('3'),
    ]);
    const r = await svc.forwardMany('t', '10', ['3', '1', '2', '1'], user, '20');
    expect(repo.forwardSources).toHaveBeenCalledWith('t', ['3', '1', '2']);
    const items = (repo.addForwardedBatch.mock.calls[0] as any[])[0].items;
    expect(items.map((x: any) => x.fromId)).toEqual(['1', '2', '3']);
    expect(items.map((x: any) => x.author)).toEqual(['Анна', 'Пётр', 'Анна']);
    expect(items[1].fileIds).toEqual(['7', '8']);
    expect(r.forwarded).toBe(3);
    expect(realtime.emitToUsers).toHaveBeenCalledTimes(3);
    expect(push.chatMessage).toHaveBeenCalledTimes(1);
  });

  it('сообщение из чужого чата отклоняет всю пачку', async () => {
    const { svc, repo } = make([row('1'), row('2', '99')]);
    await expect(svc.forwardMany('t', '10', ['1', '2'], user, '20')).rejects.toThrow(/2/);
    expect(repo.addForwardedBatch).not.toHaveBeenCalled();
  });

  it('без доступа к исходному чату — отказ до чтения сообщений', async () => {
    const { svc, repo } = make([row('1')], false);
    await expect(svc.forwardMany('t', '10', ['1'], user, '20')).rejects.toThrow();
    expect(repo.forwardSources).not.toHaveBeenCalled();
  });

  it('больше лимита — отказ', async () => {
    const { svc } = make([]);
    const ids = Array.from({ length: ChatsService.FORWARD_LIMIT + 1 }, (_, i) => String(i + 1));
    await expect(svc.forwardMany('t', '10', ids, user, '20')).rejects.toThrow();
  });
});
