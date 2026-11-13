import { answerFrom, acceptedText, ASK_MIN_INTENT, askText, shouldAsk } from './ask-rules';

const base = {
  type: 'task', status: 'needs_clarification', intentConfidence: 0.95,
  asked: false, missing: ['проект'], working: true, enabled: true,
};

describe('спрашивать ли в чате', () => {
  it('спрашиваем, когда это точно поручение и не хватает проекта или исполнителя', () => {
    expect(shouldAsk(base)).toBe(true);
    expect(shouldAsk({ ...base, missing: ['исполнитель'] })).toBe(true);
  });

  it('о готовом поручении не спрашиваем', () => {
    expect(shouldAsk({ ...base, status: 'ready', missing: [] })).toBe(false);
  });

  it('не спрашиваем, когда сами не уверены, что это поручение', () => {
    // «А не задача ли это?» — вопрос, на который никто не отвечает.
    expect(shouldAsk({ ...base, intentConfidence: ASK_MIN_INTENT - 0.01 })).toBe(false);
  });

  it('о решении, встрече и идее в чате не спрашиваем', () => {
    for (const type of ['decision', 'meeting', 'idea', 'question', 'status', 'blocker']) {
      expect(shouldAsk({ ...base, type })).toBe(false);
    }
  });

  it('второй раз про одно и то же не спрашиваем: молчание — тоже ответ', () => {
    expect(shouldAsk({ ...base, asked: true })).toBe(false);
  });

  it('ночью и в выходной молчим', () => {
    expect(shouldAsk({ ...base, working: false })).toBe(false);
  });

  it('выключенные владельцем вопросы не задаём', () => {
    expect(shouldAsk({ ...base, enabled: false })).toBe(false);
  });

  it('про отмену в разговоре в чате не переспрашиваем', () => {
    // Это не то, что человек ответит одним словом; разбираем сами.
    expect(shouldAsk({ ...base, missing: ['в разговоре есть отмена'] })).toBe(false);
  });
});

describe('текст вопроса', () => {
  it('спрашивает об обоих полях одним сообщением и показывает пример', () => {
    const t = askText({
      who: 'Ольга', title: 'Переделать выгрузку', needProject: true, needAssignee: true,
      projectNames: ['Панорама складов', 'Сайт «Ромашка»'],
    });
    expect(t).toContain('Ольга,');
    expect(t).toContain('к какому проекту это относится и кто это сделает');
    expect(t).toContain('Панорама складов');
    // Обещание не приставать должно стоять прямо в вопросе.
    expect(t).toContain('Спрошу один раз');
  });

  it('спрашивает только о том, чего не хватает', () => {
    const t = askText({ who: null, title: 'Отчёт', needProject: false, needAssignee: true, projectNames: ['А'] });
    expect(t).toContain('кто это сделает');
    expect(t).not.toContain('к какому проекту');
    // Примера проектов в вопросе про исполнителя быть не должно.
    expect(t).not.toContain('«А»');
  });
});

describe('подтверждение ответа', () => {
  it('готовое поручение называет готовым', () => {
    const t = acceptedText({ title: 'Отчёт', projectName: 'Склад', assigneeName: 'Юрий', ready: true });
    expect(t).toContain('проект «Склад»');
    expect(t).toContain('исполнитель Юрий');
    expect(t).toContain('готово');
  });

  it('если и после ответа чего-то нет — не обещаем лишнего', () => {
    const t = acceptedText({ title: 'Отчёт', projectName: 'Склад', assigneeName: null, ready: false });
    expect(t).toContain('всё ещё чего-то не хватает');
  });
});

describe('отменённое поручение', () => {
  it('о нём не спрашиваем, даже если не хватает проекта', () => {
    expect(shouldAsk({ ...base, missing: ['в разговоре есть отмена', 'проект'] })).toBe(false);
  });
});

describe('#4895: что считать ответом на вопрос агента', () => {
  const asked = new Date('2026-11-12T08:00:00Z');
  const m = (body: string, min: number, extra: Partial<{ author_id: string; reply_to_id: string; is_ai: boolean }> = {}) => ({
    author_id: '7', is_ai: false, reply_to_id: null, body, created_at: new Date(asked.getTime() + min * 60_000), ...extra,
  });
  it('короткая первая реплика — ответ', () => {
    expect(answerFrom([m('QEVO, Борис', 5)], { questionId: '1', askedAt: asked, authorId: '7' })).toBe('QEVO, Борис');
  });
  it('вопрос другого разговора через полдня с именем — не ответ', () => {
    expect(answerFrom([m('что-то напоминалка не работает. а у тебя @Boris Chest что-то писало?', 380)], { questionId: '1', askedAt: asked, authorId: '7' })).toBeNull();
  });
  it('прямой ответ на вопрос — ответ, даже поздно', () => {
    expect(answerFrom([m('проект QEVO', 600, { reply_to_id: '1' })], { questionId: '1', askedAt: asked, authorId: '7' })).toBe('проект QEVO');
  });
  it('реплика не того человека — не ответ', () => {
    expect(answerFrom([m('QEVO', 5, { author_id: '8' })], { questionId: '1', askedAt: asked, authorId: '7' })).toBeNull();
  });
});
