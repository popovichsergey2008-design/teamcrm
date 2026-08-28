import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { PromptsService } from '../prompts/prompts.service';
import { TasksService } from '../tasks/tasks.service';
import { DealsService } from '../deals/deals.service';
import { SecretaryService } from '../secretary/secretary.service';
import { matchUserInText, normalizeDeadline } from './nl.match';
import {
  chooseProject, matchProjectInText, pickDeadline, pickPriority, PROJECT_HINT, taskTitleFrom,
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
  };
  deal?: { title: string; amount: number | null; plannedMargin: number | null; clientId: string | null; clientName: string | null; stage: string };
  context: { projects: { id: string; name: string }[]; users: { id: string; name: string }[]; clients: { id: string; name: string }[] };
}

const FALLBACK_SYSTEM = [
  'Ты — парсер команд CRM. По сообщению определи намерение (create_task | create_deal | none) и извлеки поля.',
  'В JSON-входе: text, projects[{id,name}], users[{id,name}], clients[{id,name}], today. Сопоставляй имена с id ТОЛЬКО из списков (иначе null, не выдумывай).',
  'title — формулировка человека дословно, без пересказа: сохраняй наклонение и залог, убирай лишь служебную обёртку команды («поставь задачу», «на Ивана»).',
  'Исполнитель называется после «на», «для», «поручи», «назначь»; имя обычно в косвенном падеже — это тот же человек.',
  'deadline — срок выполнения задачи, а не любая дата в тексте: если дата часть содержания задачи, ставь null.',
  'Относительные сроки переводи в YYYY-MM-DD относительно today. priority: low|normal|high|urgent.',
  'Верни СТРОГО JSON: {"intent":"","confidence":0,"task":{"title":"","description":null,"projectId":null,"assigneeId":null,"priority":"normal","deadline":null},"deal":{"title":"","amount":null,"plannedMargin":null,"clientId":null,"stage":"new"},"note":""}',
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
   * Whisper пишет то, что слышит: без словаря «TeamCRM» превращается в «Тим Сирей»,
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
      'Рабочая команда в TeamCRM.',
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
      base.task = {
        title: title.slice(0, 255), description: t.description ? String(t.description) : null,
        projectId, projectName: projectId ? projectSet.get(projectId)! : null,
        projectHint: projectId ? PROJECT_HINT[source] : '',
        assigneeId, assigneeName: assigneeId ? userSet.get(assigneeId)! : null,
        priority, deadline,
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
