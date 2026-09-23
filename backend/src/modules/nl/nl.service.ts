import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { PromptsService } from '../prompts/prompts.service';
import { TasksService } from '../tasks/tasks.service';
import { DealsService } from '../deals/deals.service';
import { SecretaryService } from '../secretary/secretary.service';
import { UsersRepository } from '../users/users.repository';
import { matchUserInText, normalizeDeadline } from './nl.match';
import { splitCommand } from './split-command';
import { AssigneeCandidate, pickAssignee, SURE_CONFIDENCE } from './assignee-pick';
import { Department, isDepartment, isSkill, Skill, skillsCatalog } from '../team/skills';
import {
  chooseProject, cleanTitle, matchProjectInText, pickApproval, pickDeadline, pickPriority,
  PROJECT_HINT, taskTitleFrom,
} from './task-draft';
import { buildEventDraft, EventDraft } from './event-draft';

type Intent = 'create_task' | 'create_deal' | 'none';
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
    assigneeId: string | null; assigneeName: string | null;
    priority: string; deadline: string | null;
    /** Завершать только с согласия постановщика. Умолчание — да. */
    requiresApproval: boolean;
    /** Шаги выполнения: ИИ разбивает работу, человек правит перед созданием. */
    checklist: string[];
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
  'В JSON-входе: text, projects[{id,name}], users[{id,name}], clients[{id,name}], today.',
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
  'false ставь, если сказано «можно закрывать без меня», «без согласования», «проверять не надо».',
  'Верни СТРОГО JSON: {"intent":"","confidence":0,"task":{"title":"","description":null,"projectId":null,',
  '"assigneeId":null,"priority":"normal","deadline":null,"requiresApproval":true,"checklist":[]},',
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
    private readonly secretary: SecretaryService,
    private readonly users: UsersRepository,
  ) {}

  private async context(tenantId: string) {
    const users = await this.db.many<{ id: string; name: string }>(
      `SELECT id, full_name AS name FROM users WHERE tenant_id=$1 AND is_active=TRUE ORDER BY full_name`, [tenantId]);
    const projects = await this.db.many<{ id: string; name: string }>(
      `SELECT id, name FROM projects WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]);
    const clients = await this.db.many<{ id: string; name: string }>(
      `SELECT id, name FROM clients WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]).catch(() => []);
    return { users, projects, clients };
  }


  /**
   * Словарь для распознавания короткой команды.
   *
   * Whisper пишет то, что слышит: без словаря «ANTHILL» превращается в «Тим Сирей»,
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
      'Рабочая команда в ANTHILL.',
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
  async parse(tenantId: string, userId: string, text: string, currentProjectId?: string | null): Promise<NlDraft> {
    const clean = (text ?? '').trim();
    if (clean.length < 3) throw AppException.validation('Слишком короткая команда');
    const { users, projects, clients } = await this.context(tenantId);
    const today = new Date().toISOString().slice(0, 10);

    const prompt = await this.prompts.resolve(tenantId, 'nl.command', { today }, userId);
    const system = prompt?.body ?? FALLBACK_SYSTEM;
    const userMsg = JSON.stringify({ text: clean, projects, users, clients, today });

    let parsed: any = {};
    let modelAnswered = false;
    try {
      const raw = await this.ai.generate(tenantId, system, userMsg, 'nl_command', {
        promptVersionId: prompt?.versionId, model: prompt?.model, params: prompt?.params,
      });
      parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
      modelAnswered = true;
    } catch (e) {
      this.log.warn(`parse failed: ${(e as Error).message}`);
    }

    // Модель не ответила (нет ключа, кончились деньги, вернула мусор) — человек всё
    // равно должен получить заполненный черновик: он свою фразу уже произнёс.
    // Раньше на этом месте показывалось «Не понял команду», и голосовая постановка
    // целиком зависела от чужой доступности.
    if (!modelAnswered) {
      parsed = { intent: 'create_task', confidence: 0.4, task: { title: taskTitleFrom(clean) }, note: 'ИИ недоступен — собрал по вашей фразе' };
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
      // Проект — по всей доступной обстановке, а не только по ответу модели.
      const { projectId, source } = chooseProject({
        spokenId: matchProjectInText(clean, projects),
        modelId: idIn(t.projectId, projectSet),
        currentId: currentProjectId ? String(currentProjectId) : null,
        projects,
      });
      if (!projectId) warnings.push('Проект не распознан — выберите вручную');
      // Модель часто не возвращает исполнителя, хотя он назван прямым текстом,
      // — тогда ищем имя в команде сами.
      const assigneeId = idIn(t.assigneeId, userSet) ?? matchUserInText(clean, users);
      if (t.assigneeId && !assigneeId) warnings.push('Исполнитель не распознан');
      // Срочность и срок модель нередко пропускает, хотя они сказаны прямым текстом
      // («срочно», «к пятнице»), — то же самое разбирают правила.
      const priority = PRIORITIES.includes(String(t.priority)) ? String(t.priority)
        : pickPriority(clean) ?? 'normal';
      const deadline = normalizeDeadline(t.deadline, today) ?? pickDeadline(clean, new Date());
      if (t.deadline && !deadline) warnings.push('Срок не подставил: дата в прошлом или не распознана — выберите вручную');
      // Согласование считаем правилами: это переключатель права закрыть задачу,
      // и ошибка модели тут стоит дорого в обе стороны.
      const requiresApproval = pickApproval(clean);
      const checklist = Array.isArray(t.checklist)
        ? t.checklist.map((x: unknown) => String(x ?? '').trim()).filter(Boolean).slice(0, 12)
        : [];
      base.task = {
        // Последняя защита от «Задача на Сергея» в заголовке: модель иногда всё
        // равно берёт первую фразу, а список задач из адресатов нечитаем.
        title: cleanTitle(title, t.description ? String(t.description) : null).slice(0, 255),
        description: t.description ? String(t.description) : null,
        projectId, projectName: projectId ? projectSet.get(projectId)! : null,
        projectHint: projectId ? PROJECT_HINT[source] : '',
        assigneeId, assigneeName: assigneeId ? userSet.get(assigneeId)! : null,
        priority, deadline, requiresApproval, checklist,
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
  ): Promise<NlDraft[]> {
    const clean = (text ?? '').trim();
    if (clean.length < 3) throw AppException.validation('Слишком короткая команда');

    const { users, projects, clients } = await this.context(tenantId);
    const today = new Date().toISOString().slice(0, 10);
    // Справочник отделов — модели, а не в коде промпта: список меняется, промпт нет.
    const userMsg = JSON.stringify({ text: clean, projects, users, clients, today, catalog: skillsCatalog() });

    /*
      Счёт задач и одиночный разбор идут ОДНОВРЕМЕННО.

      Этим путём теперь ходит и набранная быстрая команда (задача #1344), а там чаще
      всего одна задача: ждать сначала «сколько их», а потом «оформи одну» — значит
      удвоить время ответа ради редкого случая. Одиночный черновик всё равно нужен как
      запасной, поэтому считаем его сразу и отдаём, если поручение оказалось одно.
    */
    const single = this.parse(tenantId, userId, clean, currentProjectId);
    // Если пачка собралась, одиночный ответ не нужен — но его отказ не должен всплыть необработанным.
    single.catch(() => undefined);
    let items: any[] = [];
    try {
      const raw = await this.ai.generate(tenantId, MANY_SYSTEM, userMsg, 'nl_command');
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
      if (byRules.length < 2) return [await single];
      this.log.log(`команда разделена правилами на ${byRules.length}: модель не ответила`);
      const ruleDrafts = (await Promise.all(
        byRules.map((part) => this.parse(tenantId, userId, part, currentProjectId).catch(() => null)),
      )).filter((d): d is NlDraft => !!d?.task);
      return ruleDrafts.length > 1 ? ruleDrafts : [await single];
    }

    // Кандидаты на исполнение — один раз на всю пачку: список один и тот же.
    const candidates = await this.autoCandidates(tenantId);
    // Каждую задачу пачки оформляем параллельно: три поручения не должны ждать втрое дольше.
    const parsedItems = await Promise.all(items.slice(0, 10).map(async (item) => {
      const title = String(item?.title ?? '').trim();
      if (!title) return null;
      // Кусок исходной речи, из которого выросла задача: по нему человек проверяет,
      // не выдумал ли ИИ, и правит формулировку осмысленно.
      const source = String(item?.source ?? '').trim() || clean;
      const draft = await this.parse(tenantId, userId, source, currentProjectId).catch(() => null);
      if (!draft?.task) return null;
      draft.task.title = cleanTitle(title, item?.description ? String(item.description) : null).slice(0, 255);
      if (item?.description) draft.task.description = String(item.description);
      if (Array.isArray(item?.checklist)) {
        draft.task.checklist = item.checklist.map((x: unknown) => String(x ?? '').trim()).filter(Boolean).slice(0, 12);
      }
      this.route(draft, item, candidates);
      return draft;
    }));
    const drafts = parsedItems.filter((d): d is NlDraft => !!d);
    return drafts.length ? drafts : [await single];
  }

  /**
   * Кандидаты для автоподбора: только те, кому разрешено ставить задачи (ТЗ-10, разд. 36).
   *
   * Список нужен и подбору, и промпту; берём его раз на всю пачку. Ошибка здесь не
   * должна ронять разбор: без кандидатов просто не будет рекомендации.
   */
  private async autoCandidates(tenantId: string): Promise<AssigneeCandidate[]> {
    try {
      const rows = await this.users.autoCandidates(tenantId);
      return rows.map((r) => ({
        userId: String(r.id), name: r.full_name,
        skills: (r.skills as string[]) ?? [],
        openTasks: Number(r.open_tasks ?? 0),
        weight: Number(r.weight ?? 1),
      }));
    } catch (e) {
      this.log.warn(`кандидаты для автоподбора не получены: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Отдел, направление и рекомендуемый исполнитель для одной задачи (ТЗ-10, этап 4).
   *
   * Исполнителя, названного в самой команде («поставь Глебу»), НЕ трогаем: явная
   * воля человека главнее любой рекомендации. Подставляем только туда, где его нет.
   */
  private route(draft: NlDraft, item: any, candidates: AssigneeCandidate[]): void {
    if (!draft.task) return;
    const department: Department = isDepartment(item?.department) ? item.department : 'unknown';
    const skill: Skill | null = isSkill(item?.specialization) ? item.specialization : null;
    const raw = Number(item?.confidence);
    const confidence = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;

    const pick = pickAssignee({ skill, confidence }, candidates);
    draft.routing = {
      department, skill, confidence,
      suggestedAssigneeId: pick.userId,
      suggestedAssigneeName: pick.name,
      reason: pick.reason,
      sure: confidence >= SURE_CONFIDENCE,
    };
    // Человек назвал исполнителя сам — рекомендация остаётся видимой, но поле не трогаем.
    if (!draft.task.assigneeId && pick.userId) {
      draft.task.assigneeId = pick.userId;
      draft.task.assigneeName = pick.name;
    }
  }

  /** Применяет подтверждённый (возможно отредактированный) черновик — создаёт сущность. */
  async apply(tenantId: string, userId: string, body: { intent: Intent; task?: any; deal?: any }) {
    if (body.intent === 'create_task') {
      const t = body.task ?? {};
      if (!t.projectId) throw AppException.validation('Выберите проект для задачи');
      if (!String(t.title ?? '').trim()) throw AppException.validation('Укажите название задачи');
      // Срок раньше дописывался строкой в описание («Срок: 2026-08-17») — задача выходила
      // без даты, и ни светофор, ни «просрочено» её не видели. Теперь это настоящее поле.
      const deadlineAt = /^\d{4}-\d{2}-\d{2}$/.test(String(t.deadline ?? ''))
        ? new Date(`${t.deadline}T18:00:00`).toISOString() // день без времени — считаем концом рабочего дня
        : undefined;
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
      } as any, userId);
      void this.secretary.record({
        tenantId, userId, kind: 'nl_task',
        summary: `Задача из фразы: «${task.title}»`, subjectType: 'task', subjectId: task.id,
      });
      return { type: 'task', task };
    }
    if (body.intent === 'create_deal') {
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
  'Верни СТРОГО JSON: {"tasks":[{"title":"","description":"","checklist":[],"source":"",',
  '"department":"","specialization":null,"confidence":0}]}',
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
