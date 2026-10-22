import {
  agreementsLine, clientCodeOf, codeExpiry, CLIENT_CODE_TTL_DAYS, followupSubject, hashClientCode, linkInvite, newClientCode,
  popupText, startLink, telegramMessage,
} from './followup-rules';

describe('итоги клиенту в Telegram (#1525)', () => {
  it('тема — «Итоги встречи DD.MM» по поясу организатора', () => {
    // 5 октября 22:30 UTC — в Москве уже 6 октября
    expect(followupSubject(new Date('2026-10-05T22:30:00Z'), 'Europe/Moscow')).toBe('Итоги встречи 06.10');
    expect(followupSubject(new Date('2026-10-05T22:30:00Z'), 'UTC')).toBe('Итоги встречи 05.10');
    expect(followupSubject(new Date('2026-03-09T10:00:00Z'), 'Нет/Такого')).toBe('Итоги встречи 09.03');
  });

  it('договорённости коротко, как в документе', () => {
    expect(agreementsLine(['Утвердили дизайн.', 'Правки до среды'], [])).toBe('утвердили дизайн, правки до среды.');
  });

  it('договорённости: без «Решили:», первое предложение, имена и сокращения не трогаем', () => {
    expect(agreementsLine(['Решили: запуск 20 октября. Подробности в письме'], [])).toBe('запуск 20 октября.');
    expect(agreementsLine(['Глеб пришлёт смету к пятнице'], [], ['Глеб'])).toBe('Глеб пришлёт смету к пятнице.');
    expect(agreementsLine(['API отдаём в четверг'], [])).toBe('API отдаём в четверг.');
    expect(agreementsLine(['Договорились, что оплата 50/50'], [])).toBe('оплата 50/50.');
  });

  it('договорённости: не больше трёх, без повторов, длинное обрезается по слову', () => {
    expect(agreementsLine(['А1', 'Б2', 'а1', 'В3', 'Г4'], [])).toBe('а1, б2, в3.');
    const long = agreementsLine(['Согласовали полный перечень работ по второму этапу включая интеграцию с банком и мобильное приложение для курьеров'], []);
    expect(long!.length).toBeLessThanOrEqual(81);
    expect(long!.endsWith('…')).toBe(true);
  });

  it('договорённости: пункты с запятыми — через точку с запятой', () => {
    expect(agreementsLine(['Дизайн, тексты утвердили', 'Правки до среды'], [])).toBe('дизайн, тексты утвердили; правки до среды.');
  });

  it('договорённости: решений нет — из поручений со сроками; нечего сказать — null', () => {
    expect(agreementsLine([], [{ title: 'Прислать макеты', deadline: '15.10' }, { title: 'Созвониться с юристом', deadline: null }]))
      .toBe('прислать макеты до 15.10, созвониться с юристом.');
    expect(agreementsLine([], [])).toBeNull();
    expect(agreementsLine(['  ', ''], [])).toBeNull();
  });

  it('окно — дословно по документу', () => {
    expect(popupText('Итоги встречи 06.10', 'утвердили дизайн, правки до среды.')).toEqual([
      'Я подготовил отчет для вашего клиента.',
      'Тема: Итоги встречи 06.10',
      'Договоренности: утвердили дизайн, правки до среды.',
      'Отправить клиенту в Telegram в 1 клик?',
    ]);
    expect(popupText('Итоги встречи 06.10', null)).toHaveLength(3);
  });

  it('сообщение в Telegram: от кого — компания и отправитель, влезает в лимит', () => {
    const t = telegramMessage({ subject: 'Итоги встречи 06.10', company: 'Студия Луч', sender: 'Борис Петров', body: 'Добрый день!' });
    expect(t.startsWith('Итоги встречи 06.10\nОт: Борис Петров, Студия Луч\n\nДобрый день!')).toBe(true);
    expect(t).toContain('от имени компании «Студия Луч» (отправитель — Борис Петров)');
    const big = telegramMessage({ subject: 'Т', company: 'К', sender: 'О', body: 'я'.repeat(9000) });
    expect(big.length).toBeLessThanOrEqual(4096);
  });

  it('код ссылки: 128 бит, в базе только хеш, разный каждый раз', () => {
    const a = newClientCode();
    const b = newClientCode();
    expect(a.code).toMatch(/^c_[A-Za-z0-9_-]{22}$/);
    expect(a.code).not.toBe(b.code);
    expect(a.hash).toBe(hashClientCode(a.code));
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.code.slice(2));
  });

  it('код из «/start …»: только клиентский, код сотрудника не наш', () => {
    const { code } = newClientCode();
    expect(clientCodeOf(`/start ${code}`)).toBe(code);
    expect(clientCodeOf(`/start@qevo_bot ${code}`)).toBe(code);
    expect(clientCodeOf('/start A1B2C3D4E5')).toBeNull();
    expect(clientCodeOf('/start')).toBeNull();
    expect(clientCodeOf(code)).toBeNull();
    expect(clientCodeOf('/start c_short')).toBeNull();
  });

  it('код живёт 14 дней; ссылка и приглашение', () => {
    const now = new Date('2026-10-22T10:00:00Z');
    expect(CLIENT_CODE_TTL_DAYS).toBe(14);
    expect(codeExpiry(now).toISOString()).toBe('2026-11-05T10:00:00.000Z');
    const url = startLink('qevo_bot', 'c_abc');
    expect(url).toBe('https://t.me/qevo_bot?start=c_abc');
    expect(linkInvite('Итоги встречи 06.10', url)).toContain('Итоги встречи 06.10 — в Telegram: https://t.me/qevo_bot?start=c_abc');
  });
});
