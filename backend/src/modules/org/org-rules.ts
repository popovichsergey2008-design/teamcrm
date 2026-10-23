/**
 * Структура компании и ОДНО правило подбора исполнителя (#4615, доработка 23.10).
 *
 * Жалоба заказчика: «по какому принципу он выбирает сотрудника — на мне и на Глебе
 * программные задачи, но он всегда подставляет Глеба». Руководители не были заданы,
 * и подбор брал наименее загруженного. Теперь у каждой компании своя структура —
 * должности с уровнем, отделы с руководителем и заместителями, «кому подчиняется», —
 * и одно правило на все пути постановки: форма, быстрая команда, палочка в чате,
 * встречи, бот.
 *
 * Чистый модуль без базы: правило проверяется тестами рядом. Ничего под конкретную
 * компанию — только то, что она сама настроила.
 */
import { AssigneeCandidate, pickAssignee } from '../nl/assignee-pick';
import { isSkill, Skill, SKILL_LABEL, skillFits } from '../team/skills';

// ───────────────────────── уровни должностей ─────────────────────────

/** Набор уровней фиксированный: по нему правило понимает иерархию. Названия должностей — свои. */
export const LEVELS = ['ceo', 'head', 'deputy', 'specialist', 'intern'] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_LABEL: Record<Level, string> = {
  ceo: 'Руководитель компании',
  head: 'Руководитель отдела',
  deputy: 'Заместитель / тимлид',
  specialist: 'Специалист',
  intern: 'Стажёр',
};

export const isLevel = (v: unknown): v is Level => typeof v === 'string' && (LEVELS as readonly string[]).includes(v);

/** Готовые должности новой компании — дальше она переименует и добавит свои. */
export const DEFAULT_POSITIONS: { name: string; level: Level }[] = [
  { name: 'Генеральный директор', level: 'ceo' },
  { name: 'Руководитель отдела', level: 'head' },
  { name: 'Тимлид', level: 'deputy' },
  { name: 'Специалист', level: 'specialist' },
  { name: 'Стажёр', level: 'intern' },
];

// ───────────────────────── снимок структуры ─────────────────────────

export interface OrgPerson {
  id: string;
  name: string;
  positionName: string | null;
  level: Level | null;
  /** Непосредственный руководитель, если задан руками. */
  reportsTo: string | null;
  skills: string[];
  openTasks: number;
  weight: number;
  /** «ИИ может предлагать его исполнителем». */
  canReceive: boolean;
}

export interface OrgDepartment {
  id: string;
  name: string;
  leadUserId: string | null;
  deputyIds: string[];
  memberIds: string[];
  directions: string[];
  parentId: string | null;
}

export interface Org { people: OrgPerson[]; departments: OrgDepartment[] }

const byId = (org: Org) => new Map(org.people.map((p) => [p.id, p]));

/** Руководитель отдела: назначенный, иначе участник с уровнем «Руководитель отдела». */
export function leadOf(org: Org, d: OrgDepartment): string | null {
  if (d.leadUserId) return String(d.leadUserId);
  const people = byId(org);
  return d.memberIds.find((u) => people.get(u)?.level === 'head') ?? null;
}

/** Заместители и тимлиды: отмеченные в отделе и участники с уровнем «Заместитель / тимлид». */
export function deputiesOf(org: Org, d: OrgDepartment): string[] {
  const people = byId(org);
  const lead = leadOf(org, d);
  return [...new Set([...d.deputyIds, ...d.memberIds.filter((u) => people.get(u)?.level === 'deputy')])].filter((u) => u !== lead);
}

/** Отдел отвечает за направление. Фулстек-задачу берёт отдел бэкенда или фронтенда. */
export function departmentCovers(directions: readonly string[], skill: Skill): boolean {
  if (directions.includes(skill)) return true;
  if (skill === 'fullstack') return directions.includes('backend') || directions.includes('frontend');
  return false;
}

/** Отделы направления: точное совпадение раньше «фулстек → отдел бэкенда», дальше по имени. */
export function departmentsFor(org: Org, skill: Skill): OrgDepartment[] {
  return org.departments
    .filter((d) => departmentCovers(d.directions, skill))
    .sort((a, b) => Number(!a.directions.includes(skill)) - Number(!b.directions.includes(skill)) || a.name.localeCompare(b.name, 'ru'));
}

/** Есть ли у направления руководитель (назначенный или по уровню должности). */
export function directionHasLead(org: Org, skill: Skill): boolean {
  return departmentsFor(org, skill).some((d) => !!leadOf(org, d));
}

/**
 * Кому подчиняется человек: заданный руками руководитель; иначе руководитель его
 * отдела; сам руководит отделом — руководитель вышестоящего; иначе руководитель компании.
 */
export function managerOf(org: Org, userId: string): string | null {
  const people = byId(org);
  const me = people.get(String(userId));
  if (me?.reportsTo && me.reportsTo !== me.id && people.has(me.reportsTo)) return me.reportsTo;
  const mine = org.departments
    .filter((d) => d.memberIds.includes(String(userId)) || d.leadUserId === String(userId))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const deps = new Map(org.departments.map((d) => [d.id, d]));
  for (const d of mine) {
    const lead = leadOf(org, d);
    if (lead && lead !== String(userId)) return lead;
    // сам руководит — вверх по вышестоящим отделам
    const seen = new Set<string>([d.id]);
    let parent = d.parentId ? deps.get(d.parentId) : undefined;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      const up = leadOf(org, parent);
      if (up && up !== String(userId)) return up;
      parent = parent.parentId ? deps.get(parent.parentId) : undefined;
    }
  }
  const ceo = org.people.find((p) => p.level === 'ceo' && p.id !== String(userId));
  return ceo?.id ?? null;
}

// ───────────────────────── ролевые адресаты ─────────────────────────

const norm = (s: string) => ` ${String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”().,!?;:]/g, ' ').replace(/\s+/g, ' ')} `;
/** Основа слова: «дизайна», «дизайну» → «дизай»; короткие слова — целиком. */
const stem = (w: string) => (w.length > 6 ? w.slice(0, -2) : w.length > 4 ? w.slice(0, -1) : w);
const words = (s: string) => norm(s).replace(/-/g, ' ').trim().split(' ').filter(Boolean);
/** Служебные слова в названиях отделов и должностей: по ним не узнают. */
const FILLER = new Set(['отдел', 'отдела', 'отделу', 'группа', 'группы', 'направление', 'направления', 'команда', 'команды', 'по', 'и', 'для', 'в', 'на']);

/** Как называют направление в речи: основы слов. */
const DIRECTION_WORDS: [Skill, string[]][] = [
  ['backend', ['бэкенд', 'бекенд', 'backend', 'бэк', 'бек', 'сервер']],
  ['frontend', ['фронтенд', 'фронт', 'frontend', 'верст']],
  ['fullstack', ['программ', 'разработ', 'it', 'ит', 'айти', 'dev']],
  ['content', ['контент', 'копирайт', 'текст', 'smm', 'смм']],
  ['design', ['дизайн', 'арт']],
  ['qa', ['тестир', 'тестов', 'qa', 'качеств']],
  ['analytics', ['аналитик', 'аналитич']],
];

/**
 * Профессия вместо имени: «поставь дизайнеру», «программисту» — это направление, а
 * кому из людей — решает структура. «Аналитику» нет намеренно: так же пишут «подготовить аналитику».
 */
const PROFESSIONS: [Skill, RegExp][] = [
  ['backend', /(?<![а-яa-z])(бэкендер|бекендер|бэкенд-разработчик|бекенд-разработчик)(у|а|ам|ов)?(?![а-яa-z])/],
  ['frontend', /(?<![а-яa-z])(фронтендер|верстальщик|фронтенд-разработчик)(у|а|ам|ов)?(?![а-яa-z])/],
  ['fullstack', /(?<![а-яa-z])(программист|разработчик)(у|а|ам|ов)?(?![а-яa-z])/],
  ['content', /(?<![а-яa-z])(контентщик|копирайтер|контент-менеджер|редактор)(у|а|ам|ов)?(?![а-яa-z])/],
  ['design', /(?<![а-яa-z])(дизайнер)(у|а|ам|ов)?(?![а-яa-z])/],
  ['qa', /(?<![а-яa-z])(тестировщик)(у|а|ам|ов)?(?![а-яa-z])/],
];

function directionOf(word: string): Skill | null {
  const w = word.toLowerCase();
  for (const [skill, stems] of DIRECTION_WORDS) {
    if (stems.some((s) => (s.length <= 3 ? w === s || w === `${s}а` || w === `${s}у` : w.startsWith(s)))) return skill;
  }
  return null;
}

/** Совпадает ли название (отдела, должности) с куском речи: каждое слово — по основе, подряд. */
function nameAt(name: string, tail: string[]): number {
  const parts = words(name).filter((w) => !FILLER.has(w));
  if (!parts.length) return 0;
  let i = 0;
  for (const p of parts) {
    while (i < tail.length && FILLER.has(tail[i])) i += 1;
    if (i >= tail.length) return 0;
    const st = stem(p);
    if (!(tail[i] === p || tail[i].startsWith(st))) return 0;
    i += 1;
  }
  return i;
}

export interface RoleHit {
  /** Кандидаты по порядку: первый, кто видит проект, и станет исполнителем. */
  userIds: string[];
  /** Направление, если роль назвали через него («руководителю дизайна»). */
  skill: Skill | null;
  /** Словами: «руководитель отдела «Дизайн»». */
  reason: string;
}

/** «Кому» сказано ролью: руководитель/начальник, тимлид/заместитель, свой руководитель, директор. */
const ROLE_RE = /(?<![а-яa-z-])(руководител|начальник|шеф|тимлид|тим-лид|teamlead|заместител|зам|директор|гендиректор)([а-я]*)(?![а-яa-z])/g;
/** Творительный падеж — не адресат: «согласовать с руководителем». */
const NOT_ADDRESSEE = /^(ем|ом|ами|ями|ой|ею)$/;
/** Слова-роли в названии должности: по ним одним человека не узнать. */
const GENERIC_TITLE = /^(руководител|начальник|шеф|тимлид|заместител|директор|генеральн|специалист|стажер|менеджер|сотрудник|главн|старш|ведущ|младш|помощник)/;

const least = (org: Org, ids: string[]) => {
  const people = byId(org);
  return [...ids].sort((a, b) => {
    const pa = people.get(a); const pb = people.get(b);
    const la = (pa?.openTasks ?? 0) / Math.max(0.5, pa?.weight ?? 1);
    const lb = (pb?.openTasks ?? 0) / Math.max(0.5, pb?.weight ?? 1);
    return la - lb || (pa?.name ?? '').localeCompare(pb?.name ?? '', 'ru');
  });
};

/**
 * Ролевой адресат в тексте — правилами, без модели: «поставь тимлиду фронта»,
 * «руководителю контента», «моему руководителю», «начальнику отдела IT»,
 * «генеральному директору», «арт-директору» (своя должность компании).
 * Профессия («дизайнеру») — только направление: кому именно, решит структура.
 */
export function roleAddressee(text: string, org: Org, authorId: string | null): RoleHit | { skill: Skill; reason: string } | null {
  const t = norm(text);
  const people = byId(org);

  // свой руководитель
  if (/(?<![а-я])(моему|своему|моего|своего|мой|свой)\s+(непосредственному\s+)?(руководител|начальник|шеф)[а-я]*/.test(t) && authorId) {
    const m = managerOf(org, authorId);
    if (m) return { userIds: [m], skill: null, reason: 'ваш руководитель' };
  }

  // руководитель компании
  if (/(гендиректор|генеральн[а-я]*\s+директор|руководител[а-я]*\s+компании|(?<![а-я])ceo(?![a-z])|основател[юя])/.test(t)) {
    const ceo = org.people.filter((p) => p.level === 'ceo' && p.id !== authorId).map((p) => p.id);
    if (ceo.length) return { userIds: ceo, skill: null, reason: 'руководитель компании' };
  }

  const tokens = words(text);

  // «руководителю дизайна», «начальнику отдела IT», «тимлиду фронта»
  ROLE_RE.lastIndex = 0;
  for (const m of t.matchAll(ROLE_RE)) {
    const root = m[1]; const ending = m[2] ?? '';
    if (NOT_ADDRESSEE.test(ending)) continue;
    if (root === 'зам' && ending && !['у', 'а'].includes(ending)) continue; // «замена», «замечание»
    const deputy = /^(тимлид|тим-лид|teamlead|заместител|зам)$/.test(root);
    const after = words(t.slice((m.index ?? 0) + m[0].length)).slice(0, 4);
    // отдел по названию
    let dept: OrgDepartment | null = null; let dlen = 0;
    for (const d of org.departments) {
      const len = nameAt(d.name, after);
      if (len > dlen) { dept = d; dlen = len; }
    }
    let skill: Skill | null = null;
    if (!dept) {
      for (const w of after.filter((x) => !FILLER.has(x)).slice(0, 2)) { skill = directionOf(w); if (skill) break; }
    }
    const deps = dept ? [dept] : skill ? departmentsFor(org, skill) : [];
    if (!deps.length) {
      if (skill) return { skill, reason: `${deputy ? 'тимлид' : 'руководитель'} направления «${SKILL_LABEL[skill]}» не задан` };
      continue;
    }
    const ids: string[] = []; let reason = '';
    for (const d of deps) {
      const lead = leadOf(org, d);
      const found = deputy ? least(org, deputiesOf(org, d).filter((u) => !skill || skillFits(people.get(u)?.skills ?? [], skill))) : [];
      if (deputy && found.length) { ids.push(...found); reason ||= `тимлид отдела «${d.name}»`; }
      if (lead) { ids.push(lead); reason ||= `руководитель отдела «${d.name}»`; }
    }
    const list = [...new Set(ids)].filter((u) => u !== authorId);
    if (list.length) return { userIds: list, skill, reason };
    if (skill) return { skill, reason: `руководитель направления «${SKILL_LABEL[skill]}» не задан` };
  }

  // своя должность компании руководящего уровня: «арт-директору», «тимлиду фронтенда».
  // Общие названия («Руководитель отдела», «Тимлид») сами по себе не адресат — их несколько.
  const held = new Map<string, string[]>();
  for (const p of org.people) {
    if (!p.positionName || !p.level || !['ceo', 'head', 'deputy'].includes(p.level)) continue;
    const own = words(p.positionName).filter((w) => !FILLER.has(w));
    if (!own.some((w) => !GENERIC_TITLE.test(w))) continue;
    held.set(p.positionName, [...(held.get(p.positionName) ?? []), p.id]);
  }
  let best: { len: number; name: string; ids: string[] } | null = null;
  for (const [title, ids] of held) {
    const first = (words(title)[0] ?? '').replace(/[ьйая]$/, '');
    for (let i = 0; i < tokens.length; i += 1) {
      if (first && tokens[i].startsWith(first) && NOT_ADDRESSEE.test(tokens[i].slice(first.length))) continue;
      const len = nameAt(title, tokens.slice(i));
      if (len && (!best || len > best.len)) best = { len, name: title, ids };
    }
  }
  if (best) {
    const ids = least(org, best.ids.filter((u) => u !== authorId));
    if (ids.length) return { userIds: ids, skill: null, reason: `должность «${best.name}»` };
  }

  // профессия → направление
  for (const [skill, re] of PROFESSIONS) if (re.test(t)) return { skill, reason: '' };
  return null;
}

/** Звучит ли в тексте роль вместо имени — тогда выбор модели по оргструктуре принимаем. */
export function mentionsRole(text: string): boolean {
  const t = norm(text);
  ROLE_RE.lastIndex = 0;
  for (const m of t.matchAll(ROLE_RE)) if (!NOT_ADDRESSEE.test(m[2] ?? '')) return true;
  return PROFESSIONS.some(([, re]) => re.test(t));
}

// ───────────────────────── одно правило подбора ─────────────────────────

export interface ChooseInput {
  /** Постановщик: ему самому задачу не раздаём, его руководитель — «моему руководителю». */
  authorId: string | null;
  /** Человек назван по имени — главнее всего. */
  namedUserId?: string | null;
  /** Роль, распознанная в тексте (roleAddressee). */
  role?: RoleHit | null;
  /** Главное направление задачи. */
  skill: Skill | null;
  /** Видит ли человек проект задачи. Проекта нет — все видят. */
  canSee: (userId: string) => boolean;
  /** Направление не понять — всё равно предложить наименее загруженного (быстрая команда). */
  anyWhenNoSkill?: boolean;
}

export type ChoiceSource = 'named' | 'role' | 'lead' | 'deputy' | 'member' | 'load' | 'none';

export interface Choice {
  userId: string | null;
  name: string | null;
  /** Словами — видно в форме, сводке и сообщении-подтверждении. */
  reason: string;
  source: ChoiceSource;
  departmentId: string | null;
  /** У направления нет руководителя — спросить постановщика «кто отвечает за …». */
  noLeadFor: Skill | null;
  /** Названный человек не видит проект и т. п. */
  warnings: string[];
}

/**
 * Кому поставить задачу. Порядок:
 * 1) названный человек или роль («Глебу», «тимлиду фронта», «моему руководителю»);
 * 2) направление → отдел этого направления → его руководитель; постановщик сам
 *    руководитель этого отдела — тимлид/заместитель с этим направлением, иначе
 *    специалист отдела с этим направлением и наименьшей загрузкой;
 * 3) структуры нет — прежний подбор по навыку и загрузке, с честной причиной.
 * Везде — только те, кто видит проект; не видит — следующий по правилу.
 */
export function chooseAssignee(org: Org, input: ChooseInput): Choice {
  const people = byId(org);
  const name = (u: string) => people.get(u)?.name ?? null;
  const warnings: string[] = [];
  const out = (userId: string | null, reason: string, source: ChoiceSource, extra: Partial<Choice> = {}): Choice => ({
    userId, name: userId ? name(userId) : null, reason, source, departmentId: null, noLeadFor: null, warnings, ...extra,
  });
  const author = input.authorId ? String(input.authorId) : null;

  if (input.namedUserId) {
    const u = String(input.namedUserId);
    if (input.canSee(u)) return out(u, 'назван в тексте', 'named');
    warnings.push(`${name(u) ?? 'Названный исполнитель'} не видит проект — назначен другой`);
  }
  if (input.role?.userIds.length) {
    const u = input.role.userIds.find((x) => input.canSee(x));
    if (u) return out(u, input.role.reason, 'role');
    warnings.push(`${name(input.role.userIds[0]) ?? 'Названный'} (${input.role.reason}) не видит проект — назначен другой`);
  }

  const skill = input.skill ?? input.role?.skill ?? null;
  const ok = (u: string) => !!people.get(u)?.canReceive && input.canSee(u) && u !== author;
  const fits = (u: string) => !!skill && skillFits(people.get(u)?.skills ?? [], skill);

  if (skill) {
    const label = SKILL_LABEL[skill];
    const deps = departmentsFor(org, skill);
    const hasLead = deps.some((d) => !!leadOf(org, d));
    for (const d of deps) {
      const lead = leadOf(org, d);
      if (lead && lead !== author && ok(lead)) {
        return out(lead, `руководитель отдела «${d.name}» по направлению ${label}`, 'lead', { departmentId: d.id });
      }
      const why = !lead ? 'руководитель отдела не задан'
        : lead === author ? 'вы руководите отделом и раздаёте задачи'
          : !input.canSee(lead) ? 'руководитель не видит проект'
            : 'руководитель не принимает автоматические задачи';
      const deputy = least(org, deputiesOf(org, d).filter((u) => ok(u) && fits(u)))[0];
      if (deputy) {
        return out(deputy, `тимлид отдела «${d.name}» по направлению ${label}: ${why}`, 'deputy', { departmentId: d.id, noLeadFor: hasLead ? null : skill });
      }
      const member = least(org, d.memberIds.filter((u) => u !== lead && ok(u) && fits(u)))[0];
      if (member) {
        return out(member, `${label.toLowerCase()} в отделе «${d.name}», меньше всех загружен: ${why}`, 'member', { departmentId: d.id, noLeadFor: hasLead ? null : skill });
      }
    }
    // структуры по направлению нет — прежний подбор по навыку и загрузке
    const pick = pickAssignee({ skill, confidence: 1 }, candidates(org, (u) => input.canSee(u)));
    const n = pick.considered.find((c) => c.userId === pick.userId)?.openTasks ?? 0;
    const head = hasLead ? `руководитель направления «${label}» не может взять задачу` : `руководитель направления «${label}» не задан`;
    return pick.userId
      ? out(pick.userId, `${head} — выбран наименее загруженный (открытых задач: ${n})`, 'load', { noLeadFor: hasLead ? null : skill })
      : out(null, `${head}, и нет сотрудника с направлением «${label}», который видит проект`, 'none', { noLeadFor: hasLead ? null : skill });
  }

  if (!input.anyWhenNoSkill) return out(null, 'по тексту направление не понять', 'none');
  const pick = pickAssignee({ skill: null, confidence: 1 }, candidates(org, (u) => input.canSee(u)));
  return pick.userId
    ? out(pick.userId, 'направление не понять — выбран наименее загруженный', 'load')
    : out(null, 'некого предложить: нет сотрудников с автоназначением', 'none');
}

/** Кандидаты прежнего подбора: принимают автоматические задачи и видят проект. */
function candidates(org: Org, canSee: (u: string) => boolean): AssigneeCandidate[] {
  return org.people.filter((p) => p.canReceive && canSee(p.id)).map((p) => ({
    userId: p.id, name: p.name, skills: p.skills, openTasks: p.openTasks, weight: p.weight,
  }));
}

/**
 * Кого предложить в «Кто отвечает за <направление>?»: люди с этим направлением,
 * руководящие уровни раньше, дальше по имени. До трёх.
 */
export function leadOptions(org: Org, skill: Skill, limit = 3): { id: string; name: string }[] {
  const rank: Record<string, number> = { ceo: 3, head: 0, deputy: 1, specialist: 2, intern: 4 };
  return org.people
    .filter((p) => skillFits(p.skills, skill))
    .sort((a, b) => (rank[a.level ?? 'specialist'] - rank[b.level ?? 'specialist']) || a.name.localeCompare(b.name, 'ru'))
    .slice(0, limit)
    .map((p) => ({ id: p.id, name: p.name }));
}

// ───────────────────────── для модели ─────────────────────────

/**
 * Оргструктура для модели — компактно: люди с должностью, уровнем, отделом,
 * руководителем и направлениями; отделы с руководителями. Пустые поля не пишем.
 */
export function orgForModel(org: Org, limit = 60) {
  const people = byId(org);
  const nm = (u: string | null) => (u ? people.get(u)?.name ?? null : null);
  const depName = new Map(org.departments.map((d) => [d.id, d.name]));
  const deptsOf = (u: string) => org.departments.filter((d) => d.memberIds.includes(u) || d.leadUserId === u).map((d) => d.name);
  const departments = org.departments.map((d) => ({
    name: d.name,
    ...(leadOf(org, d) ? { lead: nm(leadOf(org, d)) } : {}),
    ...(deputiesOf(org, d).length ? { deputies: deputiesOf(org, d).map(nm).filter(Boolean) } : {}),
    ...(d.directions.length ? { directions: d.directions.filter(isSkill).map((s) => SKILL_LABEL[s]) } : {}),
    ...(d.parentId && depName.get(d.parentId) ? { parent: depName.get(d.parentId) } : {}),
  }));
  const list = org.people.slice(0, limit).map((p) => {
    const boss = managerOf(org, p.id);
    const deps = deptsOf(p.id);
    return {
      id: p.id, name: p.name,
      ...(p.positionName ? { position: p.positionName } : {}),
      ...(p.level ? { level: LEVEL_LABEL[p.level] } : {}),
      ...(deps.length ? { departments: deps } : {}),
      ...(boss ? { manager: nm(boss) } : {}),
      ...(p.skills.length ? { directions: p.skills.filter(isSkill).map((s) => SKILL_LABEL[s]) } : {}),
    };
  });
  return { departments, people: list };
}

/** То же строками — для промптов-текстов (разбор встреч). */
export function orgLines(org: Org, limit = 40): string {
  if (!org.departments.length && !org.people.some((p) => p.positionName)) return '';
  const m = orgForModel(org, limit);
  const deps = m.departments.map((d) => `- отдел «${d.name}»${d.lead ? `: руководитель ${d.lead}` : ''}${d.deputies?.length ? `, тимлиды ${d.deputies.join(', ')}` : ''}${d.directions?.length ? `; направления: ${d.directions.join(', ')}` : ''}${d.parent ? `; входит в «${d.parent}»` : ''}`);
  const ppl = m.people.filter((p) => p.position || p.manager).map((p) => `- ${p.name}${p.position ? ` — ${p.position}` : ''}${p.manager ? `, подчиняется: ${p.manager}` : ''}`);
  return [
    'Структура компании (кому ставить «руководителю дизайна», «тимлиду», «моему руководителю»):',
    ...deps, ...ppl,
  ].join('\n');
}

/** Подсказка модели: что значит поле org во входе. */
export const ORG_PROMPT_HINT = 'org — структура компании: отделы с руководителями, тимлидами и направлениями; люди с должностью, уровнем и руководителем. '
  + 'Если исполнитель назван ролью («руководителю дизайна», «тимлиду фронта», «моему руководителю», «начальнику отдела IT»), выбери assigneeId этого человека по org.';
