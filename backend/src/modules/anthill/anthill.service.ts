import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { TasksService } from '../tasks/tasks.service';
import { ChatsService } from '../chats/chats.service';
import { SearchService } from '../search/search.service';
import { NlService } from '../nl/nl.service';
import { AskService } from '../assistant/ask.service';
import { AnthillRepository, Source } from './anthill.repository';
import { buildTools, ToolContext, ToolDef } from './tools';

/** Что открыто у человека — для «что здесь нужно сделать» без ссылки (разд. 4–5). */
export interface PageContext { type: 'task' | 'project' | 'chat' | 'meeting'; id: string }

/** События потока: этап → дельты текста → источники и действие → конец. */
export type StreamEvent =
  | { type: 'status'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'action'; action: { id: string; tool: string; preview: string } }
  | { type: 'done'; messageId: string }
  | { type: 'error'; text: string };

const MAX_CALLS = 4;

/**
 * AnthillBot — оркестратор (ТЗ-6, разд. 48).
 *
 * Два вызова модели на вопрос. Первый — план: какие инструменты позвать и с
 * какими параметрами (структурированный JSON). Второй — ответ по результатам
 * инструментов, потоком, со ссылками только на то, что инструменты отдали.
 * Пишущее действие моделью не исполняется: она отдаёт параметры, мы показываем
 * карточку и ждём «Создать» (разд. 12, 49).
 *
 * Модель не видит базу. Она видит текст, который инструменты собрали от имени
 * человека, — и потому не может ни увидеть лишнего, ни сослаться на выдуманное.
 */
@Injectable()
export class AnthillService {
  private readonly log = new Logger('Anthill');
  private readonly tools: ToolDef[];

  constructor(
    private readonly repo: AnthillRepository,
    private readonly ai: AiService,
    tasks: TasksService, chats: ChatsService, search: SearchService, nl: NlService, ask: AskService,
  ) {
    this.tools = buildTools({ repo, tasks, chats, search, nl, ask });
  }

  private base() { return (process.env.APP_BASE_URL || 'https://teamsmrt.com').replace(/\/+$/, ''); }

  // ── сессии ──
  sessions(tenantId: string, userId: string) {
    return this.repo.sessions(tenantId, userId).then((rows) => rows.map((s) => ({
      id: String(s.id), title: s.title ?? (s.first_question ? s.first_question.slice(0, 80) : 'Новый разговор'),
      messages: Number(s.messages), updatedAt: s.updated_at, context: s.context_entity_type ? { type: s.context_entity_type, id: String(s.context_entity_id) } : null,
    })));
  }

  async start(tenantId: string, userId: string, ctx?: PageContext | null) {
    const s = await this.repo.createSession(tenantId, userId, ctx ?? null);
    return { id: String(s.id) };
  }

  async messages(tenantId: string, userId: string, sessionId: string) {
    if (!(await this.repo.session(tenantId, userId, sessionId))) throw AppException.notFound('Разговор не найден');
    const rows = await this.repo.messages(sessionId);
    const actions = new Map<string, { status: string; output: Record<string, unknown> | null }>();
    for (const m of rows) if (m.action_id) {
      const a = await this.repo.action(tenantId, userId, m.action_id);
      if (a) actions.set(String(m.action_id), { status: a.status, output: a.output_json });
    }
    return rows.map((m) => ({
      id: String(m.id), role: m.role, content: m.content, citations: m.citations ?? [], createdAt: m.created_at,
      action: m.action_id ? { id: String(m.action_id), ...(actions.get(String(m.action_id)) ?? { status: 'pending', output: null }) } : null,
    }));
  }

  async remove(tenantId: string, userId: string, sessionId: string) {
    if (!(await this.repo.deleteSession(tenantId, userId, sessionId))) throw AppException.notFound('Разговор не найден');
    return { deleted: true };
  }

  // ── вопрос ──
  async ask(
    tenantId: string, user: { userId: string; role: string }, sessionId: string,
    question: string, ctx: PageContext | null, emit: (e: StreamEvent) => void, aborted: () => boolean,
  ): Promise<void> {
    const text = String(question ?? '').trim();
    if (text.length < 2) throw AppException.validation('Слишком короткий вопрос');
    const session = await this.repo.session(tenantId, user.userId, sessionId);
    if (!session) throw AppException.notFound('Разговор не найден');
    const tctx: ToolContext = { tenantId, user, now: new Date(), base: this.base() };

    await this.repo.addMessage({ tenantId, sessionId, role: 'user', content: text });
    if (!session.title) await this.repo.setTitle(String(session.id), text);

    const history = (await this.repo.messages(sessionId, 12)).slice(0, -1)
      .map((m) => ({ role: m.role, text: m.content.slice(0, 1200) }));

    // Контекст страницы — тем же инструментом, что и по просьбе: права те же.
    let pageText = '';
    const pageCtx = ctx ?? (session.context_entity_type ? { type: session.context_entity_type as PageContext['type'], id: String(session.context_entity_id) } : null);
    const sources: Source[] = [];
    if (pageCtx) {
      emit({ type: 'status', text: 'Смотрю, что открыто…' });
      const r = await this.runTool(tctx, pageCtx.type === 'task' ? 'get_task' : pageCtx.type === 'project' ? 'get_project' : pageCtx.type === 'meeting' ? 'get_meeting' : 'chat_recent',
        pageCtx.type === 'task' ? { taskId: pageCtx.id } : pageCtx.type === 'project' ? { project: pageCtx.id } : pageCtx.type === 'meeting' ? { meetingId: pageCtx.id } : { chatId: pageCtx.id, limit: 40 });
      if (r) { pageText = `ТЕКУЩИЙ КОНТЕКСТ (открыто у человека):\n${r.text}`; sources.push(...r.sources); }
    }
    if (aborted()) return;

    // 1. План
    emit({ type: 'status', text: 'Думаю, где искать…' });
    const plan = await this.plan(tenantId, text, history, pageText);
    if (aborted()) return;

    // 2. Инструменты
    const used: { tool: string; params: Record<string, unknown> }[] = [];
    const findings: string[] = [];
    for (const call of plan.calls.slice(0, MAX_CALLS)) {
      const def = this.tools.find((t) => t.name === call.tool && t.kind === 'read');
      if (!def) continue;
      emit({ type: 'status', text: STATUS_OF[call.tool] ?? `Проверяю: ${call.tool}…` });
      const r = await this.runTool(tctx, call.tool, call.params);
      if (!r) continue;
      used.push({ tool: call.tool, params: call.params });
      findings.push(`[${call.tool}]\n${r.text}`);
      sources.push(...r.sources);
      if (aborted()) return;
    }

    // 3. Действие — карточка на подтверждение, без ответа моделью
    if (plan.action) {
      const def = this.tools.find((t) => t.name === plan.action!.tool && t.kind === 'write');
      if (def?.preview) {
        emit({ type: 'status', text: 'Готовлю карточку…' });
        try {
          const pv = await def.preview(tctx, plan.action.params);
          const action = await this.repo.createAction({ tenantId, sessionId, userId: user.userId, tool: def.name, input: pv.params });
          const msg = await this.repo.addMessage({ tenantId, sessionId, role: 'assistant', content: pv.text, tools: used, actionId: String(action.id) });
          emit({ type: 'delta', text: pv.text });
          emit({ type: 'action', action: { id: String(action.id), tool: def.name, preview: pv.text } });
          emit({ type: 'done', messageId: String(msg.id) });
          await this.repo.touch(sessionId);
          return;
        } catch (e) {
          findings.push(`[${def.name}] не удалось подготовить: ${(e as Error).message}`);
        }
      }
    }

    // 4. Ответ потоком, только по найденному
    emit({ type: 'status', text: 'Формирую ответ…' });
    const uniq = dedupeSources(sources);
    const numbered = uniq.map((s, i) => `[${i + 1}] ${s.title}`).join('\n');
    const payload = JSON.stringify({
      question: text, history, page: pageText || null,
      findings: findings.length ? findings.join('\n\n') : 'Инструменты ничего не нашли.',
      sources: numbered || 'нет',
      now: tctx.now.toLocaleString('ru-RU'),
    });
    let answer = '';
    try {
      answer = await this.ai.generateStream(tenantId, ANSWER_SYSTEM, payload, (d) => { if (!aborted()) { answer += d; emit({ type: 'delta', text: d }); } }, 'anthill_answer');
    } catch (e) {
      this.log.warn(`answer: ${(e as Error).message}`);
      if (!answer) { emit({ type: 'error', text: 'Не удалось получить ответ от модели. Попробуйте снова.' }); return; }
    }
    const cited = citedSources(answer, uniq);
    const msg = await this.repo.addMessage({ tenantId, sessionId, role: 'assistant', content: answer, citations: cited, tools: used });
    emit({ type: 'sources', sources: cited });
    emit({ type: 'done', messageId: String(msg.id) });
    await this.repo.touch(sessionId);
  }

  private async runTool(ctx: ToolContext, name: string, params: Record<string, unknown>) {
    const def = this.tools.find((t) => t.name === name);
    if (!def?.run) return null;
    try { return await def.run(ctx, params ?? {}); }
    catch (e) {
      this.log.warn(`tool ${name}: ${(e as Error).message}`);
      return { text: `Не удалось получить данные (${name}): ${(e as Error).message}`, sources: [] };
    }
  }

  /** План — структурированный JSON от модели; сломанный JSON = ответ без инструментов. */
  private async plan(tenantId: string, question: string, history: { role: string; text: string }[], page: string) {
    const catalog = this.tools.map((t) => ({ name: t.name, kind: t.kind, description: t.description, params: t.params }));
    const raw = await this.ai.generate(tenantId, PLAN_SYSTEM, JSON.stringify({ question, history, page: page || null, tools: catalog, now: new Date().toLocaleString('ru-RU') }), 'anthill_plan');
    const json = extractJson(raw);
    const calls = Array.isArray(json?.calls) ? json.calls.filter((c: any) => c && typeof c.tool === 'string').map((c: any) => ({ tool: String(c.tool), params: (c.params && typeof c.params === 'object') ? c.params : {} })) : [];
    const action = json?.action && typeof json.action.tool === 'string'
      ? { tool: String(json.action.tool), params: (json.action.params && typeof json.action.params === 'object') ? json.action.params : {} }
      : null;
    return { calls, action };
  }

  // ── действия ──
  async confirm(tenantId: string, user: { userId: string; role: string }, actionId: string) {
    const action = await this.repo.action(tenantId, user.userId, actionId);
    if (!action) throw AppException.notFound('Действие не найдено');
    if (action.status !== 'pending') throw AppException.conflict('Это действие уже обработано');
    const def = this.tools.find((t) => t.name === action.tool);
    if (!def?.execute) throw AppException.conflict('Такое действие больше недоступно');
    const tctx: ToolContext = { tenantId, user, now: new Date(), base: this.base() };
    try {
      const r = await def.execute(tctx, action.input_json);
      await this.repo.finishAction(String(action.id), 'done', r.output);
      if (action.session_id) {
        await this.repo.addMessage({ tenantId, sessionId: String(action.session_id), role: 'assistant', content: r.text, citations: r.sources });
        await this.repo.touch(String(action.session_id));
      }
      return { status: 'done', text: r.text, output: r.output, sources: r.sources, canUndo: !!def.undo };
    } catch (e) {
      await this.repo.finishAction(String(action.id), 'failed', null, (e as Error).message);
      throw AppException.conflict(`Не удалось выполнить: ${(e as Error).message}. Ваши данные сохранены — можно повторить.`);
    }
  }

  async reject(tenantId: string, user: { userId: string }, actionId: string) {
    const action = await this.repo.action(tenantId, user.userId, actionId);
    if (!action) throw AppException.notFound('Действие не найдено');
    if (action.status === 'pending') await this.repo.finishAction(String(action.id), 'rejected');
    return { status: 'rejected' };
  }

  async undo(tenantId: string, user: { userId: string; role: string }, actionId: string) {
    const action = await this.repo.action(tenantId, user.userId, actionId);
    if (!action) throw AppException.notFound('Действие не найдено');
    if (action.status !== 'done') throw AppException.conflict('Отменить можно только выполненное действие');
    const def = this.tools.find((t) => t.name === action.tool);
    if (!def?.undo) throw AppException.conflict('Это действие не отменяется — сделайте вручную');
    const text = await def.undo({ tenantId, user, now: new Date(), base: this.base() }, action.output_json ?? {});
    await this.repo.finishAction(String(action.id), 'undone');
    if (action.session_id) await this.repo.addMessage({ tenantId, sessionId: String(action.session_id), role: 'assistant', content: text });
    return { status: 'undone', text };
  }

  actions(tenantId: string, userId: string) {
    return this.repo.actions(tenantId, userId).then((rows) => rows.map((a) => ({
      id: String(a.id), tool: a.tool, status: a.status, input: a.input_json, output: a.output_json, error: a.error, createdAt: a.created_at,
    })));
  }

  async feedback(tenantId: string, userId: string, messageId: string, vote: 1 | -1, reason?: string | null, comment?: string | null) {
    const owner = await this.repo.messageOwner(tenantId, messageId);
    if (!owner || String(owner.user_id) !== String(userId)) throw AppException.notFound('Сообщение не найдено');
    await this.repo.feedback({ tenantId, messageId, userId, vote, reason, comment });
    return { ok: true };
  }
}

const STATUS_OF: Record<string, string> = {
  search_tasks: 'Ищу задачи…', get_task: 'Читаю задачу…', search_messages: 'Ищу в переписке…',
  chat_recent: 'Читаю чат…', whats_missed: 'Собираю пропущенное…', get_project: 'Смотрю проект…',
  search_meetings: 'Ищу миты…', get_meeting: 'Читаю итог мита…', team_status: 'Считаю по доскам…', global_search: 'Ищу по всему…',
};

function extractJson(raw: string): any {
  const s = String(raw ?? '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : s;
  const start = body.indexOf('{'); const end = body.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(body.slice(start, end + 1)); } catch { return null; }
}

function dedupeSources(list: Source[]): Source[] {
  const seen = new Set<string>(); const out: Source[] = [];
  for (const s of list) { const k = `${s.kind}:${s.id}`; if (!seen.has(k)) { seen.add(k); out.push(s); } }
  return out.slice(0, 40);
}

/** Из ответа берём только те источники, на которые модель сослалась номером [n]; без ссылок — первые пять. */
function citedSources(answer: string, sources: Source[]): Source[] {
  const nums = new Set<number>();
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) nums.add(Number(m[1]));
  const cited = [...nums].map((n) => sources[n - 1]).filter(Boolean);
  return cited.length ? cited : sources.slice(0, 5);
}

const PLAN_SYSTEM = [
  'Ты — планировщик AnthillBot, помощника в TeamCRM. По вопросу человека реши, какие инструменты вызвать.',
  'Отвечай ТОЛЬКО JSON вида {"calls":[{"tool":"имя","params":{...}}],"action":{"tool":"имя","params":{...}}|null}.',
  'calls — до четырёх инструментов вида read, в порядке вызова; для простого разговора без данных — пустой список.',
  'action — ОДИН инструмент вида write, только если человек просит что-то СДЕЛАТЬ (создать задачу, напомнить); иначе null.',
  'Если у человека открыта задача/проект/чат (поле page), пользуйся их номерами из page — не спрашивай ссылку.',
  'Даты вычисляй от now. Номера задач бери из вопроса или page — не придумывай.',
].join(' ');

const ANSWER_SYSTEM = [
  'Ты — AnthillBot, персональный AI-помощник в TeamCRM. Отвечай по-русски, коротко и по делу, как коллега.',
  'Отвечай ТОЛЬКО по findings и page: это данные, собранные для этого человека с его правами. Чего там нет — не выдумывай.',
  'Никогда не придумывай номера задач, имена, сроки, решения и ссылки. Если данных не хватает, так и скажи: «Я не нашёл подтверждения этого в доступных данных TeamCRM».',
  'Ссылайся на источники номерами в квадратных скобках, например [2], — только из списка sources. Номера задач пиши как #N.',
  'Сводки группируй по смыслу: Решения · Новые задачи · Проблемы · Требует вашего внимания — и только те разделы, где есть содержимое.',
  'Если просят чек-лист, дай список из 3–7 проверяемых шагов по данным задачи.',
].join(' ');
