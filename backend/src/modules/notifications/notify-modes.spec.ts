import { inQuietHours, isImportant } from './inbox-rules';

describe('«Только важное» и тихие часы (#4902, п. 1)', () => {
  it('важное: упоминания, личные, звонки, решения, назначенное', () => {
    expect(isImportant('chat.mention')).toBe(true);
    expect(isImportant('chat.message', { dm: true })).toBe(true);
    expect(isImportant('call.missed')).toBe(true);
    expect(isImportant('task.approval')).toBe(true);
    expect(isImportant('task.deadline')).toBe(true);
    expect(isImportant('task.status')).toBe(false);
    expect(isImportant('task.commented')).toBe(false);
  });
  it('тихие часы, в том числе через полночь', () => {
    expect(inQuietHours('22:30', '21:00', '09:00')).toBe(true);
    expect(inQuietHours('08:59', '21:00', '09:00')).toBe(true);
    expect(inQuietHours('12:00', '21:00', '09:00')).toBe(false);
    expect(inQuietHours('13:30', '13:00', '14:00')).toBe(true);
    expect(inQuietHours('12:00', null, null)).toBe(false);
  });
});
