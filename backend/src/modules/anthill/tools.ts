import { AnthillRepository, Source } from './anthill.repository';
import { nextRun, parseSchedule, scheduleLabel } from './schedule-ru';
import { FilesService } from '../files/files.service';
import { ForecastService } from '../forecast/forecast.service';
import { TaskCardService } from '../taskcard/taskcard.service';
import { extractText } from '../knowledge/file-text';
import { buildDocx, DOCX_MIME } from '../../common/files/docx.util';
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
  files: FilesService;
  taskcard: TaskCardService;
  forecast: ForecastService;
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
  const { repo, tasks, chats, search, nl, ask, files, taskcard, forecast } = deps;

  /**
   * Человек по имени. Точного совпадения не требуем: в задаче просят «поставь на
   * Глеба», а в базе «Глеб Соколов». Неоднозначность решаем отказом — назначить
   * не того хуже, чем переспросить.
   */
  const findUser = async (tenantId: string, name: string) => {
    const q = name.trim().toLowerCase();
    if (!q) return null;
    const users = await repo.users(tenantId);
    const hits = users.filter((u) => u.full_name.toLowerCase().includes(q));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new Error(`Под «${name}» подходят несколько: ${hits.map((u) => u.full_name).join(', ')} — назовите точнее`);
    throw new Error(`Не нашёл сотрудника «${name}»`);
  };

  /** Файл целиком в память: разбор текста иначе не сделать, размер ограничен выше. */
  const fileBuffer = async (tenantId: string, fileId: string): Promise<Buffer> => {
    const { stream } = await files.getForDownload(tenantId, fileId);
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  };

  const sizeHuman = (bytes: number) => (bytes > 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} МБ`
    : `${Math.max(1, Math.round(bytes / 1024))} КБ`);

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

    {
      name: 'list_files', kind: 'read',
      description: 'Какие файлы приложены к задаче или к чату: имя, тип, размер. Нужен, когда просят «посмотри вложение», «что в файле» и неизвестно, какой именно файл имеется в виду.',
      params: { taskId: 'номер задачи (или)', chatId: 'номер чата' },
      async run(ctx, p) {
        const taskId = str(p.taskId, 20);
        const chatId = str(p.chatId, 20);
        const rows = taskId
          ? await repo.taskFiles(ctx.tenantId, taskId)
          : chatId ? await repo.chatFiles(ctx.tenantId, ctx.user.userId, chatId) : [];
        if (!rows.length) return { text: 'Вложений нет.', sources: [] };
        const lines = rows.map((f) => `#${f.id} ${f.file_name} · ${sizeHuman(Number(f.size_bytes))}`);
        return { text: `Вложения:\n${lines.join('\n')}`, sources: [] };
      },
    },
    {
      name: 'read_file', kind: 'read',
      description: 'Прочитать содержимое файла: PDF, docx, xlsx, txt, csv, md. Сначала возьми номер файла из list_files. Картинки и сканы без текстового слоя прочитать нельзя.',
      params: { fileId: 'номер файла из list_files' },
      async run(ctx, p) {
        const fileId = str(p.fileId, 20);
        const meta = await repo.fileMeta(ctx.tenantId, fileId);
        if (!meta) return { text: 'Такого файла нет.', sources: [] };
        const buf = await fileBuffer(ctx.tenantId, fileId);
        const got = await extractText(buf, meta.file_name, meta.content_type);
        if (!got) {
          // Честно говорим, что содержимого нет: молчаливый пустой ответ человек
          // принимает за «в файле ничего важного», и это худший исход.
          return { text: `Файл «${meta.file_name}» прочитать не удалось: это картинка, скан без текста или защищённый документ.`, sources: [] };
        }
        return { text: `Файл «${meta.file_name}»:\n${clip(got.text, 12000)}`, sources: [] };
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
      name: 'create_skill', kind: 'write',
      description: 'Записать НАВЫК — порядок работы для того, что человек делает регулярно: «создай навык, который каждую пятницу готовит отчёт по проекту». steps — шаги по порядку, по одному действию в строке.',
      params: {
        name: 'название навыка', description: 'о чём он', whenToUse: 'когда его применять — словами запроса',
        steps: 'массив шагов по порядку', output: 'каким должен получиться результат',
      },
      async preview(_ctx, p) {
        const name = str(p.name, 120);
        const steps = Array.isArray(p.steps) ? p.steps.map((x) => str(x, 300)).filter(Boolean).slice(0, 15) : [];
        if (!name) throw new Error('Не понял, как назвать навык');
        if (!steps.length) throw new Error('Не понял, из каких шагов состоит навык');
        return {
          text: `Записать навык?\nНазвание: ${name}\nКогда применять: ${str(p.whenToUse, 500) || '— не указано —'}\nШаги:\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\nРезультат: ${str(p.output, 500) || '— как получится —'}`,
          params: { name, description: str(p.description, 500), whenToUse: str(p.whenToUse, 500), steps, output: str(p.output, 500) },
        };
      },
      fields: [
        { key: 'name', label: 'Название', type: 'text' },
        { key: 'whenToUse', label: 'Когда применять', type: 'text' },
        { key: 'steps', label: 'Шаги — по одному в строке', type: 'multiline' },
        { key: 'output', label: 'Каким должен быть результат', type: 'text' },
      ],
      values: (p) => ({
        name: str(p.name, 120), whenToUse: str(p.whenToUse, 500),
        steps: Array.isArray(p.steps) ? (p.steps as unknown[]).map((x) => String(x)).join('\n') : '',
        output: str(p.output, 500),
      }),
      async edit(_ctx, p, patch) {
        const name = str(patch.name ?? p.name, 120);
        const steps = patch.steps !== undefined
          ? patch.steps.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 15)
          : ((p.steps as string[]) ?? []);
        if (!name) throw new Error('Нужно название навыка');
        if (!steps.length) throw new Error('Нужен хотя бы один шаг');
        const whenToUse = str(patch.whenToUse ?? p.whenToUse, 500);
        const output = str(patch.output ?? p.output, 500);
        return {
          text: `Записать навык?\nНазвание: ${name}\nКогда применять: ${whenToUse || '— не указано —'}\nШаги:\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\nРезультат: ${output || '— как получится —'}`,
          params: { ...p, name, whenToUse, steps, output },
        };
      },
      async execute(ctx, p) {
        const row = await repo.createSkill({
          tenantId: ctx.tenantId, ownerId: ctx.user.userId,
          name: str(p.name, 120), description: str(p.description, 500), whenToUse: str(p.whenToUse, 500),
          steps: ((p.steps as string[]) ?? []).map((x) => String(x)), inputs: [], output: str(p.output, 500),
          visibility: 'private',
        });
        return {
          text: `Навык «${row.name}» записан. Я буду брать его сам, когда запрос на него похож; посмотреть и поправить — во вкладке «Навыки».`,
          output: { skillId: String(row.id) },
          sources: [],
        };
      },
      async undo(ctx, output) {
        await repo.deleteSkill(ctx.tenantId, ctx.user.userId, String(output.skillId));
        return 'Навык удалён.';
      },
    },
    {
      name: 'update_task', kind: 'write',
      description: 'Изменить существующую задачу: срок, исполнителя, приоритет, название или описание. Например «перенеси #128 на пятницу», «поставь задачу 45 на Глеба», «подними приоритет». Нужен номер задачи.',
      params: {
        taskId: 'номер задачи', deadline: 'новый срок, ISO-дата (необязательно)',
        assignee: 'имя нового исполнителя (необязательно)', priority: 'low | normal | high | urgent (необязательно)',
        title: 'новое название (необязательно)', description: 'новое описание (необязательно)',
      },
      async preview(ctx, p) {
        const taskId = str(p.taskId, 20);
        const task = await repo.taskFull(ctx.tenantId, taskId);
        if (!task) throw new Error(`Задачи #${taskId} не нашёл`);
        const lines: string[] = [];
        const next: Record<string, unknown> = { taskId };

        const title = str(p.title, 255);
        if (title && title !== task.title) { lines.push(`Название: «${task.title}» → «${title}»`); next.title = title; }
        const description = str(p.description, 4000);
        if (description) { lines.push('Описание: заменить'); next.description = description; }
        if (p.deadline) {
          const when = new Date(String(p.deadline));
          if (Number.isNaN(when.getTime())) throw new Error('Не понял новый срок');
          lines.push(`Срок: ${task.deadline_at ? dateRu(task.deadline_at) : 'не задан'} → ${dateRu(when)}`);
          next.deadline = when.toISOString();
        }
        if (p.assignee) {
          const u = await findUser(ctx.tenantId, str(p.assignee, 120));
          lines.push(`Исполнитель: ${task.assignee ?? 'не назначен'} → ${u!.full_name}`);
          next.assigneeId = String(u!.id);
          next.assigneeName = u!.full_name;
        }
        const priority = str(p.priority, 16).toLowerCase();
        if (priority && ['low', 'normal', 'high', 'urgent'].includes(priority) && priority !== task.priority) {
          lines.push(`Приоритет: ${task.priority} → ${priority}`);
          next.priority = priority;
        }
        if (!lines.length) throw new Error('Не понял, что именно менять в задаче');
        return { text: `Изменить задачу #${taskId} «${task.title}»?\n${lines.join('\n')}`, params: next };
      },
      async execute(ctx, p) {
        const taskId = str(p.taskId, 20);
        const before = await repo.taskFull(ctx.tenantId, taskId);
        if (!before) throw new Error(`Задачи #${taskId} больше нет`);
        const patch: Record<string, unknown> = {};
        if (p.title) patch.title = p.title;
        if (p.description) patch.description = p.description;
        if (p.assigneeId) patch.assigneeId = p.assigneeId;
        if (p.priority) patch.priority = p.priority;
        if (Object.keys(patch).length) await tasks.update(ctx.tenantId, taskId, patch as any, ctx.user.userId);
        if (p.deadline) await forecast.setEstimateDeadline(ctx.tenantId, taskId, null, String(p.deadline));
        return {
          text: `Задача #${taskId} изменена.`,
          // прежние значения — чтобы «Отменить» вернуло ровно то, что было
          output: {
            taskId,
            prev: {
              title: before.title, description: before.description ?? '',
              assigneeId: before.assignee_id ? String(before.assignee_id) : null,
              priority: before.priority, deadline: before.deadline_at ? new Date(before.deadline_at).toISOString() : null,
            },
            changed: Object.keys(patch).concat(p.deadline ? ['deadline'] : []),
          },
          sources: [taskSource(ctx, { id: taskId, title: before.title, project_id: String(before.project_id) })],
        };
      },
      async undo(ctx, output) {
        const taskId = String(output.taskId);
        const prev = (output.prev ?? {}) as any;
        const changed = (output.changed ?? []) as string[];
        const patch: Record<string, unknown> = {};
        if (changed.includes('title')) patch.title = prev.title;
        if (changed.includes('description')) patch.description = prev.description;
        if (changed.includes('assigneeId')) patch.assigneeId = prev.assigneeId;
        if (changed.includes('priority')) patch.priority = prev.priority;
        if (Object.keys(patch).length) await tasks.update(ctx.tenantId, taskId, patch as any, ctx.user.userId);
        if (changed.includes('deadline')) await forecast.setEstimateDeadline(ctx.tenantId, taskId, null, prev.deadline ?? null);
        return `Задача #${taskId} возвращена как была.`;
      },
    },
    {
      name: 'add_comment', kind: 'write',
      description: 'Написать в обсуждение задачи от имени человека: «напиши в #128, что макеты готовы». Нужен номер задачи и текст.',
      params: { taskId: 'номер задачи', text: 'что написать' },
      async preview(ctx, p) {
        const taskId = str(p.taskId, 20);
        const text = String(p.text ?? '').trim().slice(0, 4000);
        const task = await repo.taskFull(ctx.tenantId, taskId);
        if (!task) throw new Error(`Задачи #${taskId} не нашёл`);
        if (text.length < 2) throw new Error('Не понял, что написать');
        return { text: `Написать в задачу #${taskId} «${task.title}»?\n«${clip(text, 600)}»`, params: { taskId, text } };
      },
      fields: [{ key: 'text', label: 'Сообщение', type: 'multiline' }],
      values: (p) => ({ text: String(p.text ?? '') }),
      async edit(ctx, p, patch) {
        const text = String(patch.text ?? p.text ?? '').trim().slice(0, 4000);
        if (text.length < 2) throw new Error('Сообщение пустое');
        const task = await repo.taskFull(ctx.tenantId, String(p.taskId));
        return { text: `Написать в задачу #${p.taskId} «${task?.title ?? ''}»?\n«${clip(text, 600)}»`, params: { ...p, text } };
      },
      async execute(ctx, p) {
        const taskId = str(p.taskId, 20);
        const c: any = await taskcard.addComment(ctx.tenantId, taskId, ctx.user.userId, String(p.text), false);
        const task = await repo.taskFull(ctx.tenantId, taskId);
        return {
          text: `Сообщение в задаче #${taskId} отправлено.`,
          output: { taskId, commentId: String(c?.id ?? '') },
          sources: task ? [taskSource(ctx, { id: taskId, title: task.title, project_id: String(task.project_id) })] : [],
        };
      },
      async undo(ctx, output) {
        await taskcard.deleteComment(ctx.tenantId, String(output.taskId), String(output.commentId), ctx.user.userId, ctx.user.role);
        return 'Сообщение удалено.';
      },
    },
    {
      name: 'send_message', kind: 'write',
      description: 'Отправить сообщение в чат от имени человека: «напиши Глебу, что созвон в 15», «напиши в чат проекта, что макеты готовы». Номер чата бери из chat_recent, search_messages или контекста страницы.',
      params: { chatId: 'номер чата', text: 'что написать' },
      async preview(ctx, p) {
        const chatId = str(p.chatId, 20);
        const text = String(p.text ?? '').trim().slice(0, 4000);
        const chat = await repo.chatTitle(ctx.tenantId, ctx.user.userId, chatId);
        if (!chat) throw new Error('Такого чата у вас нет');
        if (text.length < 2) throw new Error('Не понял, что написать');
        return { text: `Отправить в «${chat.title}»?\n«${clip(text, 600)}»`, params: { chatId, text } };
      },
      fields: [{ key: 'text', label: 'Сообщение', type: 'multiline' }],
      values: (p) => ({ text: String(p.text ?? '') }),
      async edit(ctx, p, patch) {
        const text = String(patch.text ?? p.text ?? '').trim().slice(0, 4000);
        if (text.length < 2) throw new Error('Сообщение пустое');
        const chat = await repo.chatTitle(ctx.tenantId, ctx.user.userId, String(p.chatId));
        return { text: `Отправить в «${chat?.title ?? 'чат'}»?\n«${clip(text, 600)}»`, params: { ...p, text } };
      },
      async execute(ctx, p) {
        const chatId = str(p.chatId, 20);
        const m: any = await chats.send(ctx.tenantId, chatId, ctx.user, String(p.text), null);
        const chat = await repo.chatTitle(ctx.tenantId, ctx.user.userId, chatId);
        return {
          text: `Сообщение отправлено в «${chat?.title ?? 'чат'}».`,
          output: { chatId, messageId: String(m?.id ?? '') },
          sources: [{ kind: 'chat', id: chatId, title: chat?.title ?? 'Чат', url: `${ctx.base}/chat/${chatId}` }],
        };
      },
      async undo(ctx, output) {
        await chats.remove(ctx.tenantId, String(output.chatId), String(output.messageId), ctx.user);
        return 'Сообщение удалено.';
      },
    },
    {
      name: 'create_document', kind: 'write',
      description: 'Собрать документ (отчёт, заметку, список) и отдать человеку файлом: «сделай отчёт по проекту и приложи к задаче», «собери заметку в мои Заметки». format — docx, md, txt или csv. target — task (вложением в задачу), chat (сообщением в чат) или notes (в «Заметки»).',
      params: {
        title: 'название документа', content: 'полный текст документа',
        format: 'docx | md | txt | csv', target: 'task | chat | notes', targetId: 'номер задачи или чата, если target не notes',
      },
      async preview(_ctx, p) {
        const title = str(p.title, 160);
        const content = String(p.content ?? '').trim();
        if (!title) throw new Error('Не понял, как назвать документ');
        if (content.length < 20) throw new Error('Документ пустой — скажите, что в нём должно быть');
        const format = ['docx', 'md', 'txt', 'csv'].includes(String(p.format)) ? String(p.format) : 'docx';
        const target = ['task', 'chat', 'notes'].includes(String(p.target)) ? String(p.target) : 'notes';
        const where = target === 'task' ? `вложением к задаче #${str(p.targetId, 20)}`
          : target === 'chat' ? `сообщением в чат #${str(p.targetId, 20)}` : 'в ваши «Заметки»';
        return {
          text: `Сохранить документ?\nНазвание: ${title}.${format}\nКуда: ${where}\nНачало:\n${clip(content, 600)}`,
          params: { title, content, format, target, targetId: str(p.targetId, 20) },
        };
      },
      fields: [
        { key: 'title', label: 'Название', type: 'text' },
        { key: 'content', label: 'Текст документа', type: 'multiline' },
      ],
      values: (p) => ({ title: str(p.title, 160), content: String(p.content ?? '') }),
      async edit(_ctx, p, patch) {
        const title = str(patch.title ?? p.title, 160);
        const content = String(patch.content ?? p.content ?? '').trim();
        if (!title) throw new Error('Нужно название документа');
        if (content.length < 20) throw new Error('В документе должен быть текст');
        const target = String(p.target ?? 'notes');
        const where = target === 'task' ? `вложением к задаче #${str(p.targetId, 20)}`
          : target === 'chat' ? `сообщением в чат #${str(p.targetId, 20)}` : 'в ваши «Заметки»';
        return {
          text: `Сохранить документ?\nНазвание: ${title}.${String(p.format ?? 'docx')}\nКуда: ${where}\nНачало:\n${clip(content, 600)}`,
          params: { ...p, title, content },
        };
      },
      async execute(ctx, p) {
        const title = str(p.title, 160);
        const content = String(p.content ?? '');
        const format = String(p.format ?? 'docx');
        const target = String(p.target ?? 'notes');
        const buffer = format === 'docx' ? await buildDocx(title, content) : Buffer.from(content, 'utf8');
        const mime = format === 'docx' ? DOCX_MIME
          : format === 'csv' ? 'text/csv; charset=utf-8'
            : format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
        const fileName = `${title.replace(/[^\p{L}\p{N} ._-]+/gu, ' ').trim().slice(0, 80) || 'Документ'}.${format}`;

        if (target === 'task') {
          const taskId = str(p.targetId, 20);
          const att = await taskcard.attachUploaded(ctx.tenantId, taskId, ctx.user.userId, { buffer, originalname: fileName, mimetype: mime });
          const t = await repo.taskFull(ctx.tenantId, taskId);
          return {
            text: `Документ «${att.fileName}» приложен к задаче #${taskId}.`,
            output: { fileId: String(att.fileId), taskId, kind: 'task' },
            sources: t ? [taskSource(ctx, { id: String(t.id), title: t.title, project_id: String(t.project_id) })] : [],
          };
        }

        const chatId = target === 'chat' ? str(p.targetId, 20) : String((await chats.selfChat(ctx.tenantId, ctx.user)).id);
        const uploaded = await files.upload({
          tenantId: ctx.tenantId, userId: ctx.user.userId, buffer, fileName, contentType: mime, ownerKind: 'chat_attachment',
        });
        await chats.send(ctx.tenantId, chatId, ctx.user, `📄 ${title}`, String(uploaded.id));
        const where = target === 'chat' ? `в чат #${chatId}` : 'в ваши «Заметки»';
        return {
          text: `Документ «${fileName}» отправлен ${where}.`,
          output: { fileId: String(uploaded.id), chatId, kind: 'chat' },
          sources: [{ kind: 'chat', id: chatId, title: target === 'chat' ? 'Чат' : 'Заметки', url: `${ctx.base}/chat/${chatId}` }],
        };
      },
      async undo(ctx, output) {
        // Файл удаляем; сообщение с ним остаётся — чужую переписку агент не правит.
        await files.delete(ctx.tenantId, String(output.fileId), ctx.user).catch(() => undefined);
        return 'Документ удалён.';
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
