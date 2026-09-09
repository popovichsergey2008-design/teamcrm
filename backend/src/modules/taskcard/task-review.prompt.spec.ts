import { formatReview, parseReview } from './task-review.prompt';

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
});
