import { trialVerdict } from './ai-trial';

const day = 86_400_000;
const now = new Date('2026-10-30T12:00:00Z');
const ago = (d: number) => new Date(now.getTime() - d * day);

describe('trialVerdict — общий ключ ИИ на пробный период', () => {
  it('новая компания: две недели и до лимита токенов', () => {
    const v = trialVerdict({ isPlatform: false, tenantCreatedAt: ago(3), planTrial: null, tokensUsed: 200_000 }, now, 14, 1_000_000);
    expect(v).toMatchObject({ allowed: true, reason: 'trial', tokensLimit: 1_000_000 });
    expect(v.endsAt!.getTime()).toBe(ago(3).getTime() + 14 * day);
  });

  it('срок вышел или токены кончились — общим ключом нельзя', () => {
    expect(trialVerdict({ isPlatform: false, tenantCreatedAt: ago(15), planTrial: null, tokensUsed: 0 }, now).reason).toBe('expired');
    expect(trialVerdict({ isPlatform: false, tenantCreatedAt: ago(1), planTrial: null, tokensUsed: 1_000_000 }, now, 14, 1_000_000).reason).toBe('exhausted');
  });

  it('площадка вендора — без срока и потолка', () => {
    const v = trialVerdict({ isPlatform: true, tenantCreatedAt: ago(400), planTrial: null, tokensUsed: 9e9 }, now);
    expect(v).toMatchObject({ allowed: true, reason: 'platform', tokensLimit: null, endsAt: null });
  });

  it('продление вендором: окно и счёт — от начала продления', () => {
    const v = trialVerdict({
      isPlatform: false, tenantCreatedAt: ago(60),
      planTrial: { startedAt: ago(2), endsAt: new Date(now.getTime() + 12 * day) }, tokensUsed: 10,
    }, now);
    expect(v).toMatchObject({ allowed: true, reason: 'trial' });
    expect(v.windowStart.getTime()).toBe(ago(2).getTime());
  });

  it('пробный «Расширенный» короче своего окна — окно своё', () => {
    const created = ago(5);
    const v = trialVerdict({
      isPlatform: false, tenantCreatedAt: created,
      planTrial: { startedAt: created, endsAt: new Date(created.getTime() + 7 * day) }, tokensUsed: 0,
    }, now, 14);
    expect(v.endsAt!.getTime()).toBe(created.getTime() + 14 * day);
  });
});
