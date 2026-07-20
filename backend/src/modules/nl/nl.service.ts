import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { PromptsService } from '../prompts/prompts.service';
import { TasksService } from '../tasks/tasks.service';
import { DealsService } from '../deals/deals.service';

type Intent = 'create_task' | 'create_deal' | 'none';
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

export interface NlDraft {
  intent: Intent;
  confidence: number;
  note: string;
  warnings: string[];
  task?: { title: string; description: string | null; projectId: string | null; projectName: string | null; assigneeId: string | null; assigneeName: string | null; priority: string; deadline: string | null };
  deal?: { title: string; amount: number | null; plannedMargin: number | null; clientId: string | null; clientName: string | null; stage: string };
  context: { projects: { id: string; name: string }[]; users: { id: string; name: string }[]; clients: { id: string; name: string }[] };
}

const FALLBACK_SYSTEM = [
  'Ты — парсер команд CRM. По сообщению определи намерение (create_task | create_deal | none) и извлеки поля.',
  'В JSON-входе: text, projects[{id,name}], users[{id,name}], clients[{id,name}], today. Сопоставляй имена с id ТОЛЬКО из списков (иначе null, не выдумывай).',
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

  /** NL → черновик сущности (ничего не создаёт). Имена сопоставляются с id из контекста арендатора. */
  async parse(tenantId: string, userId: string, text: string): Promise<NlDraft> {
    const clean = (text ?? '').trim();
    if (clean.length < 3) throw AppException.validation('Слишком короткая команда');
    const { users, projects, clients } = await this.context(tenantId);
    const today = new Date().toISOString().slice(0, 10);

    const prompt = await this.prompts.resolve(tenantId, 'nl.command', { today }, userId);
    const system = prompt?.body ?? FALLBACK_SYSTEM;
    const userMsg = JSON.stringify({ text: clean, projects, users, clients, today });

    let parsed: any = {};
    try {
      const raw = await this.ai.generate(tenantId, system, userMsg, 'nl_command', {
        promptVersionId: prompt?.versionId, model: prompt?.model, params: prompt?.params,
      });
      parsed = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
    } catch (e) {
      this.log.warn(`parse failed: ${(e as Error).message}`);
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
      const projectId = idIn(t.projectId, projectSet);
      if (t.projectId && !projectId) warnings.push('Проект не распознан — выберите вручную');
      const assigneeId = idIn(t.assigneeId, userSet);
      if (t.assigneeId && !assigneeId) warnings.push('Исполнитель не распознан');
      const priority = PRIORITIES.includes(String(t.priority)) ? String(t.priority) : 'normal';
      const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(t.deadline ?? '')) ? String(t.deadline) : null;
      base.task = {
        title: title.slice(0, 255), description: t.description ? String(t.description) : null,
        projectId, projectName: projectId ? projectSet.get(projectId)! : null,
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
      let description = t.description ? String(t.description) : undefined;
      if (t.deadline && /^\d{4}-\d{2}-\d{2}$/.test(String(t.deadline))) {
        description = `${description ? description + '\n\n' : ''}Срок: ${t.deadline}`;
      }
      const task = await this.tasks.create(tenantId, {
        projectId: String(t.projectId), title: String(t.title).trim().slice(0, 255),
        description, assigneeId: t.assigneeId ? String(t.assigneeId) : undefined, managerId: userId,
      } as any, userId);
      if (t.priority && PRIORITIES.includes(String(t.priority)) && t.priority !== 'normal') {
        await this.tasks.update(tenantId, task.id, { priority: String(t.priority) } as any, userId).catch(() => undefined);
      }
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
