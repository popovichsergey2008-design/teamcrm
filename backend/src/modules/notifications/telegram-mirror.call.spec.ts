import { TelegramMirror } from './telegram-mirror.service';

/** #4682: о звонке в Telegram — только тому, кого нет у компьютера, и один раз на вызов. */
describe('TelegramMirror.callInvite', () => {
  const make = (o: { online: boolean; status?: string | null; quiet?: boolean; pref?: boolean }) => {
    const sent: string[] = [];
    const mirror = new TelegramMirror(
      { prefEnabled: async () => o.pref ?? true } as any,
      { chatIdOf: async () => '555' } as any,
      { enabled: true, sendMessage: async (_: string, t: string) => { sent.push(t); } } as any,
      { isQuiet: async () => !!o.quiet } as any,
      { isOnline: () => o.online } as any,
      { one: async () => ({ s: o.status ?? null }) } as any,
    );
    return { mirror, sent };
  };
  const call = { tenantId: '1', userId: '7', meetingId: 'm1', callerName: 'Глеб' };

  it('не в сети — пишем в Telegram', async () => {
    const { mirror, sent } = make({ online: false });
    expect(await mirror.callInvite(call)).toBe(true);
    expect(sent[0]).toContain('Глеб зовёт вас в созвон');
  });

  it('в сети — не дублируем: звонок слышен в приложении', async () => {
    const { mirror, sent } = make({ online: true });
    expect(await mirror.callInvite(call)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('в сети, но «отошёл» — пишем', async () => {
    const { mirror } = make({ online: true, status: 'away' });
    expect(await mirror.callInvite(call)).toBe(true);
  });

  it('один вызов — одно сообщение; глубокая работа и выключенная настройка — молчим', async () => {
    const a = make({ online: false });
    await a.mirror.callInvite(call);
    expect(await a.mirror.callInvite(call)).toBe(false);
    expect(await make({ online: false, quiet: true }).mirror.callInvite(call)).toBe(false);
    expect(await make({ online: false, pref: false }).mirror.callInvite(call)).toBe(false);
  });
});
