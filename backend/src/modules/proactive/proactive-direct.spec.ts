import { ProactiveService } from './proactive.service';
import { NewProposal } from './proactive.repository';

/**
 * #4665: «Задача поставлена от вас» — ответ на действие самого человека. Он доходит
 * всегда: мимо выключенного секретаря, «больше не предлагать» и дневного лимита,
 * со строкой в центре уведомлений и всплывашкой; push и Telegram — вне тихих часов.
 */
describe('ProactiveService: прямое сообщение (#4665)', () => {
  const row = {
    id: '9', tenant_id: '1', user_id: '5', title: 'Задача поставлена от вас: #42 «Форма»',
    summary: '• Тег: Баг\n• Проект: Сайт\n• Исполнитель: Глеб', why: '', priority: 1,
  };
  const make = (o: { enabled?: boolean; level?: string; quiet?: boolean; muted?: boolean; telegram?: boolean } = {}) => {
    const repo = {
      tenantSettings: jest.fn().mockResolvedValue({ enabled: o.enabled ?? true, telegramDelivery: o.telegram ?? true }),
      prefs: jest.fn().mockResolvedValue({ level: o.level ?? 'normal', dailyLimit: 12 }),
      muted: jest.fn().mockResolvedValue(o.muted ?? false),
      insert: jest.fn().mockResolvedValue(row),
      markNotified: jest.fn().mockResolvedValue(undefined),
      notifiedSince: jest.fn().mockResolvedValue(999),
      timezoneOf: jest.fn().mockResolvedValue('Europe/Moscow'),
    };
    const realtime = { emitToUsers: jest.fn() };
    const inbox = { isQuiet: jest.fn().mockResolvedValue(o.quiet ?? false) };
    const push = { personal: jest.fn().mockResolvedValue(true) };
    const telegram = { push: jest.fn().mockResolvedValue(true) };
    const svc = new ProactiveService(repo as any, realtime as any, inbox as any, push as any, telegram as any, {} as any);
    return { svc, repo, realtime, push, telegram };
  };
  const proposal = (direct: boolean): NewProposal => ({
    tenantId: '1', userId: '5', skill: 'autotask', kind: 'confirm', sourceType: 'task', sourceId: '42',
    title: row.title, summary: row.summary, priority: 1, confidence: 0.95, actions: [], fingerprint: 'fp',
    ...(direct ? { direct: { eventKey: 'task.auto_confirm', taskId: '42', short: 'Тег: Баг · Проект: Сайт · Исполнитель: Глеб', fields: [['Тег', 'Баг']] as [string, string][] } } : {}),
  });

  it('доходит даже при выключенном секретаре, «не беспокоить» и «больше не предлагать»', async () => {
    const { svc, repo, push } = make({ enabled: false, level: 'off', muted: true });
    expect(await svc.propose(proposal(true))).toBe(row);
    expect(repo.insert).toHaveBeenCalled();
    expect(repo.muted).not.toHaveBeenCalled();
    expect(push.personal).toHaveBeenCalledWith(expect.objectContaining({
      eventKey: 'task.auto_confirm', title: row.title, body: 'Тег: Баг · Проект: Сайт · Исполнитель: Глеб',
      path: '/secretary/9', push: true, toast: true, taskId: '42', details: { fields: [['Тег', 'Баг']] },
    }));
  });

  it('обычная подсказка при выключенном секретаре по-прежнему молчит', async () => {
    const { svc, repo, push } = make({ enabled: false });
    expect(await svc.propose(proposal(false))).toBeNull();
    expect(repo.insert).not.toHaveBeenCalled();
    expect(push.personal).not.toHaveBeenCalled();
  });

  it('дневной лимит подсказок исчерпан — прямое сообщение всё равно приходит с push и Telegram', async () => {
    const { svc, push, telegram } = make();
    await svc.propose(proposal(true));
    expect(push.personal).toHaveBeenCalledWith(expect.objectContaining({ push: true, toast: true }));
    expect(telegram.push).toHaveBeenCalledWith('1', '5', `✦ ${row.title}\n\n${row.summary}`);
  });

  it('тихие часы — строка в центре и всплывашка есть, push на телефон и Telegram — нет', async () => {
    const { svc, push, telegram } = make({ quiet: true });
    await svc.propose(proposal(true));
    expect(push.personal).toHaveBeenCalledWith(expect.objectContaining({ push: false, toast: true }));
    expect(telegram.push).not.toHaveBeenCalled();
  });

  it('повтор с тем же отпечатком — ничего не шлём', async () => {
    const { svc, repo, push } = make();
    repo.insert.mockResolvedValueOnce(null);
    expect(await svc.propose(proposal(true))).toBeNull();
    expect(push.personal).not.toHaveBeenCalled();
  });
});
