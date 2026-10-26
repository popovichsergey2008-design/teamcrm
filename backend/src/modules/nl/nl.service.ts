import { ProjectResolverService } from './project-resolver.service';
import { WorkloadGuardService } from '../workload/workload.service';
import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { TagsService } from '../tags/tags.service';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { PromptsService } from '../prompts/prompts.service';
import { TasksService } from '../tasks/tasks.service';
import { SecurityService } from '../security/security.service';
import { DealsService } from '../deals/deals.service';
import { SecretaryService } from '../secretary/secretary.service';
import { UsersRepository } from '../users/users.repository';
import { matchUserInText, normalizeDeadline } from './nl.match';
import { splitCommand } from './split-command';
import { MIN_CONFIDENCE, SURE_CONFIDENCE } from './assignee-pick';
import { Department, departmentOf, isDepartment, isSkill, Skill, skillsCatalog } from '../team/skills';
import { directionsFromText, listItemsCount, MAX_AUTO_DIRECTIONS, TASK_DIRECTIONS } from '../team/direction-rules';
import {
  cleanTitle, pickApproval, pickDeadline, pickEstimate, pickPriority,
  taskTitleFrom,
} from './task-draft';
import { buildEventDraft, EventDraft } from './event-draft';
import { pickAutoProject } from './auto-task';
import { AutoConfirmService } from './auto-confirm.service';
import { OrgService } from '../org/org.service';
import { Org, ORG_PROMPT_HINT, orgForModel } from '../org/org-rules';
import { fastTitleFrom, NL_FAST_BUDGET_MS, NL_FAST_MAX_TOKENS, NlTiming } from './fast-path';

type Intent = 'create_task' | 'create_deal' | 'none';

/** Как разбирать: обстановка, авто-постановка и быстрый путь короткой фразы (#4666). */
export interface ParseOpts {
  currentKind?: 'board' | 'last';
  auto?: boolean;
  /** Короткая фраза: одна задача, быстрая модель с потолком по времени, теги параллельно. */
  fast?: boolean;
  /** Куда записать длительности этапов (журнал таймингов). */
  timing?: NlTiming;
}
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

export interface NlDraft {
  intent: Intent;
  confidence: number;
  note: string;
  warnings: string[];
  task?: {
    title: string; description: string | null;
    projectId: string | null; projectName: string | null;
    /** Почему выбран этот проект: человек должен видеть, откуда он взялся. */
    projectHint: string;
    /**
     * Определитель проекта (ТЗ-31): уверенность и варианты. HIGH — проект подставлен;
     * MEDIUM — варианты, человек выбирает; LOW — спрашиваем. Без проекта задача не создаётся.
     */
    projectResolution?: {
      predictedProjectId: string | null; confidence: number; level: 'HIGH' | 'MEDIUM' | 'LOW';
      resolution: string; reasonCodes: string[]; hint: string;
      candidates: { id: string; name: string }[]; notFoundName: string | null;
    };
    assigneeId: string | null; assigneeName: string | null;
    priority: string; deadline: string | null;
    /** Завершать только с согласия постановщика. Умолчание — да. */
    requiresApproval: boolean;
    /** Шаги выполнения: ИИ разбивает работу, человек правит перед созданием. */
    checklist: string[];
    /** Оценка трудозатрат в часах — только если названа в речи. */
    estimateHours?: number | null;
    /** Направления задачи (отметки в карточке): по словам и классификации, правятся в предпросмотре. */
    directions?: Skill[];
    /** #4615: исполнитель назван в самой фразе — он главнее подбора. */
    assigneeNamed?: boolean;
    /** #4615, автоматическая постановка: черновик собран без вопросов. */
    auto?: boolean;
    /** Почему этот исполнитель — словами, для сводки и сообщения-подтверждения. */
    assigneeWhy?: string;
    /** Теги, подобранные ИИ: в автоматической постановке принимаются сами. */
    autoTags?: { id: string; name: string; color: string | null }[];
    /** #4615, 23.10: откуда исполнитель — назван, роль, руководитель отдела, тимлид, специалист, загрузка. */
    assigneeSource?: string;
    /** У направления нет руководителя — в сообщении-подтверждении спросим «кто отвечает». */
    noLeadFor?: Skill | null;
    /** Кого выбрала модель (по оргструктуре): берётся, только если исполнитель назван ролью. */
    modelAssigneeId?: string | null;
  };
  /**
   * Кому и почему предлагаем поручить задачу (ТЗ-10, этап 4).
   *
   * Это РЕКОМЕНДАЦИЯ: до нажатия «создать» её можно изменить, и решение человека
   * считается окончательным. Показываем и то, что предложила модель, — чтобы
   * постановщик видел, с чем он спорит.
   */
  routing?: {
    department: Department;
    skill: Skill | null;
    confidence: number;
    /** Кого предлагаем; null — никого не нашли, и это нормальный исход. */
    suggestedAssigneeId: string | null;
    suggestedAssigneeName: string | null;
    /** Словами: «по направлению работы», «нет свободного специалиста». */
    reason: string;
    /** Уверенная рекомендация или предположение: от этого зависит подача в интерфейсе. */
    sure: boolean;
  };
  deal?: { title: string; amount: number | null; plannedMargin: number | null; clientId: string | null; clientName: string | null; stage: string };
  context: { projects: { id: string; name: string }[]; users: { id: string; name: string }[]; clients: { id: string; name: string }[] };
}

/**
 * Задание модели: не пересказ, а постановка задачи.
 *
 * Раньше здесь стояло «title — формулировка человека дословно», и результат выглядел
 * как расшифровка диктофона: «надо посмотреть там эту страницу, мы вчера обсуждали».
 * Такую задачу исполнитель читает дважды и всё равно идёт переспрашивать.
 *
 * Теперь модель работает как менеджер, оформляющий поручение: понимает намерение,
 * отбрасывает разговорный шум, но НЕ выбрасывает требования и НЕ придумывает своих.
 * Граница между «улучшить форму» и «поменять содержание» — главное в этом задании,
 * поэтому она прописана явно и с примером.
 */
const FALLBACK_SYSTEM = [
  'Ты — постановщик задач в CRM, а не расшифровщик речи. Дослушай фразу целиком и только потом решай,',
  'что здесь название работы, что описание, а что служебное («задача на Сергея», «поставь задачу»).',
  'В JSON-входе: text, projects[{id,name,about?}] (about — ключевые слова и описание проекта), users[{id,name}], clients[{id,name}], today.',
  'Сопоставляй имена с id ТОЛЬКО из списков (иначе null, не выдумывай).',
  'title — НАЗВАНИЕ РАБОТЫ с глагола, до 70 символов, без имени исполнителя и без слова «задача».',
  'НЕПРАВИЛЬНО: «Задача на Сергея», «Сергею», «Нужно посмотреть». ПРАВИЛЬНО: «Добавить кнопку выхода из настройки меню».',
  'description — что не так, где, что сделать и каким должен быть результат, плюс названные условия.',
  'Наклонение и залог требований не меняй, условия не теряй, своих не добавляй. Мало сказано — дополни',
  'СТРУКТУРУ (что, где, признак готовности), но не придумывай новых требований и сроков.',
  'checklist — 3–6 шагов ПРОВЕРКИ «как понять, что сделано», выведенных из самой задачи, каждый с глагола.',
  'Шаги не расширяют задачу. Проверять нечего — пустой массив.',
  'Исполнитель называется после «на», «для», «поручи», «назначь»; имя обычно в косвенном падеже — это тот же человек.',
  'Постановщика не ищи: им становится говорящий, его подставит система.',
  'deadline — срок выполнения задачи, а не любая дата в тексте: если дата часть содержания, ставь null.',
  'Относительные сроки переводи в YYYY-MM-DD относительно today. priority: low|normal|high|urgent.',
  'requiresApproval — завершать ли задачу только с согласия постановщика. По умолчанию true.',
  'estimateHours — оценка трудозатрат в часах, ТОЛЬКО если человек её назвал («займёт 3 часа», «два дня работы» = 16); иначе null.',
  'false ставь, если сказано «можно закрывать без меня», «без согласования», «проверять не надо».',
  'Верни СТРОГО JSON: {"intent":"","confidence":0,"task":{"title":"","description":null,"projectId":null,',
  '"assigneeId":null,"priority":"normal","deadline":null,"requiresApproval":true,"estimateHours":null,"checklist":[]},',
  '"deal":{"title":"","amount":null,"plannedMargin":null,"clientId":null,"stage":"new"},"note":""}',
].join(' ');

@Injectable()
export class NlService {
  private readonly log = new Logger('NL');

  constructor(
    private readonly db: DbService,
    private readonly ai: AiService,
    private readonly prompts: PromptsService,
    private readonly tasks: TasksService,
    private readonly deals: DealsService,
    private readonly tags: TagsService,
    private readonly secretary: SecretaryService,
    private readonly users: UsersRepository,
    private readonly security: SecurityService,
    private readonly workload: WorkloadGuardService,
    private readonly projectResolver: ProjectResolverService,
    private readonly autoConfirm: AutoConfirmService,
    /** #4615, 23.10: структура компании и одно правило подбора исполнителя. */
    private readonly org: OrgService,
  ) {}

  private async roleOf(tenantId: string, userId: string): Promise<string | null> {
    return (await this.db.one<{ role: string }>(`SELECT r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id=$1 AND u.id=$2`, [tenantId, userId]))?.role ?? null;
  }

  /**
   * Люди, проекты и клиенты для разбора. Проекты — только живые и видимые человеку
   * (ТЗ-31, §23): модель не должна даже предлагать проект, которого человек не видит.
   */
  private async context(tenantId: string, userId?: string) {
    // #4666: запросы независимы — одновременно, а не цепочкой
    const [users, role, clients, org] = await Promise.all([
      this.db.many<{ id: string; name: string }>(
        `SELECT id, full_name AS name FROM users WHERE tenant_id=$1 AND is_active=TRUE ORDER BY full_name`, [tenantId]),
      userId ? this.roleOf(tenantId, userId) : Promise.resolve(null),
      this.db.many<{ id: string; name: string }>(
        `SELECT id, name FROM clients WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]).catch(() => []),
      // #4615, 23.10: модель понимает должности и иерархию компании — роль вместо имени
      this.org.snapshot(tenantId).catch(() => ({ people: [], departments: [] } as Org)),
    ]);
    const projects = userId && role
      ? (await this.projectResolver.candidates(tenantId, { userId, role })).map((p) => ({
        id: p.id, name: p.name,
        // #1580: модели — о чём проект и как его ещё называют, коротко
        ...(p.description || p.aliases?.length ? {
          about: [p.aliases?.length ? `ключевые слова: ${p.aliases.join(', ')}` : '', (p.description ?? '').slice(0, 200)].filter(Boolean).join('. '),
        } : {}),
      }))
      : await this.db.many<{ id: string; name: string }>(
        `SELECT id, name FROM projects WHERE tenant_id=$1 AND status <> 'archived' ORDER BY created_at DESC`, [tenantId]);
    return { users, projects, clients, org };
  }

  /** Структура для модели: только если компания её хоть как-то задала (иначе — лишние токены). */
  private static orgInput(org: Org) {
    return org.departments.length || org.people.some((p) => p.positionName) ? orgForModel(org) : undefined;
  }


  /**
   * Словарь для распознавания короткой команды.
   *
   * Whisper пишет то, что слышит: без словаря «QEVO» превращается в «Тим Сирей»,
   * а сотрудник, записанный в базе латиницей, — в постороннее слово. Даём ему имена
   * сотрудников (как они записаны), названия проектов и рабочие термины.
   */
  async speechHint(tenantId: string): Promise<string> {
    const [users, projects] = await Promise.all([
      this.db.many<{ name: string }>(
        `SELECT full_name AS name FROM users WHERE tenant_id=$1 AND is_active=TRUE ORDER BY full_name LIMIT 40`,
        [tenantId],
      ).catch(() => []),
      this.db.many<{ name: string }>(
        `SELECT name FROM projects WHERE tenant_id=$1 AND status <> 'archived' ORDER BY created_at DESC LIMIT 20`,
        [tenantId],
      ).catch(() => []),
    ]);
    return [
      'Рабочая команда в QEVO.',
      users.length ? `Сотрудники: ${users.map((u) => u.name).join(', ')}.` : '',
      projects.length ? `Проекты: ${projects.map((p) => p.name).join(', ')}.` : '',
      'Термины: задача, созвон, встреча, планёрка, проект, доска, срок, доработка, функционал.',
    ].filter(Boolean).join(' ');
  }

  /**
   * Надиктованная встреча → черновик события.
   *
   * Форму заполняет разбор, а не человек: он уже всё сказал вслух. Время и участников
   * считают правила (модель ошибается в датах и выдумывает людей), модель уточняет
   * название и описание — и если она недоступна, черновик всё равно приходит заполненным.
   *
   * `now` присылает клиент: «завтра в 15» — это его завтра и его пятнадцать часов,
   * а сервер живёт в своём поясе.
   */
  async parseEvent(tenantId: string, text: string, nowLocal?: string): Promise<EventDraft & {
    source: string;
    warnings: string[];
    context: { users: { id: string; name: string }[] };
  }> {
    const clean = (text ?? '').trim();
    if (clean.length < 3) throw AppException.validation('Слишком короткая команда');

    const users = await this.db.many<{ id: string; name: string }>(
      `SELECT id, full_name AS name FROM users WHERE tenant_id=$1 AND is_active=TRUE ORDER BY full_name`,
      [tenantId],
    );
    const now = parseClientNow(nowLocal);

    let model: Record<string, unknown> | null = null;
    try {
      const raw = await this.ai.generate(tenantId, EVENT_SYSTEM, JSON.stringify({ text: clean }), 'nl_event');
      model = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
    } catch (e) {
      // молчание модели — не повод отдавать пустую форму: дальше работают правила
      this.log.warn(`разбор встречи без модели: ${(e as Error).message}`);
    }

    const draft = buildEventDraft(clean, now, users, model);
    const warnings: string[] = [];
    // отдаём и саму фразу: человек должен видеть, что услышала система, иначе
    // «поставил не то время» невозможно ни объяснить, ни поправить
    if (!draft.startsAt) warnings.push('Время не прозвучало — проверьте дату и час');
    if (!draft.participantIds.length) warnings.push('Участники не названы — добавьте вручную, если нужны');
    return { ...draft, source: clean, warnings, context: { users } };
  }

  /**
   * NL → черновик сущности (ничего не создаёт). Имена сопоставляются с id из контекста арендатора.
   *
   * `currentProjectId` — доска, открытая у человека в момент команды. Это и есть тот
   * контекст, из-за отсутствия которого голосовая постановка упиралась в пустой выбор
   * проекта: продиктовал задачу, стоя на нужной доске, и всё равно выбирай руками.
   */
  /**
   * Разобрать одно поручение.
   *
   * `whole` — вся команда целиком, когда поручение из неё вырезано (задача #1344).
   * Человек называет проект, исполнителя и срок ОДИН раз на всю надиктовку: «Сергею
   * в проект QEVO TEAM на завтра. Первая задача… Вторая задача…». Кусок «Первая
   * задача — протестировать тест» не содержит ни проекта, ни имени, и правила,
   * работавшие только по нему, теряли сказанное — задачи уходили не в тот проект.
   * Поэтому: сначала ищем в самом поручении (своё сильнее общего), потом во всей фразе.
   */
  async parse(
    tenantId: string, userId: string, text: string,
    currentProjectId?: string | null, whole?: string | null,
    opts: ParseOpts = {},
  ): Promise<NlDraft> {
    const draft = await this.parseRaw(tenantId, userId, text, currentProjectId, whole, opts);
    // #4615, 23.10: исполнитель — по одному правилу для всех путей (бот, чат, входящие, /nl/parse)
    if (draft.task) {
      const src = (text ?? '').trim();
      await this.distribute(tenantId, userId, [{
        draft, item: null, source: src, around: whole ?? null,
        named: draft.task.assigneeNamed ? draft.task.assigneeId : null,
      }]);
    }
    return draft;
  }

  private async parseRaw(
    tenantId: string, userId: string, text: string,
    currentProjectId?: string | null, whole?: string | null,
    opts: ParseOpts = {},
  ): Promise<NlDraft> {
    const clean = (text ?? '').trim();
    /** Общая часть надиктовки: пусто, когда поручение и есть вся команда. */
    const around = (whole ?? '').trim() && (whole ?? '').trim() !== clean ? String(whole).trim() : '';
    if (clean.length < 3) throw AppException.validation('Слишком короткая команда');
    const tCtx = Date.now();
    const [{ users, projects, clients, org }, prompt] = await Promise.all([
      this.context(tenantId, userId),
      this.prompts.resolve(tenantId, 'nl.command', { today: new Date().toISOString().slice(0, 10) }, userId),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    if (opts.timing) opts.timing.contextMs = Date.now() - tCtx;

    const orgIn = NlService.orgInput(org);
    const system = `${prompt?.body ?? FALLBACK_SYSTEM}${orgIn ? ` ${ORG_PROMPT_HINT}` : ''}`;
    const userMsg = JSON.stringify({ text: clean, projects, users, clients, today, ...(orgIn ? { org: orgIn } : {}) });

    let parsed: any = {};
    let modelAnswered = false;
    const tModel = Date.now();
    let modelFail: string | null = null;
    try {
      /*
        #4666: короткая фраза — быстрая модель без рассуждения и потолок по времени.
        Не успела — заголовок правилами ниже: короткую задачу человек не должен ждать.
      */
      const raw = await this.ai.generate(tenantId, system, userMsg, 'nl_command', opts.fast
        ? { promptVersionId: prompt?.versionId, fast: true, timeoutMs: NL_FAST_BUDGET_MS, maxTokens: NL_FAST_MAX_TOKENS }
        : { promptVersionId: prompt?.versionId, model: prompt?.model, params: prompt?.params });
      parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
      modelAnswered = true;
    } catch (e) {
      modelFail = /timeout/i.test((e as Error).message) ? 'timeout' : 'error';
      this.log.warn(`parse failed: ${(e as Error).message}`);
    }
    if (opts.timing) {
      opts.timing.modelMs = Date.now() - tModel;
      opts.timing.model = modelAnswered ? 'ok' : modelFail ?? 'error';
    }

    // Модель не ответила (нет ключа, кончились деньги, вернула мусор) — человек всё
    // равно должен получить заполненный черновик: он свою фразу уже произнёс.
    // Раньше на этом месте показывалось «Не понял команду», и голосовая постановка
    // целиком зависела от чужой доступности.
    if (!modelAnswered) {
      parsed = opts.fast
        // #4666: короткая фраза — имя исполнителя и срок из названия срезаем, они в своих полях
        ? { intent: 'create_task', confidence: 0.4, task: { title: fastTitleFrom(clean, users.map((u) => u.name)) }, note: 'Собрал по вашей фразе' }
        : { intent: 'create_task', confidence: 0.4, task: { title: taskTitleFrom(clean) }, note: 'ИИ недоступен — собрал по вашей фразе' };
    }

    const warnings: string[] = [];
    const projectSet = new Map(projects.map((p) => [String(p.id), p.name]));
    const userSet = new Map(users.map((u) => [String(u.id), u.name]));
    const clientSet = new Map(clients.map((c) => [String(c.id), c.name]));
    const idIn = (v: any, set: Map<string, string>) => (v != null && set.has(String(v)) ? String(v) : null);

    const intent: Intent = ['create_task', 'create_deal'].includes(parsed?.intent) ? parsed.intent : 'none';
    const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence) || 0));
    const note = String(parsed?.note ?? '').slice(0, 300);
    const base: NlDraft = { intent, confidence, note, warnings, context: { projects, users, clients } };

    if (intent === 'create_task') {
      const t = parsed.task ?? {};
      const title = String(t.title ?? '').trim();
      if (!title) { base.intent = 'none'; warnings.push('Не понял, какую задачу создать'); return base; }
      /*
        Проект — определителем (ТЗ-31): названное в речи (и другие названия проекта),
        доска, на которой человек стоит, клиент, названные люди, недавнее; модель —
        только выбор среди своих. HIGH — подставляем; MEDIUM — варианты; LOW — спросим.
        «Лучше спросить, чем уверенно поставить не туда».
      */
      const named = [matchUserInText(clean, users), around ? matchUserInText(around, users) : null].filter(Boolean) as string[];
      const resolved = await this.projectResolver.resolve(tenantId, { userId, role: (await this.roleOf(tenantId, userId)) ?? 'member' }, {
        text: [clean, around].filter(Boolean).join(' '),
        sourceProjectId: currentProjectId && opts.currentKind !== 'last' ? String(currentProjectId) : null,
        peopleIds: named.length ? [userId, ...named] : [],
        model: idIn(t.projectId, projectSet) ? { projectId: String(t.projectId), confidence: Number(parsed?.confidence) || 0.6 } : null,
      }).catch((e) => { this.log.warn(`определитель проекта: ${(e as Error).message}`); return null; });
      // последняя открытая доска — только слабая подсказка: ставим её в варианты, если других нет
      const lastBoard = currentProjectId && opts.currentKind === 'last' && projectSet.has(String(currentProjectId)) ? String(currentProjectId) : null;
      /*
        #4615, автоматическая постановка: не спрашиваем. MEDIUM — лучший кандидат,
        LOW — открытая доска, иначе последний проект, где человек ставил задачи.
        Почему выбран — словами, это увидит постановщик в сообщении-подтверждении.
      */
      const auto = opts.auto ? pickAutoProject({
        level: resolved?.level ?? null, resolvedId: resolved?.projectId ?? null, resolvedHint: resolved?.hint ?? null,
        boardId: currentProjectId && opts.currentKind !== 'last' ? String(currentProjectId) : null,
        lastTaskProjectId: await this.lastTaskProject(tenantId, userId),
        lastBoardId: currentProjectId && opts.currentKind === 'last' ? String(currentProjectId) : null,
        alternatives: (resolved?.alternatives ?? []).map((a) => String(a.projectId)),
        visible: new Set(projectSet.keys()),
      }) : null;
      const projectId = auto ? auto.projectId : resolved?.level === 'HIGH' ? resolved.projectId : null;
      const candidates = resolved
        ? [...(resolved.projectId && resolved.level !== 'HIGH' ? [{ id: resolved.projectId, name: resolved.projectName ?? '' }] : []),
          ...resolved.alternatives.map((a) => ({ id: a.projectId, name: a.name })),
          ...(lastBoard ? [{ id: lastBoard, name: projectSet.get(lastBoard)! }] : [])]
          .filter((c, i, arr) => c.id !== projectId && arr.findIndex((x) => x.id === c.id) === i).slice(0, 3)
        : [];
      if (auto) {
        if (!projectId) warnings.push('Проект не определён — выберите проект');
        else if (resolved?.notFoundName) warnings.push(`Проекта «${resolved.notFoundName}» среди доступных нет — поставлю в «${projectSet.get(projectId)}»`);
      } else if (resolved?.notFoundName) warnings.push(`Проект «${resolved.notFoundName}» не найден среди доступных — выберите существующий`);
      else if (!projectId && candidates.length) warnings.push('К какому проекту относится задача? Выберите из вариантов');
      else if (!projectId) warnings.push('Проект не определён — выберите проект');
      // Модель часто не возвращает исполнителя, хотя он назван прямым текстом,
      // — тогда ищем имя в команде сами.
      const namedId = matchUserInText(clean, users) ?? (around ? matchUserInText(around, users) : null);
      const assigneeId = namedId ?? idIn(t.assigneeId, userSet);
      if (t.assigneeId && !assigneeId) warnings.push('Исполнитель не распознан');
      // Срочность и срок модель нередко пропускает, хотя они сказаны прямым текстом
      // («срочно», «к пятнице»), — то же самое разбирают правила.
      const priority = PRIORITIES.includes(String(t.priority)) ? String(t.priority)
        : pickPriority(clean) ?? (around ? pickPriority(around) : null) ?? 'normal';
      const deadline = normalizeDeadline(t.deadline, today)
        ?? pickDeadline(clean, new Date())
        ?? (around ? pickDeadline(around, new Date()) : null);
      if (t.deadline && !deadline) warnings.push('Срок не подставил: дата в прошлом или не распознана — выберите вручную');
      // Согласование считаем правилами: это переключатель права закрыть задачу,
      // и ошибка модели тут стоит дорого в обе стороны.
      const requiresApproval = pickApproval(clean);
      const checklist = Array.isArray(t.checklist)
        ? t.checklist.map((x: unknown) => String(x ?? '').trim()).filter(Boolean).slice(0, 12)
        : [];
      // Оценку сначала берём правилами: модель охотно «оценивает» сама, а нам нужна только названная
      const said = pickEstimate(clean) ?? (around ? pickEstimate(around) : null);
      const modelEst = Number(t.estimateHours);
      const estimateHours = said ?? (Number.isFinite(modelEst) && modelEst > 0 && modelEst <= 80 ? Math.round(modelEst * 2) / 2 : null);
      base.task = {
        // Последняя защита от «Задача на Сергея» в заголовке: модель иногда всё
        // равно берёт первую фразу, а список задач из адресатов нечитаем.
        title: cleanTitle(title, t.description ? String(t.description) : null).slice(0, 255),
        description: t.description ? String(t.description) : null,
        projectId, projectName: projectId ? projectSet.get(projectId)! : null,
        projectHint: auto ? auto.why : projectId && resolved ? resolved.hint : '',
        projectResolution: resolved ? {
          predictedProjectId: resolved.projectId, confidence: resolved.confidence, level: resolved.level,
          resolution: resolved.resolution, reasonCodes: resolved.reasonCodes, hint: resolved.hint,
          candidates, notFoundName: resolved.notFoundName,
        } : undefined,
        assigneeId, assigneeName: assigneeId ? userSet.get(assigneeId)! : null,
        priority, deadline, requiresApproval, checklist, estimateHours,
        assigneeNamed: !!namedId,
        modelAssigneeId: idIn(t.assigneeId, userSet),
      };
    } else if (intent === 'create_deal') {
      const d = parsed.deal ?? {};
      const title = String(d.title ?? '').trim();
      if (!title) { base.intent = 'none'; warnings.push('Не понял, какую сделку создать'); return base; }
      const amount = Number.isFinite(Number(d.amount)) && Number(d.amount) >= 0 ? Number(d.amount) : null;
      const pm = Number(d.plannedMargin);
      const plannedMargin = Number.isFinite(pm) && pm >= 0 && pm <= 100 ? pm : null;
      const clientId = idIn(d.clientId, clientSet);
      if (d.clientId && !clientId) warnings.push('Клиент не распознан');
      base.deal = {
        title: title.slice(0, 255), amount, plannedMargin,
        clientId, clientName: clientId ? clientSet.get(clientId)! : null,
        stage: String(d.stage ?? 'new').slice(0, 48) || 'new',
      };
    }
    return base;
  }

  /**
   * Несколько задач из одной надиктовки.
   *
   * В длинной записи человек обычно раздаёт работу пачкой: «Глебу — форму до пятницы,
   * Юрию — страницу услуги, и Алине проверить тексты». Разбирать это как одну задачу
   * значит потерять две трети сказанного, а просить надиктовать заново по одной —
   * издевательство над тем, кто только что говорил десять минут.
   *
   * Каждая задача проходит те же правила, что и одиночная: проект из обстановки,
   * исполнитель по имени, срок и приоритет — правилами, согласование — правилами.
   */
  async parseMany(
    tenantId: string, userId: string, text: string, currentProjectId?: string | null,
    opts: ParseOpts = {},
  ): Promise<NlDraft[]> {
    const t0 = Date.now();
    /*
      #4666: у короткой фразы теги подбираем ОДНОВРЕМЕННО с разбором — по самой фразе,
      с тем же потолком по времени. Раньше это был ещё один вызов модели после разбора.
    */
    const early = opts.auto && opts.fast
      ? this.tags.suggest(tenantId, { title: (text ?? '').trim() }, { fast: true, timeoutMs: NL_FAST_BUDGET_MS })
        .catch(() => null)
      : null;
    const drafts = await this.parseManyInner(tenantId, userId, text, currentProjectId, opts);
    const t1 = Date.now();
    // #4615: проект уже выбран в разборе; здесь — руководитель отдела и теги
    if (opts.auto) await this.autoFill(tenantId, drafts, early);
    if (opts.timing) {
      Object.assign(opts.timing, {
        path: opts.fast ? 'fast' : 'full', parseMs: t1 - t0, tagsWaitMs: Date.now() - t1,
        drafts: drafts.length, totalParseMs: Date.now() - t0,
      });
    }
    return drafts;
  }

  private async parseManyInner(
    tenantId: string, userId: string, text: string, currentProjectId: string | null | undefined,
    opts: ParseOpts,
  ): Promise<NlDraft[]> {
    const clean = (text ?? '').trim();
    if (clean.length < 3) throw AppException.validation('Слишком короткая команда');

    const { users, projects, clients, org } = await this.context(tenantId, userId);
    const today = new Date().toISOString().slice(0, 10);
    // Справочник отделов — модели, а не в коде промпта: список меняется, промпт нет.
    const orgIn = NlService.orgInput(org);
    const userMsg = JSON.stringify({ text: clean, projects, users, clients, today, catalog: skillsCatalog(), ...(orgIn ? { org: orgIn } : {}) });

    /*
      Счёт задач и одиночный разбор идут ОДНОВРЕМЕННО.

      Этим путём теперь ходит и набранная быстрая команда (задача #1344), а там чаще
      всего одна задача: ждать сначала «сколько их», а потом «оформи одну» — значит
      удвоить время ответа ради редкого случая. Одиночный черновик всё равно нужен как
      запасной, поэтому считаем его сразу и отдаём, если поручение оказалось одно.
    */
    const single = this.parseRaw(tenantId, userId, clean, currentProjectId, null, opts);
    // Если пачка собралась, одиночный ответ не нужен — но его отказ не должен всплыть необработанным.
    single.catch(() => undefined);
    /*
      #4666: короткая фраза — одно поручение. Счёт задач моделью ей не нужен: это был
      второй долгий вызов, которого ждал человек. Явные «и второе…» ловят правила
      (isShortCommand), поэтому сюда приходит только одна задача.
    */
    if (opts.fast) {
      const one = await single;
      if (one.task) await this.distribute(tenantId, userId, [{ draft: one, item: null, source: clean, around: null, named: one.task.assigneeNamed ? one.task.assigneeId : null }]);
      return [one];
    }
    let items: any[] = [];
    try {
      const raw = await this.ai.generate(tenantId, `${MANY_SYSTEM}${orgIn ? ` ${ORG_PROMPT_HINT.replace('assigneeId', 'assignee')}` : ''}`, userMsg, 'nl_command');
      const parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
      items = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    } catch (e) {
      this.log.warn(`разбор пачки задач без модели: ${(e as Error).message}`);
    }

    /*
      Модель промолчала или услышала одну задачу.

      Раньше здесь всегда отдавался один черновик — и три поручения, написанные
      человеком через «вторая задача», склеивались в одну бессмысленную задачу с
      заголовком во всю фразу (ТЗ-10, этап 1). Теперь пробуем разделить правилами:
      они берут только явные разделители — нумерацию, «вторая задача», «также»,
      перечисление строками. Не нашлось — прежний путь, один черновик.
    */
    if (items.length < 2) {
      const byRules = splitCommand(clean);
      if (byRules.length >= 2) {
        this.log.log(`команда разделена правилами на ${byRules.length}: модель не ответила`);
        const ruleDrafts = (await Promise.all(
          byRules.map((part) => this.parseRaw(tenantId, userId, part, currentProjectId, clean, opts).catch(() => null)),
        )).filter((d): d is NlDraft => !!d?.task);
        /*
          ТЗ по пунктам без модели (задача #1363). Раньше пункты здесь только делились:
          исполнителя по направлению получали лишь задачи, разобранные моделью, а на
          проде у новых организаций модели нет вовсе — и всё ТЗ уходило ничьим. Теперь
          каждый пункт раздаётся по словам так же, как одиночная задача в форме.
        */
        if (ruleDrafts.length > 1) {
          await this.distribute(tenantId, userId, ruleDrafts.map((d, i) => ({
            draft: d, item: null, source: byRules[i], around: clean,
            named: matchUserInText(byRules[i], users) ?? matchUserInText(clean, users),
          })));
          return ruleDrafts;
        }
      }
      const one = await single;
      // Одна задача: направления и исполнитель по словам, только если человека не назвали.
      if (one.task) await this.distribute(tenantId, userId, [{ draft: one, item: null, source: clean, around: null, named: one.task.assigneeNamed ? one.task.assigneeId : null }]);
      return [one];
    }

    // Каждую задачу пачки оформляем параллельно: три поручения не должны ждать втрое дольше.
    const parsedItems = await Promise.all(items.slice(0, 10).map(async (item) => {
      const title = String(item?.title ?? '').trim();
      if (!title) return null;
      // Кусок исходной речи, из которого выросла задача: по нему человек проверяет,
      // не выдумал ли ИИ, и правит формулировку осмысленно.
      const source = String(item?.source ?? '').trim() || clean;
      const draft = await this.parseRaw(tenantId, userId, source, currentProjectId, clean, opts).catch(() => null);
      if (!draft?.task) return null;
      draft.task.title = cleanTitle(title, item?.description ? String(item.description) : null).slice(0, 255);
      if (item?.description) draft.task.description = String(item.description);
      if (Array.isArray(item?.checklist)) {
        draft.task.checklist = item.checklist.map((x: unknown) => String(x ?? '').trim()).filter(Boolean).slice(0, 12);
      }
      // Имя, названное в команде: в самом поручении или в общей части надиктовки.
      // Для слов — только свой кусок: вся команда дала бы каждому пункту направления всего ТЗ.
      if (item?.assignee) {
        const fromModel = matchUserInText(String(item.assignee), users);
        if (fromModel) draft.task.modelAssigneeId = fromModel;
      }
      return {
        draft, item, source: String(item?.source ?? ''), around: clean,
        named: matchUserInText(source, users) ?? matchUserInText(clean, users),
      };
    }));
    const routed = parsedItems.filter((x): x is NonNullable<typeof x> => !!x);
    if (!routed.length) return [await single];
    await this.distribute(tenantId, userId, routed);
    return routed.map((x) => x.draft);
  }

  /**
   * Раздать задачи по ОДНОМУ правилу (#4615, 23.10; было #1363).
   *
   * Названный человек или роль («тимлиду фронта», «моему руководителю») → направление
   * задачи → отдел направления → его руководитель (постановщик сам руководит — тимлид
   * или наименее загруженный специалист отдела) → структуры нет — прежний подбор по
   * навыку и загрузке, с честной причиной. Только те, кто видит проект.
   *
   * По ОЧЕРЕДИ и с учётом уже розданного: три бэкенд-пункта ТЗ не уходят одному.
   */
  private async distribute(
    tenantId: string, userId: string,
    list: { draft: NlDraft; item: any; source: string; around?: string | null; named: string | null }[],
  ): Promise<void> {
    const org = await this.org.snapshot(tenantId).catch(() => ({ people: [], departments: [] } as Org));
    const seers = await this.org.seers(tenantId, list.map((x) => x.draft.task?.projectId).filter((p): p is string => !!p));
    for (const x of list) {
      const t = x.draft.task;
      if (!t) continue;
      const { skill, confidence, department, directions } = this.route(x.draft, x.item, x.source);
      const see = t.projectId ? seers.get(String(t.projectId)) ?? new Set<string>() : null;
      const canSee = (u: string) => !see || see.has(String(u));
      // роль ищем в своём куске, потом во всей надиктовке («руководителю дизайна: первое… второе…»)
      const decided = (txt: string) => this.org.decide(org, canSee, {
        authorId: userId, text: txt, directions: skill ? [skill, ...directions] : directions,
        namedUserId: x.named, modelAssigneeId: t.modelAssigneeId ?? null,
      });
      let c = decided([t.title, t.description ?? '', x.source].join('\n'));
      if (x.around && !x.named && (c.source === 'lead' || c.source === 'deputy' || c.source === 'member' || c.source === 'load' || c.source === 'none')) {
        const wide = decided([x.source, x.around].join('\n'));
        if (wide.source === 'role') c = wide;
      }
      t.directions = (directions.length ? directions : c.directions).filter((d) => TASK_DIRECTIONS.includes(d)).slice(0, MAX_AUTO_DIRECTIONS);
      x.draft.routing = {
        department, skill: c.skill ?? skill, confidence,
        suggestedAssigneeId: c.userId, suggestedAssigneeName: c.name, reason: c.reason,
        sure: confidence >= SURE_CONFIDENCE || c.source === 'named' || c.source === 'role' || c.source === 'lead',
      };
      t.assigneeNamed = c.source === 'named';
      t.assigneeId = c.userId;
      t.assigneeName = c.name;
      t.assigneeWhy = c.userId ? c.reason : '';
      t.assigneeSource = c.source;
      t.noLeadFor = c.noLeadFor;
      for (const w of c.warnings) if (!x.draft.warnings.includes(w)) x.draft.warnings.push(w);
      const got = org.people.find((p) => p.id === c.userId);
      if (got) got.openTasks += 1;
    }
  }

  /**
   * Направление, отдел и уверенность для одной задачи (ТЗ-10, этап 4). Исполнителя
   * здесь больше не выбираем — это делает одно правило в `distribute`.
   */
  private route(draft: NlDraft, item: any, source: string): { skill: Skill | null; confidence: number; department: Department; directions: Skill[] } {
    let skill: Skill | null = isSkill(item?.specialization) ? item.specialization : null;
    const raw = Number(item?.confidence);
    let confidence = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    // модель не уверена — её направлению не верим (ТЗ-10, разд. 38)
    if (skill && confidence < MIN_CONFIDENCE) skill = null;
    /*
      Направления по словам — те же правила, что в форме задачи (direction-rules.ts).
      Модель промолчала или не назвала направление — берём главное из слов.
    */
    const byWords = directionsFromText([draft.task?.title ?? '', draft.task?.description ?? '', source].join('\n'));
    if (!skill && byWords.length) { skill = byWords[0]; confidence = 1; }
    const department: Department = isDepartment(item?.department) && item.department !== 'unknown'
      ? item.department
      : departmentOf(skill);
    const directions = [...new Set([skill, ...byWords])]
      .filter((d): d is Skill => !!d && TASK_DIRECTIONS.includes(d))
      .slice(0, MAX_AUTO_DIRECTIONS);
    return { skill, confidence, department, directions };
  }

  /**
   * Автоматическая постановка (#4615): исполнитель уже выбран одним правилом, здесь —
   * пометка «авто» и теги, подобранные ИИ (принимаются сами).
   */
  private async autoFill(tenantId: string, drafts: NlDraft[], early: Promise<any> | null = null): Promise<void> {
    const list = drafts.filter((d) => d.task);
    if (!list.length) return;
    for (const d of list) d.task!.auto = true;
    // Теги — подбором ИИ из тегов компании; не подобрались — «без тегов».
    await Promise.all(list.map(async (d) => {
      const t = d.task!;
      // #4666: короткая фраза — теги уже подбираются параллельно разбору
      const r = early && list.length === 1 ? await early : await this.tags.suggest(tenantId, {
        title: t.title, description: t.description, checklist: t.checklist, projectName: t.projectName,
      }).catch(() => null);
      t.autoTags = (r?.suggestions ?? []).map((x: { tagId: string; name: string; color: string | null }) => ({ id: String(x.tagId), name: x.name, color: x.color ?? null }));
    }));
  }

  /** Последний проект, где человек ставил задачи (#4615: проект без вопросов). */
  private async lastTaskProject(tenantId: string, userId: string): Promise<string | null> {
    const row = await this.db.one<{ project_id: string }>(
      `SELECT t.project_id::text FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.tenant_id=$1 AND t.created_by=$2 AND t.deleted_at IS NULL AND p.status <> 'archived'
        ORDER BY t.created_at DESC LIMIT 1`, [tenantId, userId],
    ).catch(() => null);
    return row?.project_id ? String(row.project_id) : null;
  }

  /**
   * Автоподбор без модели (задачи #1295, #1363): направления по словам текста и
   * исполнитель среди людей с этим направлением, с учётом загрузки.
   *
   * Модель здесь не зовём намеренно — заказчик решил, что токены тратятся только по
   * кнопке. Правила бесплатны, поэтому форма может спрашивать их на лету. Если
   * направления заданы руками — берём их, а не угадываем по тексту.
   */
  async autoAssign(
    tenantId: string,
    input: { title: string; description?: string | null; projectId?: string | null; directions?: string[] | null },
    authorId: string | null = null,
  ) {
    const text = [input.title, input.description ?? ''].join('\n');
    const items = listItemsCount(String(input.description ?? ''));
    /*
      #4615, 23.10: то же правило, что в быстрой команде, — названный человек или роль,
      руководитель отдела направления, тимлид, специалист; структуры нет — по загрузке.
      Раньше форма брала только навык и загрузку — и «всегда подставляла Глеба».
    */
    const users = await this.db.many<{ id: string; name: string }>(
      `SELECT id::text, full_name AS name FROM users WHERE tenant_id=$1 AND is_active=TRUE`, [tenantId]).catch(() => []);
    const c = await this.org.chooseFor(tenantId, {
      authorId, text, projectId: input.projectId ? String(input.projectId) : null,
      directions: input.directions ?? null, namedUserId: matchUserInText(text, users),
    });
    const directions = c.directions.filter((d) => TASK_DIRECTIONS.includes(d));
    return {
      directions,
      assigneeId: c.userId,
      assigneeName: c.name,
      reason: c.reason,
      source: c.source,
      noLeadFor: c.noLeadFor,
      warnings: c.warnings,
      items,
    };
  }

  /**
   * Исполнитель для задачи из переписки (палочка в чате): правилами по словам, а если
   * направление не понять — классификацией модели; дальше — одно правило подбора.
   */
  async assigneeFor(
    tenantId: string, authorId: string | null,
    input: { title: string; description?: string | null; projectId?: string | null; text?: string | null },
  ) {
    const text = [input.title, input.description ?? '', input.text ?? ''].join('\n');
    const users = await this.db.many<{ id: string; name: string }>(
      `SELECT id::text, full_name AS name FROM users WHERE tenant_id=$1 AND is_active=TRUE`, [tenantId]).catch(() => []);
    const base = { authorId, text, projectId: input.projectId ? String(input.projectId) : null, namedUserId: matchUserInText(text, users) };
    const c = await this.org.chooseFor(tenantId, base);
    if (c.userId || c.skill) return c;
    const s = await this.classify(tenantId, [input.title, input.description ?? ''].filter(Boolean).join('. '));
    if (!s.skill || s.confidence < MIN_CONFIDENCE) return c;
    return this.org.chooseFor(tenantId, { ...base, directions: [s.skill] });
  }

  /** Отдел и направление готовой задачи моделью (одна задача, только классификация). */
  private async classify(tenantId: string, text: string): Promise<{ department: Department; skill: Skill | null; confidence: number }> {
    let department: Department = 'unknown';
    let skill: Skill | null = null;
    let confidence = 0;
    try {
      const raw = await this.ai.generate(tenantId, SUGGEST_SYSTEM, JSON.stringify({ text: text.slice(0, 1200), catalog: skillsCatalog() }), 'nl_command');
      const parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
      if (isDepartment(parsed?.department)) department = parsed.department;
      if (isSkill(parsed?.specialization)) skill = parsed.specialization;
      const c = Number(parsed?.confidence);
      confidence = Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0;
    } catch (e) {
      this.log.warn(`классификация задачи без модели: ${(e as Error).message}`);
    }
    return { department, skill, confidence };
  }

  /**
   * «Подобрать исполнителя» для обычной задачи (ТЗ-10, продолжение этапа 4).
   *
   * Быстрая команда классифицирует задачи заодно с разбором текста. В обычном окне
   * разбора нет: человек уже написал название. Поэтому отдельная ручка — и только по
   * нажатию кнопки, а не на каждую букву: решение заказчика, чтобы не тратить токены
   * на каждую создаваемую задачу.
   *
   * Модель молчит — отвечаем честно: «не смог определить», а не подставляем наугад.
   */
  async suggestAssignee(
    tenantId: string, input: { title: string; description?: string | null; projectId?: string | null },
    authorId: string | null = null,
  ) {
    const title = String(input.title ?? '').trim();
    if (title.length < 3) throw AppException.validation('Слишком короткое название задачи');

    const text = [title, input.description ? String(input.description).slice(0, 1000) : ''].filter(Boolean).join('. ');
    const { department, skill, confidence } = await this.classify(tenantId, text);
    // #4615, 23.10: кому — одним правилом (структура компании, видимость проекта, загрузка)
    const c = await this.org.chooseFor(tenantId, {
      authorId, text, projectId: input.projectId ? String(input.projectId) : null,
      directions: skill && confidence >= MIN_CONFIDENCE ? [skill] : [],
    });
    const unsure = !c.userId && (!skill || confidence < MIN_CONFIDENCE) && c.source === 'none';
    return {
      department, skill: c.skill ?? skill, confidence,
      suggestedAssigneeId: c.userId,
      suggestedAssigneeName: c.name,
      reason: unsure ? 'не уверен в направлении — выберите исполнителя сами' : c.reason,
      sure: confidence >= SURE_CONFIDENCE || c.source === 'lead' || c.source === 'role' || c.source === 'named',
    };
  }

  /** Применяет подтверждённый (возможно отредактированный) черновик — создаёт сущность. */
  /**
   * `interactive` — человек сидит в окне быстрой команды и может ответить на предупреждение
   * стража нагрузки. Остальные пути (бот, пакет, из сообщения, входящие) задачу ставят, а
   * перегруз приходит карточкой в ящик (ТЗ-21, этап 3).
   */
  async apply(tenantId: string, userId: string, body: { intent: Intent; task?: any; deal?: any }, opts: { interactive?: boolean } = {}) {
    if (body.intent === 'create_task') {
      const t = body.task ?? {};
      // проект — общей проверкой (ТЗ-31): нет, архив, недоступен человеку
      await this.tasks.assertProject(tenantId, t.projectId, { userId });
      if (!String(t.title ?? '').trim()) throw AppException.validation('Укажите название задачи');
      /*
        Теги подтверждены (ТЗ по тегам, п. 34 и 52).

        Через этот путь задача рождается из быстрой команды, голоса, пакета и разбора
        сообщения в чате — одна проверка на все четыре. Задачи, которые заводит сама
        система (импорты, повторы, встречи), идут мимо: подтверждать там некому.
      */
      /*
        #4615, автоматическая постановка: теги подобрал ИИ, и их проверку заменяет «Ок»
        постановщика в сообщении через 30 секунд. Исполнитель — только из видящих проект.
      */
      const auto = t.auto === true;
      const autoTagIds = Array.isArray(t.tagIds) ? t.tagIds.map(String).filter(Boolean) : [];
      await this.tags.assertGate(tenantId, auto
        ? { tagIds: autoTagIds, tagsConfirmed: true, confirmedWithoutTags: !autoTagIds.length }
        : { tagIds: t.tagIds, tagsConfirmed: t.tagsConfirmed, confirmedWithoutTags: t.confirmedWithoutTags });
      if (auto && t.assigneeId) {
        const seers = await this.org.seers(tenantId, [String(t.projectId)]);
        if (!seers.get(String(t.projectId))?.has(String(t.assigneeId))) {
          throw AppException.validation('Исполнитель не видит этот проект — выберите другого', { code: 'ASSIGNEE_CANNOT_SEE_PROJECT' });
        }
      }
      // Срок раньше дописывался строкой в описание («Срок: 2026-08-17») — задача выходила
      // без даты, и ни светофор, ни «просрочено» её не видели. Теперь это настоящее поле.
      /*
        Точный срок со временем (#1525): «Дедлайн на пятницу 15:00» из подсказки о
        перегрузе приходит готовым моментом — день без времени стал бы 18:00.
      */
      const exactAt = typeof t.deadlineAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(t.deadlineAt) && !Number.isNaN(Date.parse(t.deadlineAt))
        ? new Date(t.deadlineAt).toISOString() : undefined;
      const deadlineAt = exactAt ?? (/^\d{4}-\d{2}-\d{2}$/.test(String(t.deadline ?? ''))
        ? new Date(`${t.deadline}T18:00:00`).toISOString() // день без времени — считаем концом рабочего дня
        : undefined);
      // #4615, 23.10: в автоматической постановке радар перегрузки — только подсказка
      // (карточка в ящик после создания), а не вопрос, который останавливает постановку
      const guarded = !!opts.interactive && !auto;
      if (t.assigneeId && guarded) {
        await this.workload.guard({ tenantId, userId }, {
          assigneeId: String(t.assigneeId), projectId: String(t.projectId),
          priority: PRIORITIES.includes(String(t.priority)) ? String(t.priority) : null,
          deadlineAt: deadlineAt ?? null, directions: Array.isArray(t.directions) ? t.directions.map(String) : [], title: String(t.title),
        }, t.confirmWorkload === true);
      }
      const task = await this.tasks.create(tenantId, {
        projectId: String(t.projectId), title: String(t.title).trim().slice(0, 255),
        description: t.description ? String(t.description) : undefined,
        assigneeId: t.assigneeId ? String(t.assigneeId) : undefined,
        managerId: userId,
        priority: PRIORITIES.includes(String(t.priority)) ? String(t.priority) : undefined,
        deadlineAt,
        // человек мог снять галочку в предпросмотре — уважаем именно её, а не разбор
        requiresApproval: t.requiresApproval !== false,
        checklist: Array.isArray(t.checklist)
          ? t.checklist.map((x: unknown) => String(x ?? '').trim()).filter(Boolean)
          : undefined,
        directions: Array.isArray(t.directions) ? t.directions.filter(isSkill) : undefined,
      } as any, userId, { workloadChecked: guarded });
      await this.tags.applyToNewTask(tenantId, { userId }, String(task.id), String(task.project_id), {
        tagIds: Array.isArray(t.tagIds) ? t.tagIds.map(String) : [],
        suggestedTagIds: auto ? autoTagIds : Array.isArray(t.suggestedTagIds) ? t.suggestedTagIds.map(String) : [],
      });
      // #4615, 23.10: тегов нет и «без тегов» не сказано — ИИ ставит сам (если компания не просит подтверждать)
      const hasTags = auto ? autoTagIds.length > 0 : Array.isArray(t.tagIds) && t.tagIds.length > 0;
      if (!hasTags && (auto || t.confirmedWithoutTags !== true)) {
        void this.tags.autoTagNew(tenantId, { userId }, String(task.id), String(task.project_id), {
          title: task.title, description: task.description ?? null, checklist: Array.isArray(t.checklist) ? t.checklist.map(String) : [],
        });
      }
      void this.secretary.record({
        tenantId, userId, kind: 'nl_task',
        summary: `Задача из фразы: «${task.title}»`, subjectType: 'task', subjectId: task.id,
      });
      // Определитель предлагал проект — запоминаем, оставили его или выбрали другой (ТЗ-31, §25)
      const pr = t.projectResolution;
      if (pr && typeof pr === 'object') {
        void this.projectResolver.feedback(tenantId, userId, t.voice ? 'voice' : 'nl', {
          predictedProjectId: pr.predictedProjectId ? String(pr.predictedProjectId) : null,
          selectedProjectId: String(task.project_id), confidence: Number(pr.confidence) || null,
          resolution: pr.resolution ? String(pr.resolution).slice(0, 32) : null,
          reasonCodes: Array.isArray(pr.reasonCodes) ? pr.reasonCodes.map(String).slice(0, 10) : [], taskId: String(task.id),
        });
      }
      // #4615: через 30 секунд — «Задача поставлена, проверьте» (запись в базе, а не таймер)
      const confirmAt = auto
        ? await this.autoConfirm.schedule(tenantId, userId, String(task.id), {
          projectWhy: t.projectHint ? String(t.projectHint).slice(0, 200) : null,
          assigneeWhy: t.assigneeWhy ? String(t.assigneeWhy).slice(0, 200) : null,
          // у направления нет руководителя — спросим «кто отвечает» прямо в сообщении
          noLeadFor: isSkill(t.noLeadFor) && String(task.assignee_id ?? '') === String(t.assigneeId ?? '') ? t.noLeadFor : null,
        }).catch((e) => { this.log.warn(`подтверждение постановки ${task.id}: ${(e as Error).message}`); return null; })
        : null;
      return { type: 'task', task, ...(confirmAt ? { confirmAt } : {}) };
    }
    if (body.intent === 'create_deal') {
      // то же право, что у раздела сделок: быстрая команда не обходит его
      await this.security.require(tenantId, userId, 'crm.edit', 'Заводить сделки вам не разрешено');
      const d = body.deal ?? {};
      if (!String(d.title ?? '').trim()) throw AppException.validation('Укажите название сделки');
      if (d.clientId) {
        const ok = await this.db.one(`SELECT id FROM clients WHERE tenant_id=$1 AND id=$2`, [tenantId, d.clientId]).catch(() => null);
        if (!ok) throw AppException.validation('Клиент не найден');
      }
      const deal = await this.deals.create(tenantId, {
        title: String(d.title).trim().slice(0, 255),
        stage: d.stage ? String(d.stage) : undefined,
        clientId: d.clientId ? String(d.clientId) : undefined,
        amount: Number.isFinite(Number(d.amount)) ? Number(d.amount) : undefined,
        plannedMargin: Number.isFinite(Number(d.plannedMargin)) ? Number(d.plannedMargin) : undefined,
      });
      return { type: 'deal', deal };
    }
    throw AppException.validation('Неизвестное намерение');
  }
}

/**
 * Задание для длинной надиктовки: разложить речь на отдельные задачи.
 *
 * Отдельно от одиночного разбора, потому что задача здесь другая — не «оформи
 * поручение», а «пойми, сколько их». Границы те же: ничего не выдумывать и ничего
 * не терять. `source` — кусок речи про эту задачу; по нему дальше работают правила
 * (исполнитель, срок, приоритет, согласование), и он же показывается человеку.
 */
/** Классификация ОДНОЙ готовой задачи: отдел, направление, уверенность. Больше ничего. */
const SUGGEST_SYSTEM = [
  'Ты распределяешь задачи по отделам. На входе — название задачи и справочник отделов.',
  'Определи: department — код отдела из справочника или "unknown";',
  'specialization — направление из этого отдела или null;',
  'confidence — насколько ты уверен (0..1). Не уверен — ставь низкое, это нормально.',
  'Ничего не выдумывай и не предлагай исполнителя: людей ты не видишь.',
  'Верни СТРОГО JSON: {"department":"","specialization":null,"confidence":0}',
].join(' ');

const MANY_SYSTEM = [
  'Ты — постановщик задач. В сообщении человека может быть НЕСКОЛЬКО поручений разным людям.',
  'Раздели их: одна мысль о работе — одна задача. Если поручение одно, верни одну задачу.',
  'Для каждой: title — НАЗВАНИЕ РАБОТЫ с глагола (до 70 символов), без имени исполнителя',
  'и без слова «задача»: «Задача на Сергея» — это адресат, а не название;',
  'description — деловое описание без разговорного шума, с условиями, которые человек назвал;',
  'checklist — 3–6 шагов ПРОВЕРКИ «как понять, что сделано», выведенных из самой задачи;',
  'source — дословный кусок исходной речи, относящийся ИМЕННО к этой задаче.',
  'Ничего не выдумывай и не теряй названные условия. Не объединяй задачи разных людей.',
  // Классификация идёт ТЕМ ЖЕ вызовом (ТЗ-10, разд. 49): отдельная ручка стоила бы
  // лишнего запроса к модели на каждую задачу и рассинхрона с разбором.
  'Ещё для каждой задачи определи отдел и направление из справочника, который придёт во входных данных:',
  'department — код отдела или "unknown", если не относится ни к одному;',
  'specialization — направление из этого отдела или null;',
  'confidence — насколько ты уверен в этом (0..1, честно: не уверен — ставь низкое).',
  'assignee — имя исполнителя из users, ТОЛЬКО если он назван по имени или ролью (по org); иначе null.',
  'Верни СТРОГО JSON: {"tasks":[{"title":"","description":"","checklist":[],"source":"",',
  '"department":"","specialization":null,"confidence":0,"assignee":null}]}',
].join(' ');

/**
 * Модели достаётся только словесная часть: название и описание.
 *
 * Дат в задании нет намеренно — считать их будут правила. Модель, которой дали
 * «сегодня», исправно ошибается на день в конце месяца и в декабре, и эта ошибка
 * выглядит как назначенная не на тот день встреча.
 */
const EVENT_SYSTEM = [
  'Ты — парсер календаря. По фразе человека выдели название встречи и, если есть, описание и место.',
  'title — формулировка человека без служебной обёртки («поставь встречу», «созвон в 15»), в именительном виде.',
  'location — место, если названо словами (переговорная, офис, адрес). Ссылку на созвон местом не считай.',
  'Даты, время и участников НЕ извлекай — их разбирает система.',
  'Верни СТРОГО JSON: {"title":"","description":null,"location":null,"allDay":false}',
].join(' ');

/**
 * «Сейчас» глазами клиента. Формат — местное время без зоны (2026-08-27T11:00),
 * потому что весь разбор идёт в местном времени человека. Пусто или мусор —
 * считаем по серверу: это хуже, но лучше, чем отказ.
 */
function parseClientNow(value?: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(String(value ?? ''));
  if (!m) return new Date();
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}
