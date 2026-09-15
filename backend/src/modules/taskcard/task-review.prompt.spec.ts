import { formatReview, parseNeeds, parseReview, settleVerdict } from './task-review.prompt';

describe('проверка задачи ИИ: разбор ответа и отчёт', () => {
  const good = JSON.stringify({
    verdict: 'partial',
    summary: 'Кнопка добавлена, уведомления не показаны.',
    checked: [
      { what: 'Добавить кнопку «Объединить»', status: 'ok', evidence: 'видно на скриншоте в карточке' },
      { what: 'Отправлять уведомление участникам', status: 'no', evidence: 'в переписке и файлах подтверждений нет' },
    ],
    missing: ['подтверждение, что уведомление уходит'],
    ask_human: ['открыть задачу под вторым сотрудником и проверить письмо'],
    confidence: 0.6,
  });

  it('разбирает ответ модели и не верит лишнему', () => {
    const r = parseReview(`Вот результат:\n\`\`\`json\n${good}\n\`\`\``)!;
    expect(r.verdict).toBe('partial');
    expect(r.checked).toHaveLength(2);
    expect(r.checked[1].status).toBe('no');
    expect(r.askHuman[0]).toContain('вторым сотрудником');
    expect(r.confidence).toBe(0.6);
  });

  it('неизвестный вердикт и мусорные поля не проходят', () => {
    const r = parseReview(JSON.stringify({
      verdict: 'молодец',
      summary: 'ок',
      checked: [{ what: 'шаг', status: 'великолепно' }, { what: '', status: 'ok' }],
      missing: 'строка вместо списка',
      confidence: 42,
    }))!;
    // выдуманный вердикт превращается в «не смог проверить», а не в «сделано»
    expect(r.verdict).toBe('cannot_check');
    expect(r.checked).toHaveLength(1);
    expect(r.checked[0].status).toBe('unclear');
    expect(r.missing).toEqual([]);
    expect(r.confidence).toBe(0.5);
  });

  it('пустой и битый ответ — это отказ, а не «проверено»', () => {
    expect(parseReview('модель промолчала')).toBeNull();
    expect(parseReview('{ это не json }')).toBeNull();
    expect(parseReview(JSON.stringify({ verdict: 'done', summary: '', checked: [] }))).toBeNull();
  });

  it('отчёт читается сверху вниз и честно называет себя проверкой ИИ', () => {
    const text = formatReview(parseReview(good)!);
    expect(text.split('\n')[0]).toBe('Проверил: сделано не всё.');
    expect(text).toContain('✓ Добавить кнопку «Объединить»');
    expect(text).toContain('✗ Отправлять уведомление участникам');
    expect(text).toContain('Посмотрите сами:');
    expect(text).toContain('не приёмка работы');
    // процент уверенности наружу не выносим: цифра без объяснения даёт ложное доверие
    expect(text).not.toContain('0.6');
  });

  it('отчёт называет, по чему судил', () => {
    const text = formatReview(parseReview(good)!, {
      messages: 12, attachments: 3, history: 40, minutes: 185, images: 2,
    });
    expect(text).toContain('Смотрел: сообщений: 12');
    expect(text).toContain('вложений: 3');
    expect(text).toContain('снимков посмотрел: 2');
    expect(text).toContain('записей истории: 40');
    expect(text).toContain('учтено времени: 3 ч');
  });

  const notDone = parseReview(JSON.stringify({
    verdict: 'not_done',
    summary: 'Подтверждений выполнения нет.',
    checked: [{ what: 'Проверить мобильную версию', status: 'no', evidence: 'в переписке подтверждений нет' }],
    missing: ['доказательства выполнения'],
    confidence: 0.6,
  }))!;

  it('«не выполнено» не проходит, если следы работы есть', () => {
    // живой случай: чек-лист отмечен целиком, списано 3 часа, 14 записей истории
    const r = settleVerdict(notDone, {
      messages: 4, attachments: 0, history: 14, minutes: 180, images: 0, checklistDone: 3, checklistTotal: 3,
    });
    expect(r.verdict).toBe('cannot_check');
    // и отдельные пункты перестают быть обвинением
    expect(r.checked[0].status).toBe('no_proof');
    expect(formatReview(r).split('\n')[0]).toBe('Проверить по материалам задачи не смог.');
  });

  it('в пустой задаче «не выполнено» остаётся «не выполнено»', () => {
    const r = settleVerdict(notDone, {
      messages: 0, attachments: 0, history: 0, minutes: 0, images: 0, checklistDone: 0, checklistTotal: 2,
    });
    expect(r.verdict).toBe('not_done');
    expect(r.checked[0].status).toBe('no');
  });

  it('статус «подтверждения не нашёл» не читается как «не сделано»', () => {
    const r = parseReview(JSON.stringify({
      verdict: 'cannot_check',
      summary: 'Подтвердить по материалам нечем.',
      checked: [{ what: 'Позвонить клиенту', status: 'no_proof', evidence: 'звонки в задаче не фиксируются' }],
    }))!;
    expect(r.checked[0].status).toBe('no_proof');
    expect(formatReview(r)).toContain('? Позвонить клиенту');
  });

  it('довод «в чек-листе не отмечено» вычищается', () => {
    // живой случай: на снимке видно и название, и ссылку, а пункты объявлены неподтверждёнными
    const r = settleVerdict(parseReview(JSON.stringify({
      verdict: 'partial',
      summary: 'Не все пункты подтверждены.',
      checked: [
        { what: 'Нажать на логотип', status: 'no', evidence: 'в чек-листе не отмечено' },
        { what: 'Переход ведёт на anthill.team', status: 'ok', evidence: 'видно на снимке' },
      ],
    }))!, { messages: 1, attachments: 2, history: 4, minutes: 0, images: 2, checklistDone: 0, checklistTotal: 3 });
    expect(r.checked[0].status).toBe('no_proof');
    expect(r.checked[0].evidence).toBe('в материалах задачи подтверждения не нашёл');
    // у подтверждённого пункта довод не трогаем
    expect(r.checked[1].evidence).toBe('видно на снимке');
  });

  it('все пункты подтверждены — вывод «сделано», а не «сделано не всё»', () => {
    const r = settleVerdict(parseReview(JSON.stringify({
      verdict: 'partial',
      summary: 'Проверены требования.',
      checked: [
        { what: 'Логотип ведёт на главную', status: 'ok', evidence: 'на снимке открыт anthill.team' },
        { what: 'Название заменено', status: 'ok', evidence: 'на снимке видно «anthill.team»' },
      ],
    }))!, { messages: 1, attachments: 1, history: 3, minutes: 0, images: 1 });
    expect(r.verdict).toBe('done');
  });

  it('чек-лист попадает в строку «Смотрел»', () => {
    const text = formatReview(parseReview(good)!, {
      messages: 4, attachments: 0, history: 14, minutes: 180, images: 0, checklistDone: 3, checklistTotal: 3,
    });
    expect(text).toContain('чек-лист: 3 из 3 отмечено');
  });

  it('дозапросы видны в отчёте', () => {
    const text = formatReview(parseReview(good)!, {
      messages: 12, attachments: 1, history: 5, minutes: 0, images: 0,
      extra: ['переписку целиком', 'файл «отчёт.docx»'],
    });
    expect(text).toContain('Дозапросил: переписку целиком; файл «отчёт.docx».');
  });

  it('просьба о материалах разбирается, выдумки отбрасываются', () => {
    const needs = parseNeeds(JSON.stringify({
      need: [
        { 'чем': 'переписка' },
        { 'чем': 'файл', 'что': 'отчёт.docx' },
        { 'чем': 'удалить_задачу', 'что': '1288' },
        { 'чем': 'база_знаний' },
        { 'чем': 'база_знаний', 'что': 'регламент приёмки' },
      ],
    }));
    expect(needs).toEqual([
      { tool: 'переписка', arg: '' },
      { tool: 'файл', arg: 'отчёт.docx' },
      { tool: 'база_знаний', arg: 'регламент приёмки' },
    ]);
  });

  it('обычный отчёт не принимают за просьбу о материалах', () => {
    expect(parseNeeds(good)).toEqual([]);
    expect(parseNeeds('модель промолчала')).toEqual([]);
  });

  it('когда смотреть было нечего — так и говорит, а не молчит', () => {
    const text = formatReview(parseReview(good)!, {
      messages: 0, attachments: 0, history: 0, minutes: 0, images: 0,
    });
    expect(text).toContain('Смотреть было нечего');
  });
});
