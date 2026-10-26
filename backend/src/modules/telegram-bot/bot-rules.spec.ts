import { decideDemo, hashCode, loginUrl, looksLikeLoginCode, newLoginCode, routeUpdate, sourceLabel, trialDaysLeft } from './bot-rules';
import { appButton, daysLeftText, welcome } from './bot-texts';

const msg = (m: Record<string, unknown>) => ({ update_id: 1, message: { message_id: 1, from: { id: 42, first_name: 'Аня' }, chat: { id: 42, type: 'private' }, ...m } });

describe('диспетчер бота (#4619)', () => {
  it('кнопки: свои — боту, остальные — дейлику', () => {
    expect(routeUpdate({ callback_query: { id: '1', data: 'b:ex', from: { id: 1 } } }, false)).toEqual({ kind: 'bot_callback', data: 'b:ex' });
    expect(routeUpdate({ callback_query: { id: '1', data: 'confirm:5', from: { id: 1 } } }, true).kind).toBe('standup_callback');
  });

  it('/start: клиентская ссылка, код привязки, метка, без метки', () => {
    expect(routeUpdate(msg({ text: '/start c_AbC123' }), false).kind).toBe('client_start');
    expect(routeUpdate(msg({ text: '/start 0A1B2C3D4E' }), false)).toEqual({ kind: 'link_code', code: '0A1B2C3D4E' });
    expect(routeUpdate(msg({ text: '/start site' }), false)).toEqual({ kind: 'start', label: 'site' });
    expect(routeUpdate(msg({ text: '/start' }), true)).toEqual({ kind: 'start', label: null });
    expect(routeUpdate(msg({ text: '/start <script>' }), false)).toEqual({ kind: 'start', label: null });
  });

  it('привязанный: /start — приветствие, остальное — дейлик как раньше', () => {
    expect(routeUpdate(msg({ text: '#12 сделал, 30 минут' }), true).kind).toBe('staff');
    expect(routeUpdate(msg({ voice: { file_id: 'v', duration: 3 } }), true).kind).toBe('staff');
    expect(routeUpdate(msg({ text: '/login' }), true).kind).toBe('login');
  });

  it('непривязанный: код текстом, демо-текст, пересылка, голос, прочее', () => {
    expect(routeUpdate(msg({ text: 'abcdef1234' }), false).kind).toBe('link_code');
    expect(routeUpdate(msg({ text: 'Дима, сделай отчёт' }), false)).toEqual({ kind: 'demo_text', text: 'Дима, сделай отчёт', forwarded: false });
    expect(routeUpdate(msg({ text: 'Пришлите счёт', forward_origin: { type: 'user' } }), false))
      .toEqual({ kind: 'demo_text', text: 'Пришлите счёт', forwarded: true });
    expect(routeUpdate(msg({ voice: { file_id: 'v1', duration: 7 } }), false)).toEqual({ kind: 'demo_voice', fileId: 'v1', duration: 7 });
    expect(routeUpdate(msg({ sticker: {} }), false).kind).toBe('unsupported');
  });

  it('группы и боты — мимо', () => {
    expect(routeUpdate({ message: { from: { id: 1 }, chat: { id: -5, type: 'group' }, text: 'x' } }, false).kind).toBe('ignore');
    expect(routeUpdate({ message: { from: { id: 1, is_bot: true }, chat: { id: 1 }, text: 'x' } }, false).kind).toBe('ignore');
    expect(routeUpdate({}, false).kind).toBe('ignore');
  });

  it('метка источника', () => {
    expect(sourceLabel('Site')).toBe('site');
    expect(sourceLabel('промо')).toBeNull();
    expect(sourceLabel('')).toBeNull();
  });
});

describe('лимиты демо', () => {
  const base = { kind: 'text' as const, userToday: 0, userLimit: 5, aiToday: 0, aiBudget: 100, hasModel: true, hasStt: true };
  it('лимит на человека — для всего', () => {
    expect(decideDemo({ ...base, userToday: 5 })).toEqual({ ok: false, why: 'user_limit' });
  });
  it('общий бюджет: текст — правилами, голос — просим текстом', () => {
    expect(decideDemo({ ...base, aiToday: 100 })).toEqual({ ok: true, mode: 'rules' });
    expect(decideDemo({ ...base, kind: 'voice', aiToday: 100 })).toEqual({ ok: false, why: 'voice_unavailable' });
  });
  it('без ключа: текст правилами, голос нельзя; длинный голос — отказ', () => {
    expect(decideDemo({ ...base, hasModel: false })).toEqual({ ok: true, mode: 'rules' });
    expect(decideDemo({ ...base, kind: 'voice', hasStt: false })).toEqual({ ok: false, why: 'voice_unavailable' });
    expect(decideDemo({ ...base, kind: 'voice', voiceSeconds: 121 })).toEqual({ ok: false, why: 'voice_too_long' });
    expect(decideDemo({ ...base, kind: 'voice', voiceSeconds: 30 })).toEqual({ ok: true, mode: 'ai' });
  });
});

describe('вход без пароля и пробный период', () => {
  it('код случайный, в базе — хеш, ссылка с кодом', () => {
    const a = newLoginCode(); const b = newLoginCode();
    expect(a).not.toBe(b);
    expect(looksLikeLoginCode(a)).toBe(true);
    expect(looksLikeLoginCode('x')).toBe(false);
    expect(looksLikeLoginCode(123)).toBe(false);
    expect(hashCode(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode(a)).not.toContain(a);
    expect(loginUrl('https://app.qevo.one/', a)).toBe(`https://app.qevo.one/?tglogin=${a}`);
  });
  it('осталось N дней', () => {
    const now = new Date('2026-10-26T10:00:00Z');
    expect(trialDaysLeft('2026-11-09T10:00:00Z', now)).toBe(14);
    expect(trialDaysLeft('2026-10-26T11:00:00Z', now)).toBe(1);
    expect(trialDaysLeft('2026-10-20T10:00:00Z', now)).toBe(0);
    expect(trialDaysLeft(null, now)).toBeNull();
    expect(daysLeftText(14)).toBe('осталось 14 дней');
    expect(daysLeftText(1)).toBe('остался 1 день');
    expect(daysLeftText(3)).toBe('осталось 3 дня');
    expect(daysLeftText(0)).toBe('закончился');
  });
});

describe('кнопки', () => {
  it('Mini App — web_app только по https, иначе обычная ссылка', () => {
    expect(appButton('A', 'https://app.qevo.one/tg/board')).toEqual({ text: 'A', web_app: { url: 'https://app.qevo.one/tg/board' } });
    expect(appButton('A', 'http://localhost/tg/board')).toEqual({ text: 'A', url: 'http://localhost/tg/board' });
  });
  it('приветствие — текст ТЗ и три кнопки', () => {
    const w = welcome('https://app.qevo.one');
    expect(w.text.startsWith('Привет! Я ИИ-помощник QEVO.')).toBe(true);
    expect(w.markup.inline_keyboard.map((r) => r[0].text)).toEqual([
      'Проверить на готовом примере', 'Открыть демо-доску QEVO (Mini App)', 'Перенести доски из Битрикс24 / YouGile',
    ]);
    expect(JSON.stringify(w.markup)).toContain('/tg/board?demo=1');
  });
});
