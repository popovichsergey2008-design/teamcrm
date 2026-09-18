/**
 * Состояния обращения и правила переходов.
 *
 * Статус обязан отвечать на вопрос «что с ним сейчас» без чтения переписки. А правила
 * «кто вправе его менять» обязаны лежать в одном месте: пока они размазаны по сервису
 * присваиваниями, каждый новый путь добавляет к ним своё исключение, и через полгода
 * никто не может сказать, откуда взялось состояние.
 *
 * Отдельный файл и чистые функции — чтобы это проверялось без базы: здесь ошибка не
 * падает, а тихо разрешает не то.
 */

export type Status =
  | 'new'
  | 'ai'
  | 'waiting_agent'
  | 'in_progress'
  | 'engineer_escalated'
  | 'fix_in_progress'
  | 'waiting_reply'
  | 'waiting_user'
  | 'resolved'
  | 'closed';

/** В каком качестве человек действует в ЭТОМ разговоре. */
export type Actor = 'client' | 'ai' | 'agent' | 'engineer';

interface Rule { to: Status; by: Actor[] }

/**
 * Куда можно уйти из каждого состояния и кому это позволено (06_STATE_MACHINE §2–§3).
 *
 * Читается как таблица обязанностей: помощник только передаёт в очередь; дежурный ведёт
 * разговор и просит подтверждения; инженер отмечает починку; закрывает — только клиент.
 */
export const TRANSITIONS: Record<Status, Rule[]> = {
  new: [
    { to: 'ai', by: ['ai', 'agent'] },
    { to: 'waiting_agent', by: ['client', 'ai', 'agent'] },
  ],
  ai: [
    // Помощник умеет ровно одно: понять, что не справляется, и отдать людям.
    { to: 'waiting_agent', by: ['client', 'ai', 'agent'] },
    { to: 'waiting_user', by: ['ai', 'agent'] },
    { to: 'closed', by: ['client'] },
  ],
  waiting_agent: [
    { to: 'in_progress', by: ['agent'] },
    { to: 'closed', by: ['client'] },
  ],
  in_progress: [
    { to: 'engineer_escalated', by: ['agent'] },
    { to: 'waiting_reply', by: ['agent'] },
    { to: 'waiting_user', by: ['agent'] },
    { to: 'waiting_agent', by: ['agent'] },
    { to: 'closed', by: ['client'] },
  ],
  engineer_escalated: [
    { to: 'fix_in_progress', by: ['agent', 'engineer'] },
    { to: 'in_progress', by: ['agent', 'engineer'] },
    { to: 'closed', by: ['client'] },
  ],
  fix_in_progress: [
    { to: 'in_progress', by: ['agent', 'engineer'] },
    { to: 'waiting_user', by: ['agent'] },
    { to: 'closed', by: ['client'] },
  ],
  waiting_reply: [
    { to: 'in_progress', by: ['client', 'agent'] },
    { to: 'waiting_user', by: ['agent'] },
    { to: 'closed', by: ['client'] },
  ],
  waiting_user: [
    // Закрывает только тот, кто обратился, — это главное правило всей службы.
    { to: 'closed', by: ['client'] },
    { to: 'in_progress', by: ['client', 'agent'] },
  ],
  resolved: [
    { to: 'closed', by: ['client'] },
    { to: 'in_progress', by: ['client', 'agent'] },
  ],
  closed: [
    // Открыть заново вправе только автор: это продолжение его истории.
    { to: 'waiting_agent', by: ['client'] },
    { to: 'in_progress', by: ['client'] },
  ],
};

/** Разрешён ли переход этому актору. Возврат в то же состояние — всегда да. */
export function canTransition(from: Status, to: Status, actor: Actor): boolean {
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).some((r) => r.to === to && r.by.includes(actor));
}

/**
 * Почему переход не разрешён — словами для человека.
 *
 * Отдельная функция, а не строка в месте броска: одно и то же правило нарушают из
 * разных мест, и объяснение должно быть одинаковым.
 */
export function whyNot(from: Status, to: Status, actor: Actor): string {
  const allowed = (TRANSITIONS[from] ?? []).some((r) => r.to === to);
  if (!allowed) return 'Из этого состояния обращение так не переводится';
  if (to === 'closed') return 'Закрыть обращение может только тот, кто обратился';
  return actor === 'engineer'
    ? 'Инженер не ведёт разговор — это делает специалист поддержки'
    : 'У вас нет права на этот переход';
}

/**
 * Состояния, в которых разговор ждёт НАС, а не человека.
 *
 * По ним считается очередь и «висяки»: разговор, ждущий ответа клиента, висяком не
 * является, сколько бы он ни стоял.
 */
export const OURS: Status[] = ['new', 'waiting_agent', 'in_progress', 'engineer_escalated', 'fix_in_progress'];
