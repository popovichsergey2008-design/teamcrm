import { maskPII } from './pii';
import { validateStandupPackage } from './standup-schema';

describe('maskPII', () => {
  it('маскирует e-mail и телефон', () => {
    const r = maskPII('Пиши на ivan@example.com или звони +7 (912) 345-67-89 срочно');
    expect(r.masked).toContain('[EMAIL]');
    expect(r.masked).toContain('[PHONE]');
    expect(r.masked).not.toContain('ivan@example.com');
    expect(r.counts.email).toBe(1);
    expect(r.counts.phone).toBe(1);
  });

  it('маскирует пароль', () => {
    const r = maskPII('логин admin пароль: S3cr3tPass');
    expect(r.masked).toContain('[SECRET]');
    expect(r.masked).not.toContain('S3cr3tPass');
  });

  it('маскирует длинный номер карты', () => {
    const r = maskPII('карта 4276 1234 5678 9010 на оплату');
    expect(r.masked).toContain('[NUMBER]');
    expect(r.masked).not.toContain('4276 1234 5678 9010');
  });

  it('не трогает обычный текст и id задач', () => {
    const r = maskPII('задача #1420 готова, потратил 120 минут');
    expect(r.masked).toContain('#1420');
    expect(r.masked).toContain('120');
    expect(r.counts.email + r.counts.phone + r.counts.secret + r.counts.number).toBe(0);
  });
});

describe('validateStandupPackage', () => {
  it('валидный пакет нормализуется', () => {
    const r = validateStandupPackage({
      employee_id: 804,
      actions: [
        { task_id: 1420, status_change: 'done', time_logged_minutes: 120 },
        { task_id: '1421', status_change: 'IN_PROGRESS', blocker_detected: 'нет макетов' },
      ],
      confidence: 0.9,
    });
    expect(r.valid).toBe(true);
    expect(r.value!.actions[0].task_id).toBe('1420');
    expect(r.value!.actions[0].status_change).toBe('DONE');
    expect(r.value!.actions[1].blocker_detected).toBe('нет макетов');
    expect(r.value!.confidence).toBe(0.9);
  });

  it('пустые actions невалидны', () => {
    expect(validateStandupPackage({ actions: [] }).valid).toBe(false);
  });

  it('action без task_id невалиден', () => {
    expect(validateStandupPackage({ actions: [{ status_change: 'DONE' }] }).valid).toBe(false);
  });

  it('недопустимый статус невалиден', () => {
    expect(validateStandupPackage({ actions: [{ task_id: 1, status_change: 'WIP' }] }).valid).toBe(false);
  });

  it('действие без эффекта невалидно', () => {
    expect(validateStandupPackage({ actions: [{ task_id: 1 }] }).valid).toBe(false);
  });
});
