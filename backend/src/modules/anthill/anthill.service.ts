import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { TasksService } from '../tasks/tasks.service';
import { ChatsService } from '../chats/chats.service';
import { SearchService } from '../search/search.service';
import { NlService } from '../nl/nl.service';
import { AskService } from '../assistant/ask.service';
import { FilesService } from '../files/files.service';
import { TaskCardService } from '../taskcard/taskcard.service';
import { ForecastService } from '../forecast/forecast.service';
import { AnthillAdminService } from './anthill-admin.service';
import { CalendarService } from '../calendar/calendar.service';
import { AnthillRepository, ScheduleRow, SkillRow, Source } from './anthill.repository';
import { buildTools, ToolContext, ToolDef } from './tools';
import { nextRun, parseSchedule, Schedule, scheduleLabel } from './schedule-ru';

/** Что открыто у человека — для «что здесь нужно сделать» без ссылки (разд. 4–5). */
export interface PageContext { type: 'task' | 'project' | 'chat' | 'meeting'; id: string }

/** События потока: этап → дельты текста → источники и действие → конец. */
export type StreamEvent =
  | { type: 'status'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'sources'; sources: Source[] }
  | { type: 'action'; action: { id: string; tool: string; preview: string; fields: { key: string; label: string; type: string }[]; values: Record<string, string> } }
  | { type: 'done'; messageId: string }
  | { type: 'error'; text: string };

const MAX_CALLS = 4;
/** «Глубокий анализ»: три волны по шесть вызовов — дальше растёт цена, а не польза. */
const DEEP_WAVES = 3;
const DEEP_CALLS = 6;

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
    private readonly admin: AnthillAdminService,
    private readonly ai: AiService,
    tasks: TasksService, chats: ChatsService, search: SearchService, nl: NlService, ask: AskService,
    files: FilesService, taskcard: TaskCardService, forecast: ForecastService, calendar: CalendarService,
  ) {
    this.tools = buildTools({ repo, admin, calendar, tasks, chats, search, nl, ask, files, taskcard, forecast });
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
    const actions = new Map<string, ActionView>();
    for (const m of rows) if (m.action_id) {
      const a = await this.repo.action(tenantId, userId, m.action_id);
      if (a) actions.set(String(m.action_id), this.actionView(a));
    }
    return rows.map((m) => ({
      id: String(m.id), role: m.role, content: m.content, citations: m.citations ?? [], createdAt: m.created_at,
      action: m.action_id
        ? (actions.get(String(m.action_id)) ?? { id: String(m.action_id), tool: '', status: 'pending', output: null, fields: [], values: {} })
        : null,
    }));
  }

  /**
   * Карточка действия для экрана: статус, что можно поправить и текущие значения.
   * Поля описывает сам инструмент — панель не знает, из чего состоит задача.
   */
  private actionView(a: { id: string; tool: string; status: string; output_json: Record<string, unknown> | null; input_json: Record<string, unknown> }): ActionView {
    const def = this.tools.find((t) => t.name === a.tool);
    const editable = a.status === 'pending' && !!def?.edit;
    return {
      id: String(a.id), tool: a.tool, status: a.status, output: a.output_json,
      fields: editable ? (def?.fields ?? []) : [],
      values: editable ? (def?.values?.(a.input_json) ?? {}) : {},
    };
  }

  async remove(tenantId: string, userId: string, sessionId: string) {
    if (!(await this.repo.deleteSession(tenantId, userId, sessionId))) throw AppException.notFound('Разговор не найден');
    return { deleted: true };
  }

  // ── вопрос ──
  async ask(
    tenantId: string, user: { userId: string; role: string }, sessionId: string,
    question: string, ctx: PageContext | null, emit: (e: StreamEvent) => void, aborted: () => boolean,
    /** Навык выбран человеком руками — тогда подбирать свой агенту не нужно. */
    forcedSkillId?: string | null,
    /** «Глубокий анализ» (ТЗ-6, разд. 25): несколько волн поиска и отчёт по разделам. */
    deep = false,
  ): Promise<void> {
    const text = String(question ?? '').trim();
    if (text.length < 2) throw AppException.validation('Слишком короткий вопрос');
    const session = await this.repo.session(tenantId, user.userId, sessionId);
    if (!session) throw AppException.notFound('Разговор не найден');

    /*
      Что агенту позволено в этой организации (разд. 52–53).

      Проверяем ДО того, как потратить хоть один запрос к модели, и отвечаем словами,
      а не кодом ошибки: «AI_ERROR_403» человеку не говорит ничего, а «агент выключен
      администратором» — говорит всё.
    */
    const settings = await this.admin.get(tenantId);
    if (!settings.enabled) throw AppException.forbidden('AnthillBot выключен администратором организации.');
    if (!settings.allowedRoles.includes(user.role)) throw AppException.forbidden('У вашей роли нет доступа к AnthillBot. Попросите владельца включить его вашей роли.');
    const spent = await this.repo.askedToday(tenantId, user.userId);
    if (spent >= settings.limits.requestsPerDay) {
      throw AppException.conflict(`На сегодня исчерпан лимит вопросов к агенту (${settings.limits.requestsPerDay}). Лимит меняется в настройках агента.`);
    }
    if (deep) {
      if (settings.limits.deepPerDay <= 0) throw AppException.forbidden('Глубокий анализ выключен администратором.');
      const deepSpent = await this.repo.deepToday(tenantId);
      if (deepSpent >= settings.limits.deepPerDay) {
        throw AppException.conflict(`На сегодня исчерпан лимит глубоких разборов (${settings.limits.deepPerDay}). Обычный вопрос по-прежнему работает.`);
      }
    }
    const tctx: ToolContext = { tenantId, user, now: new Date(), base: this.base(), timezone: await this.repo.userTz(tenantId, user.userId) };

    await this.repo.addMessage({ tenantId, sessionId, role: 'user', content: text });
    if (!session.title) await this.repo.setTitle(String(session.id), text);

    const history = (await this.repo.messages(sessionId, settings.limits.contextMessages)).slice(0, -1)
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

    /*
      Навык (разд. 16–17): записанный порядок работы для того, что делают регулярно.

      Подбирается по запросу автоматически и называется вслух — человек должен
      видеть, ПОЧЕМУ отчёт получился именно такой формы, и уметь это отменить,
      выбрав другой навык или ни одного.
    */
    await this.ensureStarter(tenantId);
    const available = await this.repo.skills(tenantId, user.userId);
    let skill = forcedSkillId ? available.find((x) => String(x.id) === String(forcedSkillId)) ?? null : null;

    // 1. План. Инструменты урезаны по настройкам: чего нельзя, того модель и не видит —
    // так она не предложит человеку действие, которое всё равно будет отклонено.
    const allowed = this.tools.filter((t) => {
      if (t.kind === 'write' && !settings.actionsAllowed) return false;
      if (!settings.filesAllowed && (t.name === 'read_file' || t.name === 'list_files' || t.name === 'create_document')) return false;
      if (t.name === 'web_search' && !settings.webSearch) return false;
      if (t.name === 'create_event' && !settings.integrations) return false;
      return true;
    });
    emit({ type: 'status', text: 'Думаю, где искать…' });
    const plan = await this.plan(tenantId, text, history, pageText, skill ? [] : available, allowed);
    if (aborted()) return;
    if (!skill && plan.skill) skill = available.find((x) => String(x.id) === String(plan.skill)) ?? null;
    if (skill) {
      emit({ type: 'status', text: `Работаю по навыку «${skill.name}»…` });
      void this.repo.skillUsed(String(skill.id)).catch(() => undefined);
    }

    /*
      2. Инструменты.

      Обычный вопрос — одна волна: спросили, нашли, ответили. «Глубокий анализ» —
      до трёх волн: после каждой агент смотрит на найденное и решает, чего не
      хватает. Именно так человек и разбирается в незнакомом проекте — не одним
      запросом, а несколькими, уточняющими. Волны ограничены сверху: без предела
      разбор уходит в часы и в деньги, а полезного добавляет всё меньше.
    */
    const used: { tool: string; params: Record<string, unknown> }[] = [];
    const findings: string[] = [];
    const waves = deep ? DEEP_WAVES : 1;
    const perWave = deep ? DEEP_CALLS : MAX_CALLS;
    let calls = plan.calls;
    for (let wave = 0; wave < waves; wave += 1) {
      if (!calls.length) break;
      for (const call of calls.slice(0, perWave)) {
        const def = this.tools.find((t) => t.name === call.tool && t.kind === 'read');
        if (!def) continue;
        const label = STATUS_OF[call.tool] ?? `Проверяю: ${call.tool}…`;
        emit({ type: 'status', text: deep ? `Шаг ${wave + 1} из ${waves}: ${label}` : label });
        const r = await this.runTool(tctx, call.tool, call.params);
        if (!r) continue;
        used.push({ tool: call.tool, params: call.params });
        findings.push(`[${call.tool}]\n${r.text}`);
        sources.push(...r.sources);
        if (aborted()) return;
      }
      if (!deep || wave === waves - 1) break;
      emit({ type: 'status', text: 'Смотрю, чего не хватает…' });
      calls = await this.nextWave(tenantId, text, findings, used);
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
          emit({
            type: 'action',
            action: {
              id: String(action.id), tool: def.name, preview: pv.text,
              // поля для «Редактировать» — сразу: иначе поправить свежую карточку
              // можно было бы только после перезагрузки разговора
              fields: def.fields ?? [], values: def.values?.(pv.params) ?? {},
            },
          });
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
    const memory = await this.memoryLines(tenantId, user.userId);
    const payload = JSON.stringify({
      question: text, history, page: pageText || null,
      memory: memory.length ? memory : null,
      skill: skill ? { name: skill.name, steps: skill.steps, output: skill.output } : null,
      findings: findings.length ? findings.join('\n\n') : 'Инструменты ничего не нашли.',
      sources: numbered || 'нет',
      now: tctx.now.toLocaleString('ru-RU'),
    });
    let answer = '';
    try {
      answer = await this.ai.generateStream(tenantId, deep ? DEEP_SYSTEM : ANSWER_SYSTEM, payload, (d) => { if (!aborted()) { answer += d; emit({ type: 'delta', text: d }); } }, deep ? 'anthill_deep' : 'anthill_answer');
    } catch (e) {
      this.log.warn(`answer: ${(e as Error).message}`);
      if (!answer) { emit({ type: 'error', text: 'Не удалось получить ответ от модели. Попробуйте снова.' }); return; }
    }
    const cited = citedSources(answer, uniq);
    const msg = await this.repo.addMessage({ tenantId, sessionId, role: 'assistant', content: answer, citations: cited, tools: used });
    emit({ type: 'sources', sources: cited });
    emit({ type: 'done', messageId: String(msg.id) });
    await this.repo.touch(sessionId);
    // Память — после ответа и в стороне: человек не должен ждать, пока агент
    // осмыслит разговор, а сбой осмысления не должен портить уже полученный ответ.
    void this.learn(tenantId, user.userId, sessionId, text).catch(() => undefined);
  }

  // ── память (ТЗ-6, разд. 20–21) ──

  /** Строки памяти для подсказки модели: коротко и без мусора. */
  private async memoryLines(tenantId: string, userId: string): Promise<string[]> {
    const rows = await this.repo.memories(tenantId, userId, 20);
    return rows.map((m) => `${m.type === 'preference' ? 'предпочтение' : 'тема'}: ${m.title} — ${m.content}`);
  }

  /**
   * Что запомнить из реплики.
   *
   * Только то, что переживёт разговор: как человек работает и над чем работает.
   * Разовые вопросы («какие задачи просрочены») памятью не становятся — иначе она
   * за неделю превращается в свалку, а подсказка модели — в шум.
   */
  private async learn(tenantId: string, userId: string, sessionId: string, question: string): Promise<void> {
    if (!(await this.repo.memoryAuto(tenantId, userId))) return;
    let raw = '';
    try { raw = await this.ai.generate(tenantId, MEMORY_SYSTEM, question.slice(0, 1500), 'anthill_memory'); }
    catch { return; }
    const json = extractJson(`{"facts":${raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1) || '[]'}}`);
    const facts = Array.isArray(json?.facts) ? json.facts : [];
    for (const f of facts.slice(0, 3)) {
      const type = f?.type === 'preference' ? 'preference' : 'topic';
      const title = String(f?.title ?? '').trim().slice(0, 160);
      const content = String(f?.content ?? '').trim().slice(0, 600);
      if (title.length < 3 || content.length < 3) continue;
      await this.repo.rememberFact({ tenantId, userId, type, title, content, source: 'auto', sessionId });
    }
  }

  memories(tenantId: string, userId: string) {
    return this.repo.memories(tenantId, userId).then((rows) => rows.map(memoryView));
  }

  async addMemory(tenantId: string, userId: string, type: 'preference' | 'topic', title: string, content: string) {
    return memoryView(await this.repo.rememberFact({ tenantId, userId, type, title, content, source: 'manual' }));
  }

  async updateMemory(tenantId: string, userId: string, id: string, title: string, content: string) {
    const row = await this.repo.updateMemory(tenantId, userId, id, title, content);
    if (!row) throw AppException.notFound('Запись памяти не найдена');
    return memoryView(row);
  }

  async forget(tenantId: string, userId: string, id: string) {
    if (!(await this.repo.forget(tenantId, userId, id))) throw AppException.notFound('Запись памяти не найдена');
    return { deleted: true };
  }

  // ── навыки (разд. 16–19) ──

  async skills(tenantId: string, userId: string) {
    await this.ensureStarter(tenantId);
    const rows = await this.repo.skills(tenantId, userId);
    return rows.map((x) => skillView(x, userId));
  }

  /**
   * Стартовый набор — при первом открытии каталога.
   *
   * Заводится кодом, а не миграцией: организации появляются каждый день, и набор,
   * вписанный в миграцию один раз, достался бы только тем, кто существовал в день
   * выкладки. Один раз на организацию: дальше каталог живёт своей жизнью, и если
   * набор удалили — значит, он не нужен, возвращать его насильно нельзя.
   */
  private async ensureStarter(tenantId: string): Promise<void> {
    if (await this.repo.hasSkills(tenantId)) return;
    for (const s of STARTER_SKILLS) {
      await this.repo.createCommonSkill({ tenantId, ...s, inputs: s.inputs ?? [] }).catch(() => undefined);
    }
  }

  async addSkill(tenantId: string, userId: string, i: {
    name: string; description?: string; whenToUse?: string; steps: string[]; inputs?: string[]; output?: string; visibility?: 'private' | 'company';
  }) {
    const { limits } = await this.admin.get(tenantId);
    const mine = (await this.repo.skills(tenantId, userId)).filter((x) => String(x.owner_id ?? '') === String(userId));
    if (mine.length >= limits.maxSkills) {
      throw AppException.conflict(`Больше ${limits.maxSkills} навыков заводить нельзя — удалите ненужные или попросите поднять лимит.`);
    }
    const steps = i.steps.map((x) => String(x).trim()).filter(Boolean).slice(0, 15);
    if (steps.length < 1) throw AppException.validation('У навыка должен быть хотя бы один шаг');
    const row = await this.repo.createSkill({
      tenantId, ownerId: userId, name: i.name.trim().slice(0, 120),
      description: (i.description ?? '').slice(0, 500), whenToUse: (i.whenToUse ?? '').slice(0, 500),
      steps, inputs: (i.inputs ?? []).slice(0, 10), output: (i.output ?? '').slice(0, 500),
      visibility: i.visibility === 'company' ? 'company' : 'private',
    });
    return skillView(row, userId);
  }

  async editSkill(tenantId: string, userId: string, id: string, p: {
    name?: string; description?: string; whenToUse?: string; steps?: string[]; output?: string;
    visibility?: 'private' | 'company'; status?: 'active' | 'archived';
  }) {
    const row = await this.repo.updateSkill(tenantId, userId, id, {
      name: p.name ?? null, description: p.description ?? null, whenToUse: p.whenToUse ?? null,
      steps: p.steps ? p.steps.map((x) => String(x).trim()).filter(Boolean).slice(0, 15) : null,
      output: p.output ?? null, visibility: p.visibility ?? null, status: p.status ?? null,
    });
    // Навык компании из стартового набора чужой всем: его правит владелец, а его нет.
    if (!row) throw AppException.notFound('Навык не найден или он не ваш — сделайте копию под себя');
    return skillView(row, userId);
  }

  async removeSkill(tenantId: string, userId: string, id: string) {
    if (!(await this.repo.deleteSkill(tenantId, userId, id))) {
      throw AppException.notFound('Навык не найден или он не ваш');
    }
    return { deleted: true };
  }

  /** «Скопировать под себя»: общий навык — основа, дальше человек правит его как свой. */
  async forkSkill(tenantId: string, userId: string, id: string) {
    const src = await this.repo.skill(tenantId, userId, id);
    if (!src) throw AppException.notFound('Навык не найден');
    const row = await this.repo.createSkill({
      tenantId, ownerId: userId, name: `${src.name} (моя копия)`.slice(0, 120),
      description: src.description, whenToUse: src.when_to_use,
      steps: src.steps ?? [], inputs: src.inputs ?? [], output: src.output, visibility: 'private',
    });
    return skillView(row, userId);
  }

  // ── регулярные задачи (разд. 15) ──

  schedules(tenantId: string, userId: string) {
    return this.repo.schedules(tenantId, userId).then((rows) => rows.map(scheduleView));
  }

  /**
   * Завести регулярную задачу.
   *
   * Расписание разбираем правилами из той же фразы, которой человек её просил:
   * «каждый понедельник в 9:00 — список просроченных». Инструкцию оставляем целиком:
   * агент выполняет её так же, как если бы её задали вопросом в чате.
   */
  async addSchedule(tenantId: string, user: { userId: string }, i: { title: string; instruction: string; phrase?: string | null }) {
    const { limits } = await this.admin.get(tenantId);
    const mine = await this.repo.schedules(tenantId, user.userId);
    if (mine.length >= limits.maxScheduled) {
      throw AppException.conflict(`Больше ${limits.maxScheduled} регулярных задач заводить нельзя — удалите ненужные или попросите поднять лимит.`);
    }
    const schedule = parseSchedule(i.phrase || i.instruction);
    if (!schedule) throw AppException.validation('Не понял расписание — скажите, например, «каждый понедельник в 9:00»');
    const row = await this.repo.createSchedule({
      tenantId, userId: user.userId,
      title: i.title.slice(0, 160), instruction: i.instruction.slice(0, 2000),
      schedule: schedule as unknown as Record<string, unknown>,
      nextRunAt: nextRun(schedule, new Date(), await this.repo.userTz(tenantId, user.userId)),
    });
    return scheduleView(row);
  }

  async patchSchedule(tenantId: string, userId: string, id: string, p: {
    title?: string; instruction?: string; phrase?: string; status?: 'active' | 'paused' | 'done';
  }) {
    const cur = await this.repo.schedule(tenantId, userId, id);
    if (!cur) throw AppException.notFound('Регулярная задача не найдена');
    let schedule: Schedule | null = null;
    if (p.phrase) {
      schedule = parseSchedule(p.phrase);
      if (!schedule) throw AppException.validation('Не понял расписание — скажите, например, «каждую пятницу в 17:00»');
    }
    // Сняли с паузы или сменили расписание — следующий запуск считаем заново:
    // иначе задача просыпается в момент, о котором человек уже передумал.
    const revive = schedule || (p.status === 'active' && cur.status !== 'active');
    const row = await this.repo.updateSchedule(tenantId, userId, id, {
      title: p.title ?? null,
      instruction: p.instruction ?? null,
      schedule: schedule ? (schedule as unknown as Record<string, unknown>) : null,
      status: p.status ?? null,
      nextRunAt: revive ? nextRun(schedule ?? (cur.schedule as unknown as Schedule), new Date(), await this.repo.userTz(tenantId, userId)) : null,
    });
    return scheduleView(row!);
  }

  async removeSchedule(tenantId: string, userId: string, id: string) {
    if (!(await this.repo.deleteSchedule(tenantId, userId, id))) throw AppException.notFound('Регулярная задача не найдена');
    return { deleted: true };
  }

  /**
   * Один прогон регулярной задачи — тем же путём, что и вопрос человека.
   *
   * Результат ложится в СВОЮ нитку разговора: у задачи «каждый понедельник» своя
   * история, и по ней видно, как менялась картина неделя к неделе.
   */
  async runSchedule(row: ScheduleRow & { timezone: string | null; role: string }): Promise<{ text: string; sessionId: string }> {
    const user = { userId: String(row.user_id), role: row.role };
    let sessionId = row.session_id ? String(row.session_id) : '';
    if (!sessionId || !(await this.repo.session(String(row.tenant_id), user.userId, sessionId))) {
      const s = await this.repo.createSession(String(row.tenant_id), user.userId, null);
      sessionId = String(s.id);
      await this.repo.setTitle(sessionId, row.title);
      await this.repo.attachSession(String(row.id), sessionId);
    }
    let text = '';
    await this.ask(String(row.tenant_id), user, sessionId, row.instruction, null, (e) => {
      if (e.type === 'delta') text += e.text;
    }, () => false);
    return { text: text.trim(), sessionId };
  }

  /** Созревшие задачи — уже «занятые» этим процессом (см. claimDue). */
  async scheduleDue(): Promise<(ScheduleRow & { timezone: string | null; role: string })[]> {
    const rows = await this.repo.claimDue();
    const out: (ScheduleRow & { timezone: string | null; role: string })[] = [];
    for (const row of rows) {
      const meta = await this.repo.userMeta(String(row.tenant_id), String(row.user_id));
      out.push({ ...row, timezone: meta?.timezone ?? null, role: meta?.role ?? 'member' });
    }
    return out;
  }

  async afterRun(row: ScheduleRow & { timezone: string | null }, result: string | null, error: string | null) {
    const when = nextRun(row.schedule as unknown as Schedule, new Date(), row.timezone);
    await this.repo.finishRun(String(row.id), when, result ? result.slice(0, 4000) : null, error);
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
  private async plan(
    tenantId: string, question: string, history: { role: string; text: string }[], page: string,
    skills: SkillRow[] = [], allowed?: ToolDef[],
  ) {
    const catalog = (allowed ?? this.tools).map((t) => ({ name: t.name, kind: t.kind, description: t.description, params: t.params }));
    const skillList = skills.map((x) => ({ id: String(x.id), name: x.name, when: x.when_to_use }));
    const raw = await this.ai.generate(tenantId, PLAN_SYSTEM, JSON.stringify({ question, history, page: page || null, tools: catalog, skills: skillList, now: new Date().toLocaleString('ru-RU') }), 'anthill_plan');
    const json = extractJson(raw);
    const calls = Array.isArray(json?.calls) ? json.calls.filter((c: any) => c && typeof c.tool === 'string').map((c: any) => ({ tool: String(c.tool), params: (c.params && typeof c.params === 'object') ? c.params : {} })) : [];
    const action = json?.action && typeof json.action.tool === 'string'
      ? { tool: String(json.action.tool), params: (json.action.params && typeof json.action.params === 'object') ? json.action.params : {} }
      : null;
    const skill = json?.skill ? String(json.skill) : null;
    return { calls, action, skill };
  }

  /**
   * Вторая и третья волна поиска: чего не хватает после уже найденного.
   *
   * Спрашиваем модель коротко и получаем только вызовы инструментов. Пустой ответ —
   * законный: значит, данных достаточно, и лишний круг только сожжёт деньги.
   */
  private async nextWave(
    tenantId: string, question: string, findings: string[], used: { tool: string; params: Record<string, unknown> }[],
  ): Promise<{ tool: string; params: Record<string, unknown> }[]> {
    const catalog = this.tools.filter((t) => t.kind === 'read')
      .map((t) => ({ name: t.name, description: t.description, params: t.params }));
    let raw = '';
    try {
      raw = await this.ai.generate(tenantId, NEXT_WAVE_SYSTEM, JSON.stringify({
        question,
        alreadyCalled: used.map((u) => u.tool),
        found: findings.join('\n\n').slice(0, 12000),
        tools: catalog,
      }), 'anthill_deep');
    } catch { return []; }
    const json = extractJson(raw);
    if (!Array.isArray(json?.calls)) return [];
    return json.calls
      .filter((c: any) => c && typeof c.tool === 'string')
      .map((c: any) => ({ tool: String(c.tool), params: (c.params && typeof c.params === 'object') ? c.params : {} }));
  }

  // ── действия ──
  async confirm(tenantId: string, user: { userId: string; role: string }, actionId: string) {
    const action = await this.repo.action(tenantId, user.userId, actionId);
    if (!action) throw AppException.notFound('Действие не найдено');
    if (action.status !== 'pending') throw AppException.conflict('Это действие уже обработано');
    const def = this.tools.find((t) => t.name === action.tool);
    if (!def?.execute) throw AppException.conflict('Такое действие больше недоступно');
    const tctx: ToolContext = { tenantId, user, now: new Date(), base: this.base(), timezone: await this.repo.userTz(tenantId, user.userId) };
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

  /**
   * «Редактировать» в карточке: человек правит поля до создания.
   *
   * Переспрашивать модель ради одного слова дольше, чем исправить рукой, поэтому
   * правка идёт мимо модели — и карточка в истории переписывается на месте, чтобы
   * при следующем открытии разговора на экране было то, что подтвердили.
   */
  async edit(tenantId: string, user: { userId: string; role: string }, actionId: string, patch: Record<string, string>) {
    const action = await this.repo.action(tenantId, user.userId, actionId);
    if (!action) throw AppException.notFound('Действие не найдено');
    if (action.status !== 'pending') throw AppException.conflict('Это действие уже обработано');
    const def = this.tools.find((t) => t.name === action.tool);
    if (!def?.edit) throw AppException.conflict('Это действие правке не поддаётся');
    const tctx: ToolContext = { tenantId, user, now: new Date(), base: this.base(), timezone: await this.repo.userTz(tenantId, user.userId) };
    let r: { text: string; params: Record<string, unknown> };
    try { r = await def.edit(tctx, action.input_json, patch); }
    catch (e) { throw AppException.validation((e as Error).message); }
    await this.repo.updateActionInput(String(action.id), r.params);
    await this.repo.setActionMessageText(String(action.id), r.text);
    return { id: String(action.id), preview: r.text, values: def.values?.(r.params) ?? {} };
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

function skillView(x: SkillRow, userId: string) {
  return {
    id: String(x.id), name: x.name, description: x.description, whenToUse: x.when_to_use,
    steps: x.steps ?? [], inputs: x.inputs ?? [], output: x.output,
    visibility: x.visibility, uses: Number(x.uses), version: Number(x.version),
    mine: String(x.owner_id ?? '') === String(userId),
    /** Общий навык компании: показывается всем, правится только владельцем. */
    shared: x.visibility === 'company',
  };
}

function memoryView(m: { id: string; type: string; title: string; content: string; source: string; updated_at: Date }) {
  return { id: String(m.id), type: m.type, title: m.title, content: m.content, source: m.source, updatedAt: m.updated_at };
}

function scheduleView(s: ScheduleRow) {
  const sched = s.schedule as unknown as Schedule;
  return {
    id: String(s.id), title: s.title, instruction: s.instruction,
    schedule: sched, label: scheduleLabel(sched), status: s.status,
    nextRunAt: s.status === 'active' ? s.next_run_at : null,
    lastRunAt: s.last_run_at, lastResult: s.last_result, lastError: s.last_error,
    runs: Number(s.runs), sessionId: s.session_id ? String(s.session_id) : null,
  };
}

/** Карточка действия, как её видит панель. */
interface ActionView {
  id: string;
  tool: string;
  status: string;
  output: Record<string, unknown> | null;
  fields: { key: string; label: string; type: string }[];
  values: Record<string, string>;
}

const STATUS_OF: Record<string, string> = {
  search_tasks: 'Ищу задачи…', get_task: 'Читаю задачу…', search_messages: 'Ищу в переписке…',
  chat_recent: 'Читаю чат…', whats_missed: 'Собираю пропущенное…', get_project: 'Смотрю проект…',
  search_meetings: 'Ищу миты…', get_meeting: 'Читаю итог мита…', team_status: 'Считаю по доскам…', global_search: 'Ищу по всему…',
  list_files: 'Смотрю вложения…', read_file: 'Читаю файл…',
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

/**
 * Четыре сценария, которые спрашивают чаще всего (разд. 16).
 *
 * Это не «примеры для галочки»: по ним видно, из чего вообще состоит навык, и
 * первый свой человек обычно пишет, глядя на них.
 */
const STARTER_SKILLS: {
  name: string; description: string; whenToUse: string; steps: string[]; output: string; inputs?: string[];
}[] = [
  {
    name: 'Еженедельный отчёт по проекту',
    description: 'Что сделано за неделю, что застряло и что впереди — одним письмом.',
    whenToUse: 'просят отчёт по проекту за неделю, итоги недели, статус проекта',
    steps: [
      'Собрать задачи проекта, закрытые за последние 7 дней',
      'Собрать задачи в работе и просроченные',
      'Найти решения и договорённости в чате проекта и на митах за неделю',
      'Собрать одним текстом: Сделано · В работе · Риски · Планы на следующую неделю',
      'Сослаться на задачи номерами',
    ],
    inputs: ['проект'],
    output: 'Короткий отчёт по разделам со ссылками на задачи',
  },
  {
    name: 'Подготовка к миту',
    description: 'О чём говорить и что спросить — до встречи, а не после.',
    whenToUse: 'просят подготовиться к встрече, к созвону, к миту с клиентом',
    steps: [
      'Найти прошлые миты по этой теме и их итоги',
      'Поднять открытые задачи и договорённости, которые обещали к этой встрече',
      'Найти нерешённые вопросы в переписке по теме',
      'Собрать повестку из 3–6 пунктов и список вопросов',
    ],
    inputs: ['тема встречи или проект'],
    output: 'Повестка и вопросы к встрече',
  },
  {
    name: 'Проверка просроченного',
    description: 'Что горит прямо сейчас и что с этим делать.',
    whenToUse: 'спрашивают про просроченные задачи, что горит, где мы отстаём',
    steps: [
      'Собрать просроченные задачи человека и его команды',
      'Сгруппировать по проектам и по тому, насколько просрочено',
      'Для каждой указать, чего она ждёт: исполнителя, решения, согласования',
      'Предложить, что перенести, а что снять',
    ],
    output: 'Список просроченного с причинами и предложениями',
  },
  {
    name: 'Задача разработчику',
    description: 'Постановка, по которой можно начать работу, не переспрашивая.',
    whenToUse: 'просят поставить задачу разработчику, оформить требование, описать баг',
    steps: [
      'Уточнить, что именно сломано или что нужно сделать',
      'Собрать описание: что происходит, что должно происходить, где воспроизводится',
      'Добавить чек-лист проверки готовности',
      'Предложить исполнителя и срок',
    ],
    inputs: ['суть задачи'],
    output: 'Карточка задачи с описанием и чек-листом',
  },
];

const NEXT_WAVE_SYSTEM = [
  'Ты ведёшь глубокий разбор по данным TeamCRM. Тебе дали вопрос и то, что уже найдено.',
  'Реши, каких данных НЕ ХВАТАЕТ для полного ответа, и верни ТОЛЬКО JSON {"calls":[{"tool":"имя","params":{...}}]}.',
  'Не повторяй инструменты с теми же параметрами. Максимум шесть вызовов.',
  'Если данных достаточно — верни {"calls":[]}. Пустой ответ лучше лишнего круга поиска.',
].join(' ');

const DEEP_SYSTEM = [
  'Ты — AnthillBot, персональный AI-помощник в TeamCRM. Это ГЛУБОКИЙ РАЗБОР: человек ждёт отчёт, а не реплику.',
  'Отвечай ТОЛЬКО по findings и page — это данные, собранные с правами этого человека. Ничего не выдумывай.',
  'Структура ответа строго такая, и разделы озаглавлены словами:',
  'Выводы — 2–5 пунктов, самое важное первым.',
  'Ключевые факты — что именно нашлось, с номерами задач и датами.',
  'Риски — что может пойти не так и почему, по данным, а не по общим соображениям.',
  'Рекомендации — что сделать дальше, по пунктам и конкретно.',
  'Раздел, для которого нет данных, пропусти — пустые заголовки хуже их отсутствия.',
  'Ссылайся на источники номерами в квадратных скобках, например [2], — только из списка sources. Номера задач пиши как #N.',
  'Если среди источников есть материалы из интернета, отдельной строкой напиши «Источник: Интернет».',
  'skill — порядок работы для этого запроса: если он задан, иди по его шагам.',
  'memory — что известно об этом человеке: учитывай, но не пересказывай.',
].join(' ');

const MEMORY_SYSTEM = [
  'Ты выделяешь из реплики человека то, что стоит помнить о НЁМ надолго.',
  'Верни ТОЛЬКО JSON-массив: [{"type":"preference|topic","title":"коротко","content":"одно предложение"}].',
  'preference — как человек работает и как ему отвечать (часовой пояс, язык, формат, привычки).',
  'topic — над чем он работает сейчас (проект, направление, договорённость).',
  'Разовые вопросы, просьбы и факты из CRM памятью НЕ являются — на них верни [].',
  'Максимум три записи. Пиши по-русски.',
].join(' ');

const PLAN_SYSTEM = [
  'Ты — планировщик AnthillBot, помощника в TeamCRM. По вопросу человека реши, какие инструменты вызвать.',
  'Отвечай ТОЛЬКО JSON вида {"calls":[{"tool":"имя","params":{...}}],"action":{"tool":"имя","params":{...}}|null}.',
  'calls — до четырёх инструментов вида read, в порядке вызова; для простого разговора без данных — пустой список.',
  'action — ОДИН инструмент вида write, только если человек просит что-то СДЕЛАТЬ (создать задачу, напомнить); иначе null.',
  'skills — готовые сценарии. Если запрос похож на поле when у одного из них, верни его id в поле "skill"; иначе "skill": null. Один навык, не несколько.',
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
  'memory — что известно об этом человеке: учитывай его предпочтения и текущие темы, но НЕ пересказывай их и не считай фактами о CRM.',
  'skill — порядок работы для этого запроса: если он задан, иди по его шагам и приведи результат к описанной форме output.',
].join(' ');
