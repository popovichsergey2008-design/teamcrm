/**
 * Кому отдать обращение.
 *
 * Очередь «кто первым увидел, тот и взял» работает на десятке обращений и разваливается
 * на сотне: разбирают лёгкие и знакомые, тяжёлые оседают внизу, и ждёт их тот, кому
 * хуже всех. Поэтому выбор делает система, а человек её поправляет, а не наоборот.
 *
 * Чистая функция и отдельный файл намеренно: это единственное место, где решается, кто
 * будет разговаривать с клиентом, и оно должно проверяться без базы, сети и моделей.
 *
 * Правило простое и объяснимое: сначала те, кто УМЕЕТ, потом — кто СВОБОДЕН, и при
 * прочих равных — кто уже вёл этого клиента. «Умную» оценку с десятком слагаемых здесь
 * заводить нельзя: объяснить человеку, почему обращение ушло не ему, важнее, чем
 * выжать последние проценты справедливости.
 */

/** Кандидат: дежурный первой линии со своей загрузкой и навыками. */
export interface Candidate {
  userId: string;
  skills: string[];
  /** На дежурстве: снятых с дежурства не рассматриваем вовсе. */
  onDuty: boolean;
  /** Сейчас в системе. Берём из присутствия, а не из ручного статуса: тот врёт. */
  online: boolean;
  /** Сколько незакрытых разговоров уже ведёт. */
  load: number;
  /** Сколько тянет одновременно. */
  maxLoad: number;
}

export interface RoutingInput {
  /** Навык, который назвал помощник при классификации. Может отсутствовать. */
  requiredSkill: string | null;
  /** Кто вёл ПРОШЛОЕ обращение этого же человека. */
  previousAgentId: string | null;
  /** Кто уже работал с этой организацией. */
  tenantAgentIds: string[];
}

export interface Scored {
  userId: string;
  score: number;
  skill: boolean;
  load: number;
  online: boolean;
}

export interface RoutingResult {
  agentId: string | null;
  /** Словами: по этому объясняют выбор человеку, а не по числу. */
  reason: string;
  considered: Scored[];
}

/** Вес умения: главный признак. Специалист без навыка разберётся, но дольше и хуже. */
const W_SKILL = 10;
/** Вес присутствия: отдать разговор тому, кого нет на месте, — отложить его. */
const W_ONLINE = 3;
/** Вес «уже вёл этого человека»: не придётся объяснять всё заново. */
const W_SAME_PERSON = 4;
/** Вес «уже работал с этой организацией»: знает их порядки и людей. */
const W_SAME_ORG = 2;
/** Штраф за каждый текущий разговор. */
const W_LOAD = 2;

/**
 * Выбрать исполнителя.
 *
 * Возвращает null, если брать некому: все заняты, не на дежурстве или их нет вовсе.
 * Это НЕ ошибка — обращение остаётся в очереди и его возьмут руками. Молча назначить
 * перегруженному хуже, чем честно оставить в очереди: у первого варианта не видно
 * проблемы, у второго она видна сразу.
 */
export function pickAgent(input: RoutingInput, candidates: Candidate[]): RoutingResult {
  const free = candidates.filter((c) => c.onDuty && c.load < c.maxLoad);
  if (!free.length) {
    return {
      agentId: null,
      reason: candidates.some((c) => c.onDuty) ? 'все заняты' : 'нет дежурных',
      considered: [],
    };
  }

  const skill = (input.requiredSkill ?? '').trim().toLowerCase();
  const sameOrg = new Set(input.tenantAgentIds.map(String));

  const scored: Scored[] = free.map((c) => {
    const hasSkill = !!skill && c.skills.some((s) => s.trim().toLowerCase() === skill);
    let score = 0;
    if (hasSkill) score += W_SKILL;
    if (c.online) score += W_ONLINE;
    if (input.previousAgentId && String(input.previousAgentId) === String(c.userId)) score += W_SAME_PERSON;
    if (sameOrg.has(String(c.userId))) score += W_SAME_ORG;
    score -= c.load * W_LOAD;
    return { userId: String(c.userId), score, skill: hasSkill, load: c.load, online: c.online };
  });

  /*
    Порядок при равенстве задан явно.

    Иначе выбор зависит от порядка строк в выдаче базы: сегодня обращение уходит одному,
    завтра — другому, и объяснить это невозможно. Ровный счёт разрешаем меньшей
    загрузкой, а потом номером — лишь бы решение было одинаковым при одинаковых входных.
  */
  scored.sort((a, b) => b.score - a.score || a.load - b.load || Number(a.userId) - Number(b.userId));
  const best = scored[0];

  const reason = best.skill ? 'по навыку'
    : input.previousAgentId && String(input.previousAgentId) === best.userId ? 'вёл этого клиента'
      : sameOrg.has(best.userId) ? 'работал с этой компанией'
        : 'свободнее всех';

  return { agentId: best.userId, reason, considered: scored };
}
