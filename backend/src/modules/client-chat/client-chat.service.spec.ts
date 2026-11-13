import { createHash } from 'crypto';
import { ClientChatService } from './client-chat.service';

/**
 * Проверка прав гостя чата с клиентом на уровне службы (#4902, п. 15): гость читает
 * и пишет только свой чат, с отозванной ссылкой или после удаления — ничего.
 */
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const KEY = 'k'.repeat(32);
const future = new Date(Date.now() + 86400_000);

function make(over: { session?: Record<string, unknown> | null; removed?: boolean } = {}) {
  const session = over.session === null ? null : {
    id: '1', tenant_id: '1', link_id: '5', chat_id: '10', gid: '00000000-0000-0000-0000-000000000001', name: 'Иван',
    expires_at: future, revoked_at: null, link_revoked_at: null, link_expires_at: future, chat_external: true,
    chat_title: 'Вектор', org_name: 'Компания', ...(over.session ?? {}),
  };
  const repo = {
    sessionByHash: jest.fn(async (h: string) => (h === sha(KEY) ? session : null)),
    touchSession: jest.fn(async () => undefined),
    guestMessages: jest.fn(async (_t: string, chatId: string) => [
      { id: '1', chat_id: chatId, author_id: '3', author_name: 'Анна', body: 'Добрый день', created_at: new Date() },
      // если запрос когда-нибудь вернёт чужое — второй рубеж его отбросит
      { id: '2', chat_id: '77', author_id: '3', author_name: 'Анна', body: 'внутреннее', created_at: new Date() },
      { id: '3', chat_id: chatId, author_id: null, body: 'Кто отвечает: Борис', is_ai: true, created_at: new Date() },
    ]),
    openedTasks: jest.fn(async () => [{ id: '9', title: 'Макет', stage_type: 'done', closed_at: null, deadline_at: null, project_id: '2' }]),
    link: jest.fn(),
  };
  const chats = {
    guestRemoved: jest.fn(async () => !!over.removed),
    guestSend: jest.fn(async (_t: string, chatId: string, name: string, body: string) => ({ id: '50', chat_id: chatId, author_id: null, guest_name: name, body, created_at: new Date() })),
    recordGuest: jest.fn(),
  };
  const svc = new ClientChatService(repo as never, chats as never, {} as never, {} as never, {} as never, {} as never, { get: () => undefined } as never);
  return { svc, repo, chats };
}

describe('ClientChatService — права гостя', () => {
  it('гость читает только свой чат и не видит внутреннего', async () => {
    const { svc, repo } = make();
    const feed = await svc.messages(KEY);
    expect(repo.guestMessages).toHaveBeenCalledWith('1', '10', null, 50);
    expect(feed.map((m) => m.body)).toEqual(['Добрый день']);
  });

  it('пишет только в свой чат и от своего имени', async () => {
    const { svc, chats } = make();
    const m = await svc.send(KEY, '  Когда будет макет?  ');
    expect(chats.guestSend).toHaveBeenCalledWith('1', '10', 'Иван', 'Когда будет макет?');
    expect(m).toMatchObject({ mine: true, body: 'Когда будет макет?' });
  });

  it('статусы — только открытые задачи, без номеров', async () => {
    const { svc } = make();
    const r = await svc.tasks(KEY);
    expect(r.tasks).toEqual([{ title: 'Макет', status: 'done', statusLabel: 'Готово', deadline: null, overdue: false }]);
  });

  it('чужой или пустой ключ — 401', async () => {
    const { svc, repo } = make();
    await expect(svc.messages('x'.repeat(32))).rejects.toThrow();
    await expect(svc.messages('')).rejects.toThrow();
    expect(repo.guestMessages).not.toHaveBeenCalled();
  });

  it('ссылку отозвали — ни читать, ни писать', async () => {
    const { svc, repo, chats } = make({ session: { link_revoked_at: new Date() } });
    await expect(svc.messages(KEY)).rejects.toThrow(/отозвали/);
    await expect(svc.send(KEY, 'привет')).rejects.toThrow(/отозвали/);
    expect(repo.guestMessages).not.toHaveBeenCalled();
    expect(chats.guestSend).not.toHaveBeenCalled();
  });

  it('гостя убрали из чата — доступа нет сразу', async () => {
    const { svc, chats } = make({ removed: true });
    await expect(svc.send(KEY, 'привет')).rejects.toThrow(/удалили/);
    expect(chats.guestSend).not.toHaveBeenCalled();
  });

  it('чат сделали внутренним — доступ по ссылке закрыт', async () => {
    const { svc } = make({ session: { chat_external: false } });
    await expect(svc.tasks(KEY)).rejects.toThrow(/недоступен/);
  });
});
