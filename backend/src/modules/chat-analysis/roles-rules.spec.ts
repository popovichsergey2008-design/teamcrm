import { missingParts, resolveRoles, SourceAuthor, taskReadiness, THRESHOLDS } from './roles-rules';

const src = (messageId: string, role: string, authorId: string | null): SourceAuthor =>
  ({ messageId, role: role as SourceAuthor['role'], authorId });

const OLGA = '7';
const PETR = '18';

describe('кто поручил и кому', () => {
  it('прямое поручение: постановщик — автор сообщения с поручением', () => {
    // «Пётр, исправь API» — писала Ольга, имя Петра в переписке прозвучало.
    const r = resolveRoles({
      sources: [src('1', 'instruction', OLGA)], modelAssigneeId: PETR, namedInText: PETR,
    });
    expect(r).toMatchObject({ assignerId: OLGA, assigneeId: PETR, pattern: 'named' });
    expect(r.assignerConfidence).toBeGreaterThanOrEqual(THRESHOLDS.assigner);
  });

  it('«ок, беру» сильнее любого имени: работу взял тот, кто согласился', () => {
    /*
      «Нужно переделать таблицу» (Ольга) → «Ок, беру» (Пётр). Модель может считать
      исполнителем кого угодно — решает авторство согласия.
    */
    const r = resolveRoles({
      sources: [src('1', 'instruction', OLGA), src('2', 'acceptance', PETR)],
      modelAssigneeId: OLGA,
    });
    expect(r).toMatchObject({ assignerId: OLGA, assigneeId: PETR, pattern: 'accepted' });
    expect(r.assigneeConfidence).toBeGreaterThanOrEqual(THRESHOLDS.assignee);
  });

  it('согласие того же человека не делает его исполнителем чужой работы', () => {
    // Ольга сама себе поддакнула — исполнителем остаётся тот, кого назвали.
    const r = resolveRoles({
      sources: [src('1', 'instruction', OLGA), src('2', 'acceptance', OLGA)],
      modelAssigneeId: PETR, namedInText: PETR,
    });
    expect(r).toMatchObject({ assigneeId: PETR, pattern: 'named' });
  });

  it('задача себе: постановщик и исполнитель — один человек', () => {
    const r = resolveRoles({ sources: [src('1', 'instruction', PETR)], modelAssigneeId: PETR });
    expect(r).toMatchObject({ assignerId: PETR, assigneeId: PETR, pattern: 'self' });
  });

  it('без сообщения с поручением постановщика не выдумываем', () => {
    // Разговор есть, поручения в нём нет: назначать кого-то начальником нельзя.
    const r = resolveRoles({
      sources: [src('1', 'context', OLGA), src('2', 'decision', PETR)],
      modelAssigneeId: PETR,
    });
    expect(r).toMatchObject({ assignerId: null, assigneeId: null, pattern: 'unknown' });
    expect(r.assignerConfidence).toBe(0);
  });

  it('поручение от бота постановщиком не делает никого', () => {
    const r = resolveRoles({ sources: [src('1', 'instruction', null)], modelAssigneeId: PETR });
    expect(r.assignerId).toBeNull();
  });

  it('поручение есть, исполнителя нет — так и говорим, а не подбираем по навыкам', () => {
    const r = resolveRoles({ sources: [src('1', 'instruction', OLGA)], modelAssigneeId: null });
    expect(r).toMatchObject({ assignerId: OLGA, assigneeId: null, pattern: 'unknown' });
    expect(r.assigneeConfidence).toBe(0);
  });

  it('исполнителя, которого в переписке никто не называл, не назначаем', () => {
    /*
      Живая проверка 29.09: в разговоре «надо переделать выгрузку остатков» имён не было
      вовсе, а модель сама подобрала бэкендщика по профилю. Подбор по навыкам — отдельное
      решение, и выдавать его за прочитанное нельзя: спросим.
    */
    const r = resolveRoles({
      sources: [src('1', 'instruction', OLGA)], modelAssigneeId: PETR, namedInText: null,
    });
    expect(r).toMatchObject({ assignerId: OLGA, assigneeId: null, pattern: 'unknown' });
  });

  it('модель назвала одного, а в переписке звучал другой — не верим модели', () => {
    const r = resolveRoles({
      sources: [src('1', 'instruction', OLGA)], modelAssigneeId: PETR, namedInText: '99',
    });
    expect(r.assigneeId).toBeNull();
  });

  it('задача себе не требует имени в тексте: «я подготовлю отчёт»', () => {
    const r = resolveRoles({
      sources: [src('1', 'instruction', PETR)], modelAssigneeId: PETR, namedInText: null,
    });
    expect(r).toMatchObject({ assigneeId: PETR, pattern: 'self' });
  });

  it('отмену в разговоре замечаем', () => {
    const r = resolveRoles({
      sources: [src('1', 'instruction', OLGA), src('2', 'cancellation', OLGA)],
      modelAssigneeId: PETR, namedInText: PETR,
    });
    expect(r.cancelled).toBe(true);
  });
});

describe('готовность поручения', () => {
  const full = {
    projectId: '130', assigneeId: PETR, assignerId: OLGA, cancelled: false,
    confidence: { intent: 0.95, project: 0.95, assigner: 0.95, assignee: 0.95 },
  };

  it('всё на месте — готово', () => {
    expect(taskReadiness(full)).toBe('ready');
  });

  it('без проекта, исполнителя или постановщика — нужно уточнить', () => {
    expect(taskReadiness({ ...full, projectId: null })).toBe('needs_clarification');
    expect(taskReadiness({ ...full, assigneeId: null })).toBe('needs_clarification');
    expect(taskReadiness({ ...full, assignerId: null })).toBe('needs_clarification');
  });

  it('низкая уверенность по любому полю снимает готовность', () => {
    expect(taskReadiness({ ...full, confidence: { ...full.confidence, assigner: 0.9 } }))
      .toBe('needs_clarification');
    expect(taskReadiness({ ...full, confidence: { ...full.confidence, project: 0.5 } }))
      .toBe('needs_clarification');
  });

  it('отменённое поручение готовым не бывает, даже когда поля заполнены', () => {
    // Последнее слово в разговоре было «не делай» — это важнее заполненности.
    expect(taskReadiness({ ...full, cancelled: true })).toBe('needs_clarification');
  });

  it('чего не хватает — говорим словами', () => {
    expect(missingParts({ projectId: null, assigneeId: null, assignerId: OLGA, cancelled: false }))
      .toEqual(['проект', 'исполнитель']);
    expect(missingParts({ projectId: '1', assigneeId: PETR, assignerId: OLGA, cancelled: true }))
      .toEqual(['в разговоре есть отмена']);
  });
});

describe('финальное состояние разговора', () => {
  it('«Юра, сделай — нет, пусть Глеб возьмёт»: исполнитель Глеб', () => {
    const r = resolveRoles({
      sources: [src('1', 'instruction', '10'), src('2', 'correction', '10')],
      modelAssigneeId: '20',
      namedIds: ['20', '30'],
      correction: { messageId: '2', assigneeId: '30' },
    });
    expect(r.assigneeId).toBe('30');
    expect(r.assignerId).toBe('10');
  });

  it('согласие после правки побеждает правку', () => {
    const r = resolveRoles({
      sources: [src('1', 'instruction', '10'), src('2', 'correction', '10'), src('3', 'acceptance', '40')],
      modelAssigneeId: null,
      correction: { messageId: '2', assigneeId: '30' },
    });
    expect(r.assigneeId).toBe('40');
  });

  it('правка после согласия побеждает согласие', () => {
    const r = resolveRoles({
      sources: [src('1', 'instruction', '10'), src('2', 'acceptance', '20'), src('3', 'correction', '10')],
      modelAssigneeId: null,
      correction: { messageId: '3', assigneeId: '30' },
    });
    expect(r.assigneeId).toBe('30');
  });

  it('когда названы двое, выбор модели принимается, если он среди названных', () => {
    const r = resolveRoles({ sources: [src('1', 'instruction', '10')], modelAssigneeId: '30', namedIds: ['20', '30'] });
    expect(r.assigneeId).toBe('30');
    const miss = resolveRoles({ sources: [src('1', 'instruction', '10')], modelAssigneeId: '50', namedIds: ['20', '30'] });
    expect(miss.assigneeId).toBeNull();
  });
});
