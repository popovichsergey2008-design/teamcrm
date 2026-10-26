import { isServiceEmail, telegramServiceEmail } from './service-email';

describe('служебная почта (#4619)', () => {
  it('адрес по Telegram ID — только цифры', () => {
    expect(telegramServiceEmail(123456789)).toBe('tg123456789@users.qevo.one');
    expect(telegramServiceEmail('12a3')).toBe('tg123@users.qevo.one');
  });
  it('узнаёт заглушку, но не настоящие адреса', () => {
    expect(isServiceEmail('TG1@Users.Qevo.One')).toBe(true);
    expect(isServiceEmail('boss@qevo.one')).toBe(false);
    expect(isServiceEmail('x@notusers.qevo.one')).toBe(false);
    expect(isServiceEmail(null)).toBe(false);
  });
});
