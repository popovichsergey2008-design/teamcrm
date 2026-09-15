import { taskCommentedLetter, taskCreatedLetter, taskStatusLetter, TaskCtx } from './mail.templates';

const CTX: TaskCtx = {
  taskTitle: 'Обновить прайс',
  projectName: 'Сайт',
  taskUrl: 'https://anthill.team/projects/1/task/2',
  actorName: 'Сергей Попович',
};
const UNSUB = 'https://anthill.team/api/notifications/unsubscribe?token=abc';

describe('письма по задачам', () => {
  it('в теме видно суть без открытия письма', () => {
    expect(taskCreatedLetter(CTX, UNSUB).subject).toBe('Новая задача: Обновить прайс');
    expect(taskStatusLetter({ ...CTX, to: 'Готово', closed: true }, UNSUB).subject)
      .toBe('Задача завершена: Обновить прайс');
    expect(taskStatusLetter({ ...CTX, to: 'В работе', closed: false }, UNSUB).subject)
      .toBe('Задача перенесена в «В работе»: Обновить прайс');
  });

  it('сводка попадает и в разметку, и в текстовую часть', () => {
    const rich = { ...CTX, assigneeName: 'Глеб', columnName: 'В работе', priority: 'urgent', deadlineAt: '2026-09-01T15:00:00Z' };
    const letter = taskCreatedLetter(rich, UNSUB);
    for (const part of [letter.html, letter.text]) {
      expect(part).toContain('Глеб');
      expect(part).toContain('В работе');
      expect(part).toContain('Срочно');
    }
    // пустые поля не превращаются в пустые строки сводки
    const bare = taskCreatedLetter(CTX, UNSUB);
    expect(bare.html).not.toContain('Исполнитель');
    expect(bare.html).not.toContain('Срок');
  });

  it('оформление не полагается на внешние ресурсы: их почтовики режут', () => {
    const letter = taskCreatedLetter(CTX, UNSUB);
    expect(letter.html).not.toMatch(/<img/i);
    expect(letter.html).not.toMatch(/<link/i);
    expect(letter.html).not.toMatch(/https?:\/\/(?!anthill\.team)/); // никаких чужих адресов
  });

  it('своя задача описывается иначе, чем чужая', () => {
    const own = taskCreatedLetter({ ...CTX, assigneeName: 'Сергей Попович' }, UNSUB);
    expect(own.text).toContain('Вы поставили себе задачу');
    const other = taskCreatedLetter({ ...CTX, assigneeName: 'Глеб' }, UNSUB);
    expect(other.text).toContain('Сергей Попович поставил задачу на вас');
  });

  it('в каждом письме есть ссылка на задачу и отписка', () => {
    for (const letter of [
      taskCreatedLetter(CTX, UNSUB),
      taskCommentedLetter({ ...CTX, comment: 'Сделал' }, UNSUB),
      taskStatusLetter({ ...CTX, to: 'Готово', closed: true }, UNSUB),
    ]) {
      expect(letter.text).toContain(CTX.taskUrl);
      expect(letter.text).toContain(UNSUB);
      // в разметке амперсанд обязан быть экранирован, иначе ссылка ломается в части почтовиков
      expect(letter.html).toContain(CTX.taskUrl.replace(/&/g, '&amp;'));
      expect(letter.html).toContain(UNSUB);
      expect(letter.subject.length).toBeLessThanOrEqual(120); // длинные темы обрезают почтовики
    }
  });

  it('чужой текст не ломает вёрстку письма', () => {
    // комментарий пишет человек: угловые скобки в нём не должны стать разметкой
    const letter = taskCommentedLetter({ ...CTX, comment: '<script>alert(1)</script> и <b>жирный</b>' }, UNSUB);
    expect(letter.html).not.toContain('<script>');
    expect(letter.html).toContain('&lt;script&gt;');
    expect(letter.text).toContain('<script>'); // в текстовой части экранировать нечего
  });

  it('длинное название и длинный комментарий обрезаются', () => {
    const long = 'а'.repeat(400);
    expect(taskCreatedLetter({ ...CTX, taskTitle: long }, UNSUB).subject.length).toBeLessThanOrEqual(120);
    const letter = taskCommentedLetter({ ...CTX, comment: 'б'.repeat(2000) }, UNSUB);
    expect(letter.html).not.toContain('б'.repeat(700)); // длинный комментарий обрезан
  });
});
