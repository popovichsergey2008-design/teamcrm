import { AnthillRepository, Source } from './anthill.repository';
import { nextRun, parseSchedule, scheduleLabel } from './schedule-ru';
import { TasksService } from '../tasks/tasks.service';
import { ChatsService } from '../chats/chats.service';
import { SearchService } from '../search/search.service';
import { NlService } from '../nl/nl.service';
import { AskService } from '../assistant/ask.service';

/**
 * Инструменты AnthillBot (ТЗ-6, разд. 48).
 *
 * Единственный путь модели к данным и действиям. Каждый инструмент читает через
 * те же сервисы и с теми же проверками, что и обычные ручки API, — модель видит
 * ровно то, что видит человек на экране (разд. 47: фильтрация ДО модели).
 *
 * Инструмент отдаёт две вещи: текст для модели и список источников. Источники —
 * это то, что потом станет кнопками «Открыть задачу #N» под ответом; модели
 * запрещено ссылаться на что-либо, чего в этом списке нет.
 *
 * Пишущие инструменты (kind: 'write') ничего не делают сразу: `preview` готовит
 * карточку на подтверждение, `execute` вызывается только после нажатия «Создать».
 */

export interface ToolContext {
  tenantId: string;
  user: { userId: string; role: string };
  now: Date;
  base: string;
  /** Пояс человека: «каждый понедельник в 9:00» — это его девять, а не серверные. */
  timezone?: string | null;
}

export interface ToolResult { text: string; sources: Source[] }

export interface ToolDef {
  name: string;
  kind: 'read' | 'write';
  /** Описание для модели: когда звать и с какими параметрами. По-русски — модель отвечает по-русски. */
  description: string;
  params: Record<string, string>;
  run?: (ctx: ToolContext, params: Record<string, unknown>) => Promise<ToolResult>;
  /** Только для write: карточка на подтверждение + нормализованные параметры. */
  preview?: (ctx: ToolContext, params: Record<string, unknown>) => Promise<{ text: string; params: Record<string, unknown> }>;
  /**
   * Что человек может поправить в карточке до «Создать» (ТЗ-6, разд. 62).
   *
   * Модель ошибается в мелочах — не в том проекте, срок на день раньше, название
   * канцелярское. Переспрашивать её ради одного слова дольше, чем исправить рукой,
   * поэтому карточка правится полями, а не новым вопросом.
   */
  fields?: { key: string; label: string; type: 'text' | 'multiline' | 'date' | 'datetime' }[];
  /** Значения полей для формы правки — из сохранённых параметров действия. */
  values?: (params: Record<string, unknown>) => Record<string, string>;
  /** Применить правку: вернуть новые параметры и новую карточку. */
  edit?: (ctx: ToolContext, params: Record<string, unknown>, patch: Record<string, string>) => Promise<{ text: string; params: Record<string, unknown> }>;
  execute?: (ctx: ToolContext, params: Record<string, unknown>) => Promise<{ text: string; output: Record<string, unknown>; sources: Source[] }>;
  undo?: (ctx: ToolContext, output: Record<string, unknown>) => Promise<string>;
}

export interface ToolDeps {
  repo: AnthillRepository;
  tasks: TasksService;
  chats: ChatsService;
  search: SearchService;
  nl: NlService;
  ask: AskService;
}

const str = (v: unknown, max = 200) => String(v ?? '').trim().slice(0, max);
const dateRu = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleDateString('ru-RU') : null);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function buildTools(deps: ToolDeps): ToolDef[] {
  const { repo, tasks, chats, search, nl, ask } = deps;

  /**
   * Карточка задачи на подтверждение.
   *
   * Собирается и при первом предложении, и после правки полей — вид у неё обязан
   * быть один: человек сверяет её глазами, и переехавшая строка читается как
   * «агент передумал». Имена проекта и исполнителя после правки берём из базы:
   * разбор речи их больше не подсказывает.
   */
  const taskCard = async (ctx: ToolContext, t: any, known?: { project?: string; assignee?: string }) => {
    let project = known?.project;
    if (!project && t.projectId) project = (await repo.project(ctx.tenantId, String(t.projectId)))?.name;
    let assignee = known?.assignee;
    if (!assignee && t.assigneeId) {
      assignee = (await repo.users(ctx.tenantId)).find((u) => String(u.id) === String(t.assigneeId))?.full_name;
    }
    const lines = [
      `Название: ${t.title}`,
      t.description ? `Описание: ${clip(String(t.description), 400)}` : null,
      `Исполнитель: ${assignee ?? 'не назначен'}`,
      `Срок: ${t.deadline ? dateRu(t.deadline) : 'не задан'}`,
      `Проект: ${project ?? '— не выбран —'}`,
      Array.isArray(t.checklist) && t.checklist.length ? `Чек-лист: ${t.checklist.join('; ')}` : null,
      'Не завершать без согласования с постановщиком: да',
    ].filter(Boolean);
    return `Создать задачу?\n${lines.join('\n')}`;
  };

  const reminderCard = (text: string, when: Date) =>
    `Напомнить ${when.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}: «${text}»?`;

  const taskSource = (ctx: ToolContext, t: { id: string; title: string; project_id?: string; projectId?: string }): Source => ({
    kind: 'task', id: String(t.id), title: `#${t.id} ${t.title}`,
    url: `${ctx.base}/projects/${t.project_id ?? t.projectId}/task/${t.id}`,
  });

  return [
    {
      name: 'search_tasks', kind: 'read',
      description: 'Найти задачи по словам, номеру, проекту, исполнителю или сроку. scope: mine — я исполнитель, delegated — я поставил, all — все задачи компании. due: overdue — просроченные, today — срок сегодня, week — срок на неделе, none — без срока.',
      params: { q: 'слова или номер (необязательно)', scope: 'mine|delegated|all', due: 'overdue|today|week|none (необязательно)', project: 'название проекта (необязательно)', closed: 'true — включая завершённые' },
      async run(ctx, p) {
        let projectId: string | null = null;
        if (p.project) projectId = (await repo.projectByName(ctx.tenantId, str(p.project)))?.id ?? null;
        const dayEnd = new Date(ctx.now); dayEnd.setHours(23, 59, 59, 999);
        const r = await tasks.registry(ctx.tenantId, ctx.user.userId, {
          q: str(p.q, 120) || null, scope: (str(p.scope) || 'all') as string, due: str(p.due) || null,
          projectId, closed: p.closed === true || p.closed === 'true', dayEnd: dayEnd.toISOString(), page: 1,
        } as any);
        const items = (r.items ?? []).slice(0, 25) as any[];
        if (!items.length) return { text: 'Задач по этому условию не найдено.', sources: [] };
        const lines = items.map((t) => `#${t.id} «${t.title}» — ${t.column_name ?? t.status}${t.assignee_name ? `, исполнитель ${t.assignee_name}` : ''}${t.deadline_at ? `, срок ${dateRu(t.deadline_at)}` : ''}${t.closed_at ? ' (завершена)' : ''}, проект «${t.project_name}»`);
        return { text: `Найдено задач: ${r.total ?? items.length}. Первые:\n${lines.join('\n')}`, sources: items.map((t) => taskSource(ctx, t)) };
      },
    },
    {
      name: 'get_task', kind: 'read',
      description: 'Задача целиком по номеру: описание, статус, исполнитель, срок, чек-лист, последние реплики обсуждения. Для «что здесь нужно сделать», «что изменилось в задаче», «сделай чек-лист по задаче».',
      params: { taskId: 'номер задачи' },
      async run(ctx, p) {
        const t = await repo.taskFull(ctx.tenantId, str(p.taskId, 20));
        if (!t) return { text: 'Задача не найдена.', sources: [] };
        const parts = [
          `Задача #${t.id} «${t.title}» — ${t.closed_at ? 'завершена' : t.status}, проект «${t.project_name}»`,
          `Исполнитель: ${t.assignee ?? 'не назначен'}; постановщик: ${t.manager ?? '—'}; срок: ${dateRu(t.deadline_at) ?? 'не задан'}; приоритет: ${t.priority ?? 'обычный'}`,
          t.description ? `Описание: ${clip(t.description, 2500)}` : 'Описания нет.',
          t.checklist.length ? `Чек-лист: ${t.checklist.map((c) => `[${c.done ? 'x' : ' '}] ${c.text}`).join('; ')}` : 'Чек-листа нет.',
          t.comments.length ? `Последние реплики:\n${[...t.comments].reverse().map((c) => `— ${c.author ?? 'система'} (${dateRu(c.at)}): ${clip(c.body, 300)}`).join('\n')}` : 'Обсуждения пока нет.',
        ];
        return { text: parts.join('\n'), sources: [taskSource(ctx, t)] };
      },
    },
    {
      name: 'search_messages', kind: 'read',
      description: 'Найти сообщения в чатах по словам («где Глеб писал про ошибку API»). Ищет только в чатах, доступных человеку.',
      params: { q: 'слова для поиска' },
      async run(ctx, p) {
        const r = await chats.searchMessages(ctx.tenantId, ctx.user, str(p.q, 120));
        const items = (r.items ?? []).slice(0, 15) as any[];
        if (!items.length) return { text: 'В переписке ничего не нашлось.', sources: [] };
        return {
          text: items.map((m, i) => `[m${i + 1}] ${m.chatTitle} · ${m.authorName ?? 'система'} (${dateRu(m.createdAt)}): ${clip(String(m.body ?? ''), 300)}`).join('\n'),
          sources: items.map((m) => ({ kind: 'message', id: String(m.messageId), title: `${m.chatTitle}: ${clip(String(m.body ?? ''), 60)}`, url: `${ctx.base}/chat/${m.chatId}#m${m.messageId}` })),
        };
      },
    },
    {
      name: 'chat_recent', kind: 'read',
      description: 'Последние сообщения конкретного чата — для сводки, «что решили», «какие задачи здесь обсуждались». chatId — номер чата из контекста.',
      params: { chatId: 'номер чата', limit: 'сколько сообщений, до 100' },
      async run(ctx, p) {
        const chat = await repo.chatTitle(ctx.tenantId, ctx.user.userId, str(p.chatId, 20));
        if (!chat) return { text: 'Чат недоступен.', sources: [] };
        const rows = await repo.chatRecent(ctx.tenantId, ctx.user.userId, chat.id, Math.min(100, Number(p.limit) || 40));
        if (!rows.length) return { text: 'В чате пока пусто.', sources: [] };
        return {
          text: `Чат «${chat.title ?? 'Личный диалог'}», последние ${rows.length} сообщений:\n` + rows.map((m) => `— ${m.is_ai ? 'AI' : (m.author ?? 'система')} (${new Date(m.created_at).toLocaleString('ru-RU')}): ${clip(m.body, 400)}`).join('\n'),
          sources: [{ kind: 'chat', id: String(chat.id), title: chat.title ?? 'Чат', url: `${ctx.base}/chat/${chat.id}` }],
        };
      },
    },
    {
      name: 'whats_missed', kind: 'read',
      description: 'Что я пропустил: сводка непрочитанного по всем чатам или по одному (chatId).',
      params: { chatId: 'номер чата (необязательно)' },
      async run(ctx, p) {
        const r = await chats.aiDigest(ctx.tenantId, ctx.user, str(p.chatId, 20) || undefined);
        return { text: r.text, sources: [] };
      },
    },
    {
      name: 'get_project', kind: 'read',
      description: 'Проект: статус, ответственный, клиент, сколько задач в работе и просрочено, живые задачи. Для отчётов по проекту и «что происходит в проекте».',
      params: { project: 'название проекта или его номер' },
      async run(ctx, p) {
        const key = str(p.project, 120);
        const project = /^\d+$/.test(key) ? await repo.project(ctx.tenantId, key)
          : await repo.projectByName(ctx.tenantId, key).then((x) => (x ? repo.project(ctx.tenantId, x.id) : null));
        if (!project) return { text: 'Проект не найден.', sources: [] };
        const list = await repo.projectTasks(ctx.tenantId, project.id);
        const text = [
          `Проект «${project.name}» (${project.status === 'archived' ? 'в архиве' : 'активен'})${project.owner ? `, ответственный ${project.owner}` : ''}${project.client ? `, клиент ${project.client}` : ''}`,
          `Задач в работе: ${project.open_tasks}, просрочено: ${project.overdue}.`,
          list.length ? `Живые задачи:\n${list.map((t) => `#${t.id} «${t.title}» — ${t.status}${t.assignee ? `, ${t.assignee}` : ''}${t.deadline_at ? `, срок ${dateRu(t.deadline_at)}` : ''}`).join('\n')}` : '',
        ].filter(Boolean).join('\n');
        return {
          text,
          sources: [{ kind: 'project', id: String(project.id), title: project.name, url: `${ctx.base}/projects/${project.id}` },
            ...list.map((t) => taskSource(ctx, { ...t, project_id: project.id }))],
        };
      },
    },
    {
      name: 'search_meetings', kind: 'read',
      description: 'Миты (созвоны и встречи) с итогами: найти по словам или взять последние. Для «что решили на последнем мите по проекту X».',
      params: { q: 'слова или название проекта (необязательно)' },
      async run(ctx, p) {
        const rows = await repo.meetings(ctx.tenantId, str(p.q, 80) || null);
        if (!rows.length) return { text: 'Митов не найдено.', sources: [] };
        return {
          text: rows.map((m) => `Мит #${m.id} «${m.title}» (${dateRu(m.at)}${m.project_name ? `, ${m.project_name}` : ''}, ${m.status}): ${m.summary ? clip(m.summary, 600) : 'итога пока нет'}`).join('\n'),
          sources: rows.map((m) => ({ kind: 'meeting', id: String(m.id), title: m.title, url: `${ctx.base}/chat/meetings#m${m.id}` })),
        };
      },
    },
    {
      name: 'get_meeting', kind: 'read',
      description: 'Мит целиком: итог, решения, задачи из него.',
      params: { meetingId: 'номер мита' },
      async run(ctx, p) {
        const m = await repo.meeting(ctx.tenantId, str(p.meetingId, 20));
        if (!m) return { text: 'Мит не найден.', sources: [] };
        const decisions = Array.isArray(m.decisions) ? (m.decisions as unknown[]).map((d) => String(typeof d === 'object' && d ? (d as any).text ?? JSON.stringify(d) : d)) : [];
        const text = [
          `Мит #${m.id} «${m.title}» — ${dateRu(m.at)}${m.project_name ? `, проект ${m.project_name}` : ''}, ${m.status}`,
          m.summary ? `Итог: ${clip(m.summary, 3000)}` : 'Итога пока нет.',
          decisions.length ? `Решения: ${decisions.join('; ')}` : '',
          m.drafts.length ? `Задачи из мита: ${m.drafts.map((d) => `«${d.title}» (${d.task_id ? `создана #${d.task_id}` : d.status})`).join('; ')}` : '',
        ].filter(Boolean).join('\n');
        return { text, sources: [{ kind: 'meeting', id: String(m.id), title: m.title, url: `${ctx.base}/chat/meetings#m${m.id}` }] };
      },
    },
    {
      name: 'team_status', kind: 'read',
      description: 'Кто свободен, кто перегружен, что горит по проекту — цифры по доскам без выдумки. Вопрос — как есть.',
      params: { question: 'вопрос словами' },
      async run(ctx, p) {
        const r = await ask.ask(ctx.tenantId, ctx.user.userId, str(p.question, 300));
        return { text: r.answer, sources: [] };
      },
    },
    {
      name: 'global_search', kind: 'read',
      description: 'Поиск сразу по задачам, проектам, чатам, людям и документам — когда непонятно, где искать.',
      params: { q: 'слова' },
      async run(ctx, p) {
        const r: any = await search.all(ctx.tenantId, ctx.user.userId, ctx.user.role, str(p.q, 120));
        const parts: string[] = []; const sources: Source[] = [];
        for (const t of (r.tasks as any[]).slice(0, 8)) { parts.push(`задача #${t.id} «${t.title}» (${t.project_name}, ${t.closed ? 'завершена' : t.column_name})`); sources.push(taskSource(ctx, { id: t.id, title: t.title, project_id: t.project_id })); }
        for (const pr of (r.projects as any[]).slice(0, 5)) { parts.push(`проект «${pr.name}»`); sources.push({ kind: 'project', id: String(pr.id), title: pr.name, url: `${ctx.base}/projects/${pr.id}` }); }
        for (const pe of (r.people as any[]).slice(0, 5)) parts.push(`сотрудник ${pe.full_name}${pe.position ? ` (${pe.position})` : ''}`);
        for (const d of (r.docs as any[]).slice(0, 5)) parts.push(`документ «${d.title}»`);
        return { text: parts.length ? parts.join('\n') : 'Ничего не нашлось.', sources };
      },
    },

    // ── пишущие: только через подтверждение ──
    {
      name: 'create_task', kind: 'write',
      description: 'Создать задачу по описанию словами: название, описание, чек-лист, исполнитель, срок, проект — как при голосовой постановке. Передавай всю просьбу целиком в instruction, включая контекст (о чём задача), если он известен из переписки.',
      params: { instruction: 'что сделать, кому, к какому сроку, в каком проекте', projectId: 'номер проекта из контекста (необязательно)' },
      async preview(ctx, p) {
        const draft = await nl.parse(ctx.tenantId, ctx.user.userId, str(p.instruction, 4000), str(p.projectId, 20) || null);
        if (draft.intent !== 'create_task' || !draft.task) throw new Error('Не понял, какую задачу создать — уточните, пожалуйста');
        const t = draft.task as any;
        const ctxp = (draft as any).context ?? { projects: [], users: [] };
        return {
          text: await taskCard(ctx, t, {
            project: ctxp.projects?.find((x: any) => String(x.id) === String(t.projectId))?.name,
            assignee: ctxp.users?.find((x: any) => String(x.id) === String(t.assigneeId))?.name,
          }),
          params: { intent: 'create_task', task: { ...t, requiresApproval: true } },
        };
      },
      fields: [
        { key: 'title', label: 'Название', type: 'text' },
        { key: 'description', label: 'Описание', type: 'multiline' },
        { key: 'deadline', label: 'Срок', type: 'date' },
      ],
      values: (p) => {
        const t = (p.task ?? {}) as any;
        return {
          title: str(t.title, 300),
          description: str(t.description, 4000),
          deadline: t.deadline ? String(t.deadline).slice(0, 10) : '',
        };
      },
      async edit(ctx, p, patch) {
        const t = { ...((p.task ?? {}) as any) };
        if (patch.title !== undefined) t.title = str(patch.title, 300);
        if (patch.description !== undefined) t.description = str(patch.description, 4000);
        if (patch.deadline !== undefined) t.deadline = patch.deadline ? patch.deadline.slice(0, 10) : null;
        if (!t.title) throw new Error('У задачи должно быть название');
        return { text: await taskCard(ctx, t), params: { ...p, task: t } };
      },
      async execute(ctx, p) {
        const res: any = await nl.apply(ctx.tenantId, ctx.user.userId, p as any);
        const task = res?.task;
        if (!task?.id) throw new Error('Задача не создалась');
        const src = taskSource(ctx, { id: String(task.id), title: task.title, project_id: String(task.project_id ?? task.projectId) });
        return { text: `Задача #${task.id} «${task.title}» создана.`, output: { taskId: String(task.id), projectId: String(task.project_id ?? task.projectId), title: task.title }, sources: [src] };
      },
      async undo(ctx, output) {
        await tasks.remove(ctx.tenantId, String(output.taskId), ctx.user.userId, { confirmTimeLoss: true });
        return `Задача #${output.taskId} удалена.`;
      },
    },
    {
      name: 'create_reminder', kind: 'write',
      description: 'Напомнить человеку о чём-то в назначенное время: «напомни завтра утром проверить задачу». Напоминание придёт сообщением в его чат «Заметки». when — дата и время в ISO (вычисли из слов и текущего времени), text — о чём напомнить.',
      params: { text: 'о чём напомнить', when: 'ISO дата-время, например 2026-09-15T09:00' },
      async preview(ctx, p) {
        const when = new Date(str(p.when, 40));
        if (Number.isNaN(when.getTime())) throw new Error('Не понял, когда напомнить — назовите день и время');
        if (when.getTime() < ctx.now.getTime() + 30_000) throw new Error('Это время уже прошло — назовите будущее');
        const text = str(p.text, 500) || 'Напоминание';
        return { text: reminderCard(text, when), params: { text, when: when.toISOString() } };
      },
      fields: [
        { key: 'text', label: 'О чём напомнить', type: 'text' },
        { key: 'when', label: 'Когда', type: 'datetime' },
      ],
      // datetime-local во фронте — без буквы Z и без секунд, иначе поле остаётся пустым
      values: (p) => ({ text: str(p.text, 500), when: p.when ? new Date(String(p.when)).toISOString().slice(0, 16) : '' }),
      async edit(ctx, p, patch) {
        const text = str(patch.text ?? p.text, 500) || 'Напоминание';
        const when = new Date(patch.when !== undefined ? patch.when : String(p.when));
        if (Number.isNaN(when.getTime())) throw new Error('Укажите день и время');
        if (when.getTime() < ctx.now.getTime() + 30_000) throw new Error('Это время уже прошло — выберите будущее');
        return { text: reminderCard(text, when), params: { text, when: when.toISOString() } };
      },
      async execute(ctx, p) {
        const self = await chats.selfChat(ctx.tenantId, ctx.user);
        const row: any = await chats.schedule(ctx.tenantId, String(self.id), ctx.user, `⏰ ${str(p.text, 500)}`, String(p.when));
        return {
          text: `Напоминание поставлено на ${new Date(String(p.when)).toLocaleString('ru-RU')}.`,
          output: { scheduledId: String(row?.id ?? ''), chatId: String(self.id), when: String(p.when) },
          sources: [{ kind: 'chat', id: String(self.id), title: 'Заметки', url: `${ctx.base}/chat/${self.id}` }],
        };
      },
      async undo(ctx, output) {
        if (output.scheduledId) await chats.cancelScheduled(ctx.tenantId, String(output.scheduledId), ctx.user);
        return 'Напоминание отменено.';
      },
    },
    {
      name: 'create_scheduled_task', kind: 'write',
      description: 'Делать что-то РЕГУЛЯРНО по расписанию: «каждый понедельник в 9:00 дай список просроченных», «каждый вечер собери задачи на согласование». schedule — фраза о повторении целиком, instruction — что именно делать при каждом запуске.',
      params: { title: 'короткое название', instruction: 'что делать при каждом запуске', schedule: 'фраза о повторении: каждый понедельник в 9:00' },
      async preview(ctx, p) {
        const phrase = str(p.schedule, 200);
        const sched = parseSchedule(phrase || str(p.instruction, 2000));
        if (!sched) throw new Error('Не понял расписание — скажите, например, «каждый понедельник в 9:00»');
        const instruction = str(p.instruction, 2000);
        if (instruction.length < 5) throw new Error('Не понял, что делать при каждом запуске');
        const title = str(p.title, 160) || clip(instruction, 60);
        const first = nextRun(sched, ctx.now, ctx.timezone ?? null);
        return {
          text: `Делать регулярно?\nЗадача: ${title}\nЧто делать: ${instruction}\nКогда: ${scheduleLabel(sched)}\nПервый запуск: ${first.toLocaleString('ru-RU')}`,
          params: { title, instruction, schedule: sched },
        };
      },
      fields: [
        { key: 'title', label: 'Название', type: 'text' },
        { key: 'instruction', label: 'Что делать', type: 'multiline' },
        { key: 'schedule', label: 'Когда (например «каждый понедельник в 9:00»)', type: 'text' },
      ],
      values: (p) => ({
        title: str(p.title, 160),
        instruction: str(p.instruction, 2000),
        schedule: p.schedule ? scheduleLabel(p.schedule as any) : '',
      }),
      async edit(ctx, p, patch) {
        const sched = patch.schedule !== undefined ? parseSchedule(patch.schedule) : (p.schedule as any);
        if (!sched) throw new Error('Не понял расписание — скажите, например, «каждую пятницу в 17:00»');
        const title = str(patch.title ?? p.title, 160);
        const instruction = str(patch.instruction ?? p.instruction, 2000);
        if (!title || instruction.length < 5) throw new Error('Нужны название и что делать при запуске');
        const first = nextRun(sched, ctx.now, ctx.timezone ?? null);
        return {
          text: `Делать регулярно?\nЗадача: ${title}\nЧто делать: ${instruction}\nКогда: ${scheduleLabel(sched)}\nПервый запуск: ${first.toLocaleString('ru-RU')}`,
          params: { title, instruction, schedule: sched },
        };
      },
      async execute(ctx, p) {
        const sched = p.schedule as any;
        const row = await repo.createSchedule({
          tenantId: ctx.tenantId, userId: ctx.user.userId,
          title: str(p.title, 160), instruction: str(p.instruction, 2000),
          schedule: sched, nextRunAt: nextRun(sched, ctx.now, ctx.timezone ?? null),
        });
        return {
          text: `Буду делать ${scheduleLabel(sched)}: «${row.title}». Задача видна во вкладке «Задачи» — там же пауза и правка.`,
          output: { scheduleId: String(row.id) },
          sources: [],
        };
      },
      async undo(ctx, output) {
        await repo.deleteSchedule(ctx.tenantId, ctx.user.userId, String(output.scheduleId));
        return 'Регулярная задача удалена.';
      },
    },
    {
      name: 'remember', kind: 'write',
      description: 'Запомнить о человеке надолго, когда он просит: «запомни, что я работаю по Новосибирску», «запомни: отчёты нужны короткие». type — preference (как работать и отвечать) или topic (над чем работает сейчас).',
      params: { type: 'preference | topic', title: 'коротко, о чём это', content: 'сам факт одним предложением' },
      async preview(_ctx, p) {
        const title = str(p.title, 160);
        const content = str(p.content, 600);
        if (!title || !content) throw new Error('Не понял, что запомнить');
        const type = p.type === 'topic' ? 'topic' : 'preference';
        return {
          text: `Запомнить ${type === 'topic' ? 'рабочую тему' : 'предпочтение'}?\n${title}: ${content}`,
          params: { type, title, content },
        };
      },
      fields: [
        { key: 'title', label: 'О чём это', type: 'text' },
        { key: 'content', label: 'Что запомнить', type: 'multiline' },
      ],
      values: (p) => ({ title: str(p.title, 160), content: str(p.content, 600) }),
      async edit(_ctx, p, patch) {
        const title = str(patch.title ?? p.title, 160);
        const content = str(patch.content ?? p.content, 600);
        if (!title || !content) throw new Error('Нужны и название, и сам факт');
        const type = p.type === 'topic' ? 'topic' : 'preference';
        return { text: `Запомнить ${type === 'topic' ? 'рабочую тему' : 'предпочтение'}?\n${title}: ${content}`, params: { ...p, title, content } };
      },
      async execute(ctx, p) {
        const row = await repo.rememberFact({
          tenantId: ctx.tenantId, userId: ctx.user.userId,
          type: String(p.type) === 'topic' ? 'topic' : 'preference',
          title: str(p.title, 160), content: str(p.content, 600), source: 'manual',
        });
        return { text: `Запомнил: ${row.title}. Всё, что я помню, — во вкладке «Память»; там же можно исправить и удалить.`, output: { memoryId: String(row.id) }, sources: [] };
      },
      async undo(ctx, output) {
        await repo.forget(ctx.tenantId, ctx.user.userId, String(output.memoryId));
        return 'Забыл.';
      },
    },
  ];
}
