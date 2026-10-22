/**
 * Автоматическая постановка задачи (#4615) — чистые правила, без базы и модели.
 *
 * Человек пишет или говорит суть и выбирает только срок; проект, исполнителя, теги и
 * приоритет система ставит сама, а через 30 секунд просит постановщика проверить.
 * Здесь — как выбрать проект без вопросов, кому отдать задачу по направлению и что
 * написать в сообщении-подтверждении.
 */
import { Skill, SKILL_LABEL, skillFits } from '../team/skills';

/** Через сколько после создания приходит «Задача поставлена, проверьте». */
export const AUTO_CONFIRM_DELAY_MS = 30_000;

// ───────────────────────── проект ─────────────────────────

export interface AutoProjectInput {
  /** Итог определителя (ТЗ-31): уровень и лучший кандидат. */
  level: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  resolvedId: string | null;
  resolvedHint?: string | null;
  /** Доска, на которой человек стоит. */
  boardId: string | null;
  /** Последний проект, где человек ставил задачи. */
  lastTaskProjectId: string | null;
  /** Последняя открытая доска (человек не на ней). */
  lastBoardId: string | null;
  /** Прочие варианты определителя по убыванию. */
  alternatives: string[];
  /** Только проекты, которые человек видит. */
  visible: ReadonlySet<string>;
}

export interface AutoProjectPick { projectId: string | null; why: string }

/**
 * Проект без вопросов: HIGH → он; MEDIUM → лучший кандидат; LOW или ничего →
 * открытая доска, иначе последний проект, где человек ставил задачи, иначе последняя
 * открытая доска и прочие варианты определителя. Невидимый человеку проект не берём никогда.
 */
export function pickAutoProject(i: AutoProjectInput): AutoProjectPick {
  const ok = (id: string | null | undefined): id is string => !!id && i.visible.has(String(id));
  const hint = (i.resolvedHint ?? '').trim();
  if ((i.level === 'HIGH' || i.level === 'MEDIUM') && ok(i.resolvedId)) {
    return {
      projectId: String(i.resolvedId),
      why: i.level === 'HIGH' ? (hint || 'по тексту задачи') : `скорее всего${hint ? `: ${hint}` : ' — по тексту задачи'}`,
    };
  }
  if (ok(i.boardId)) return { projectId: String(i.boardId), why: 'открытая доска' };
  if (ok(i.lastTaskProjectId)) return { projectId: String(i.lastTaskProjectId), why: 'здесь вы ставили задачи последним' };
  if (ok(i.lastBoardId)) return { projectId: String(i.lastBoardId), why: 'последняя открытая доска' };
  if (ok(i.resolvedId)) return { projectId: String(i.resolvedId), why: 'ближе всего по тексту' };
  const alt = i.alternatives.find(ok);
  if (alt) return { projectId: String(alt), why: 'ближе всего по тексту' };
  return { projectId: null, why: '' };
}

// ───────────────────────── исполнитель ─────────────────────────

export interface DepartmentInfo {
  id: string;
  name: string;
  leadUserId: string | null;
  directions: string[];
  memberIds: string[];
}

export interface LeadContext {
  /** Видит ли человек проект задачи (и активен). */
  canSee: (userId: string) => boolean;
  skillsOf: (userId: string) => readonly string[];
  openTasks: (userId: string) => number;
  nameOf: (userId: string) => string | null;
}

export interface LeadPick { userId: string; name: string; reason: string; departmentId: string }

/** Отвечает ли отдел за направление. Фулстек-задачу берёт отдел бэкенда или фронтенда. */
export function departmentCovers(directions: readonly string[], skill: Skill): boolean {
  if (directions.includes(skill)) return true;
  if (skill === 'fullstack') return directions.includes('backend') || directions.includes('frontend');
  return false;
}

/**
 * Кому отдать задачу по направлению: отдел этого направления → его руководитель.
 *
 * Руководитель не видит проект — следующий подходящий: участник того же отдела с этим
 * направлением, видящий проект, у кого меньше открытых задач. Нет отдела с руководителем
 * или некого взять — null: вызывающий оставит прежний подбор по навыку и загрузке.
 */
export function pickDepartmentLead(skill: Skill | null, departments: DepartmentInfo[], ctx: LeadContext): LeadPick | null {
  if (!skill) return null;
  const fit = departments
    .filter((d) => d.leadUserId && departmentCovers(d.directions, skill))
    // точное совпадение направления — раньше «фулстек → отдел бэкенда»
    .sort((a, b) => Number(!a.directions.includes(skill)) - Number(!b.directions.includes(skill)) || a.name.localeCompare(b.name, 'ru'));
  const label = SKILL_LABEL[skill];
  for (const d of fit) {
    const lead = String(d.leadUserId);
    if (ctx.canSee(lead)) {
      return { userId: lead, name: ctx.nameOf(lead) ?? '', departmentId: d.id, reason: `руководитель отдела «${d.name}»` };
    }
    const member = d.memberIds
      .map(String)
      .filter((u) => u !== lead && ctx.canSee(u) && skillFits(ctx.skillsOf(u), skill))
      .sort((a, b) => ctx.openTasks(a) - ctx.openTasks(b) || (ctx.nameOf(a) ?? '').localeCompare(ctx.nameOf(b) ?? '', 'ru'))[0];
    if (member) {
      return {
        userId: member, name: ctx.nameOf(member) ?? '', departmentId: d.id,
        reason: `${label.toLowerCase()} в отделе «${d.name}»: руководитель не видит проект`,
      };
    }
  }
  return null;
}

// ───────────────────────── сообщение ─────────────────────────

export const PRIORITY_RU: Record<string, string> = { low: 'низкий', normal: 'обычный', high: 'высокий', urgent: 'срочный' };

export interface ConfirmFacts {
  taskId: string;
  title: string;
  assigneeName: string | null;
  projectName: string | null;
  deadlineAt: Date | string | null;
  priority: string;
  tags: string[];
  /** Почему такой проект и исполнитель — словами. */
  projectWhy?: string | null;
  assigneeWhy?: string | null;
  /** Задачу уже поправили после создания. */
  edited: boolean;
  timeZone?: string | null;
}

function fmtDeadline(v: Date | string | null, tz?: string | null): string {
  if (!v) return 'без срока';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return 'без срока';
  try {
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: tz || undefined });
  } catch {
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  }
}

/**
 * «Задача поставлена: #N «…». Исполнитель — …, проект — …, срок — …, приоритет — …,
 * теги — …. Проверьте, всё ли ок.» Заголовок карточки — первая фраза, остальное — текст.
 */
export function confirmMessage(f: ConfirmFacts): { title: string; summary: string; why: string } {
  const title = `Задача поставлена: #${f.taskId} «${f.title}»`;
  const why = (x?: string | null) => (x && x.trim() ? ` (${x.trim()})` : '');
  const fields = [
    `Исполнитель — ${f.assigneeName ? `${f.assigneeName}${why(f.assigneeWhy)}` : 'не назначен'}`,
    `проект — ${f.projectName ? `${f.projectName}${why(f.projectWhy)}` : 'не выбран'}`,
    `срок — ${fmtDeadline(f.deadlineAt, f.timeZone)}`,
    `приоритет — ${PRIORITY_RU[f.priority] ?? PRIORITY_RU.normal}`,
    `теги — ${f.tags.length ? f.tags.join(', ') : 'без тегов'}`,
  ].join(', ');
  const summary = `${fields}. ${f.edited ? 'Вы уже поправили задачу — проверьте, всё ли ок.' : 'Проверьте, всё ли ок.'}`;
  return { title: title.slice(0, 200), summary, why: 'Задача поставлена автоматически по вашему тексту — проект, исполнителя, теги и приоритет выбрала система.' };
}
