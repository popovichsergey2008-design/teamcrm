import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { NlService } from '../nl/nl.service';
import { matchProjectInText } from '../nl/task-draft';
import { ChatsRepository } from './chats.repository';
import { ChatTaskDraftRepository, DraftRow } from './chat-task-draft.repository';

/**
 * Задача из сообщения чата — с разбором, уточнением и предпросмотром (ТЗ «Создание
 * задач из сообщений в чате»).
 *
 * Зачем отдельная служба. Раньше «Создать задачу» открывало окно, которое на лету
 * просило разбор и тут же его теряло: обновил страницу — начинай сначала. А главное,
 * поручению в переписке почти всегда не хватает одного — проекта («сделай, чтобы
 * фильтр снизу выезжал» — в каком из семи?). Спросить об этом может только человек,
 * который писал, и спрашивать его надо там же, где он пишет: в чате. Это значит, что
 * между нажатием и созданием проходит время, а всё начатое должно пережить перезагрузку,
 * обрыв связи и повторный вход. Отсюда черновик в базе и состояния.
 *
 * Что делает ИИ: разбирает фразу (с учётом того, на что отвечали и с чего началась
 * ветка), предлагает проект, исполнителя, срок и шаги. Чего он НЕ делает: не создаёт
 * задачу сам. Постановщик — тот, кто нажал «Создать», и он видит и правит всё до
 * нажатия. Назначенная не тому задача выглядит как поручение, которого человек не
 * получал, и разбирать это приходится людям.
 */
@Injectable()
export class ChatTaskDraftService {
  private readonly log = new Logger('ChatTaskDraft');

  constructor(
    private readonly repo: ChatTaskDraftRepository,
    private readonly chats: ChatsRepository,
    private readonly nl: NlService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Картинки и видео прикладываем сразу: обычно они и есть половина постановки. */
  private static visualByDefault(mime: string | null, name: string | null): boolean {
    const m = String(mime ?? '').toLowerCase();
    if (m.startsWith('image/') || m.startsWith('video/')) return true;
    return /\.(png|jpe?g|gif|webp|heic|mp4|mov|webm|mkv)$/i.test(String(name ?? ''));
  }

  /** Наружу отдаём в том виде, в каком это рисует окно. */
  private view(d: DraftRow) {
    return {
      draftId: String(d.id),
      chatId: String(d.chat_id),
      messageId: String(d.message_id),
      status: d.status,
      title: d.title,
      description: d.description,
      projectId: d.project_id,
      assigneeId: d.assignee_id,
      assigneeReason: d.assignee_reason,
      deadline: d.deadline,
      priority: d.priority,
      checklist: Array.isArray(d.checklist) ? d.checklist : [],
      files: Array.isArray(d.files) ? d.files : [],
      analysis: d.analysis ?? {},
      authorId: d.author_id,
      initiatorId: d.initiator_id,
      taskId: d.task_id,
    };
  }

  /** Событие о черновике всем, кто видит чат: строка под сообщением одинакова у всех. */
  private async announce(tenantId: string, chatId: string, draft: DraftRow): Promise<void> {
    const chat = await this.chats.get(tenantId, chatId);
    if (!chat) return;
    const to = chat.kind === 'project' ? await this.chats.teamIds(tenantId) : await this.chats.memberIds(chatId);
    this.realtime.emitToUsers(tenantId, to, 'chat.task_draft', this.view(draft));
  }

  private async access(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    if (user.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    const chat = await this.chats.get(tenantId, chatId);
    if (!chat) throw AppException.notFound('Чат не найден');
    if (chat.kind !== 'project' && !(await this.chats.isMember(chatId, user.userId))) {
      throw AppException.forbidden('Вы не участник этого чата');
    }
    return chat;
  }

  /** Черновик по номеру — с проверкой, что человек имеет доступ к его чату. */
  private async mine(tenantId: string, user: { userId: string; role: string }, draftId: string) {
    const draft = await this.repo.byId(tenantId, draftId);
    if (!draft) throw AppException.notFound('Черновик не найден');
    await this.access(tenantId, String(draft.chat_id), user);
    return draft;
  }

  /**
   * Нажали «Создать задачу».
   *
   * Если по этому сообщению уже идёт разбор — возвращаем его, а не заводим второй:
   * два черновика по одной фразе кончаются двумя одинаковыми задачами.
   */
  async start(tenantId: string, chatId: string, user: { userId: string; role: string }, messageId: string) {
    const chat = await this.access(tenantId, chatId, user);
    const msg = await this.chats.messageBody(tenantId, messageId);
    if (!msg || String(msg.chat_id) !== String(chatId)) throw AppException.notFound('Сообщение не найдено');

    const open = await this.repo.openByMessage(tenantId, messageId);
    if (open) return { draft: this.view(open), context: await this.context(tenantId), already: null };

    // По этому сообщению задача уже есть — говорим об этом, а не заводим молча вторую.
    const already = msg.task_id ? String(msg.task_id) : null;

    const draft = await this.repo.create({
      tenantId, chatId, messageId, initiatorId: user.userId,
      authorId: msg.author_id ? String(msg.author_id) : null,
    });
    const filled = await this.analyze(tenantId, user.userId, draft, {
      text: String(msg.body ?? ''),
      fileNameFallback: msg.file_name ?? null,
      projectHint: chat.project_id ? String(chat.project_id) : null,
    });
    void this.announce(tenantId, chatId, filled);
    return { draft: this.view(filled), context: await this.context(tenantId), already };
  }

  /** Проекты и люди для выпадающих списков предпросмотра. */
  private async context(tenantId: string) {
    const [projects, users] = await Promise.all([
      this.repo.projects(tenantId),
      this.chats.tenantUsers(tenantId),
    ]);
    return {
      projects: projects.map((p) => ({ id: String(p.id), name: p.name })),
      users: users.map((u) => ({ id: String(u.id), name: u.full_name })),
    };
  }

  /**
   * Разбор сообщения.
   *
   * В работу идёт не только сама фраза: если это ответ — ещё и то, на что отвечали,
   * а в ветке — с чего она началась. Без этого «да, и там же поправь шрифт» не значит
   * ничего. Весь чат при этом не передаём: лишний контекст уводит разбор в сторону и
   * стоит денег на каждом запросе.
   */
  private async analyze(
    tenantId: string, userId: string, draft: DraftRow,
    src: { text: string; fileNameFallback: string | null; projectHint: string | null },
  ): Promise<DraftRow> {
    const files = (await this.repo.messageFiles(tenantId, String(draft.message_id))).map((f) => ({
      fileId: String(f.file_id),
      name: f.file_name,
      mime: f.content_type,
      include: ChatTaskDraftService.visualByDefault(f.content_type, f.file_name),
    }));

    const around = await this.repo.contextText(tenantId, String(draft.message_id));
    const text = String(src.text ?? '').trim();
    // Скриншот без единого слова — обычное дело: «вот что сломалось». Тогда за фразу
    // берём имя файла, а картинка всё равно уедет в задачу вложением.
    const base = text.length >= 3 ? text : String(src.fileNameFallback ?? 'Разобраться со скриншотом');
    const context = [around?.root_body, around?.reply_body]
      .map((x) => String(x ?? '').trim())
      .filter((x) => x && x !== base)
      .slice(0, 2)
      .join(' ');
    const forParse = context ? `${base}\n(в ответ на: ${context.slice(0, 400)})` : base;

    /*
      Проект берём НЕ у модели.

      В быстрой команде догадке модели верить можно: человек стоит на доске и диктует
      задачу — обстановка сама подсказывает проект. В переписке обстановки нет, и модель
      на фразе «тут всё съезжает, поправь» уверенно называет первый попавшийся проект.
      Задача, уехавшая не в тот проект, хуже, чем задача, о которой переспросили, —
      поэтому берём только твёрдые основания: чат проекта, название проекта прямо в
      тексте или единственный проект в компании. Иначе спрашиваем автора.
    */
    const projects = await this.repo.projects(tenantId);
    const named = matchProjectInText(base, projects);
    const projectId = src.projectHint
      ?? named
      ?? (projects.length === 1 ? String(projects[0].id) : null);
    const projectSource = src.projectHint ? 'chat' : named ? 'text' : projects.length === 1 ? 'only' : 'none';

    let patch: Parameters<ChatTaskDraftRepository['patch']>[2] = {};
    try {
      const parsed: any = await this.nl.parse(tenantId, userId, forParse, src.projectHint);
      const t = parsed?.task ?? {};
      patch = {
        title: String(t.title ?? base).slice(0, 255),
        description: String(t.description ?? ''),
        projectId,
        deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(t.deadline ?? '')) ? String(t.deadline) : null,
        priority: String(t.priority ?? 'normal'),
        checklist: Array.isArray(t.checklist) ? t.checklist.map(String).slice(0, 12) : [],
        analysis: { note: parsed?.note ?? null, project: projectSource },
      };
    } catch (e) {
      // Модель недоступна — человек уже нажал «Создать задачу», и пустое окно было бы
      // худшим ответом. Ставим саму фразу: правится руками за пять секунд.
      this.log.warn(`разбор сообщения без модели: ${(e as Error).message}`);
      patch = {
        title: base.slice(0, 255),
        projectId,
        analysis: { note: 'ИИ недоступен — собрал по самой фразе', project: projectSource },
      };
    }

    const assignee = await this.pickAssignee(tenantId, draft, {
      title: String(patch.title ?? base),
      description: String(patch.description ?? ''),
      projectId: patch.projectId ?? null,
    });

    const updated = await this.repo.patch(tenantId, String(draft.id), {
      ...patch,
      files,
      assigneeId: assignee.userId,
      assigneeReason: assignee.reason,
      analysis: { ...(patch.analysis ?? {}), assignee: assignee.detail },
      // Без проекта задачу не создать — значит, надо спрашивать. Это и есть та самая
      // просьба заказчика: «если информации нет, агент задаёт вопрос автору».
      status: patch.projectId ? 'ready' : 'needs_clarification',
    });
    return updated ?? draft;
  }

  /**
   * Кого предложить исполнителем.
   *
   * Порядок от самого надёжного к догадке: позвали одного через @ — он и делает;
   * личная переписка — адресат; иначе подбираем по отделу, специализации и загрузке
   * (тот же механизм, что в быстрой команде). Автор фразы исполнителем не становится
   * никогда: в переписке задачу описывает тот, кто её просит.
   */
  private async pickAssignee(
    tenantId: string, draft: DraftRow, task: { title: string; description: string; projectId: string | null },
  ): Promise<{ userId: string | null; reason: string | null; detail: Record<string, unknown> }> {
    const mentioned = await this.chats.messageMentions(tenantId, String(draft.message_id));
    if (mentioned.length === 1) {
      return { userId: String(mentioned[0].user_id), reason: 'назван в сообщении через @', detail: { source: 'mention' } };
    }
    const chat = await this.chats.get(tenantId, String(draft.chat_id));
    if (!mentioned.length && chat?.kind === 'dm' && draft.author_id) {
      const peer = await this.chats.dmPeer(tenantId, String(draft.chat_id), String(draft.author_id));
      if (peer) return { userId: String(peer.user_id), reason: 'личная переписка — адресат сообщения', detail: { source: 'dm' } };
    }
    try {
      const s = await this.nl.suggestAssignee(tenantId, {
        title: task.title, description: task.description, projectId: task.projectId,
      });
      if (!s.suggestedAssigneeId) return { userId: null, reason: null, detail: { source: 'none' } };
      return {
        userId: String(s.suggestedAssigneeId),
        reason: s.reason ? `ИИ: ${s.reason}` : 'подобран по навыкам и загрузке',
        detail: { source: 'routing', department: s.department, skill: s.skill, confidence: s.confidence },
      };
    } catch (e) {
      this.log.warn(`подбор исполнителя для черновика не вышел: ${(e as Error).message}`);
      return { userId: null, reason: null, detail: { source: 'failed' } };
    }
  }

  async get(tenantId: string, user: { userId: string; role: string }, draftId: string) {
    const draft = await this.mine(tenantId, user, draftId);
    return { draft: this.view(draft), context: await this.context(tenantId), already: null };
  }

  /** Открытые черновики чата: по ним рисуются строки состояния под сообщениями. */
  async openInChat(tenantId: string, chatId: string, user: { userId: string; role: string }) {
    await this.access(tenantId, chatId, user);
    return { items: (await this.repo.openInChat(tenantId, chatId)).map((d) => this.view(d)) };
  }

  /** Правки человека в предпросмотре. Проект появился — черновик снова готов. */
  async patch(
    tenantId: string, user: { userId: string; role: string }, draftId: string,
    body: Record<string, unknown>,
  ) {
    const draft = await this.mine(tenantId, user, draftId);
    if (draft.status === 'created') throw AppException.conflict('Задача по этому черновику уже создана');
    const next: Parameters<ChatTaskDraftRepository['patch']>[2] = {};
    if (body.title !== undefined) next.title = String(body.title).slice(0, 255);
    if (body.description !== undefined) next.description = String(body.description ?? '');
    if (body.projectId !== undefined) next.projectId = body.projectId ? String(body.projectId) : null;
    if (body.assigneeId !== undefined) {
      next.assigneeId = body.assigneeId ? String(body.assigneeId) : null;
      next.assigneeReason = body.assigneeId ? 'выбран постановщиком' : null;
    }
    if (body.deadline !== undefined) next.deadline = body.deadline ? String(body.deadline) : null;
    if (body.priority !== undefined) next.priority = String(body.priority);
    if (Array.isArray(body.checklist)) next.checklist = body.checklist.map((x) => String(x ?? '').trim()).filter(Boolean);
    if (Array.isArray(body.files)) {
      // Правим только галочки: список файлов задаёт сообщение, а не клиент.
      const wanted = new Map(body.files.map((f: any) => [String(f?.fileId), f?.include !== false]));
      next.files = (draft.files ?? []).map((f) => ({ ...f, include: wanted.get(String(f.fileId)) ?? f.include }));
    }
    const projectNow = next.projectId !== undefined ? next.projectId : draft.project_id;
    if (draft.status !== 'created') next.status = projectNow ? 'ready' : 'needs_clarification';

    const updated = (await this.repo.patch(tenantId, draftId, next)) ?? draft;
    void this.announce(tenantId, String(draft.chat_id), updated);
    return { draft: this.view(updated), context: await this.context(tenantId), already: null };
  }

  /**
   * Спросить о проекте прямо в чате.
   *
   * Вопрос адресован автору сообщения: он писал — он и знает, о чём речь. Отвечать
   * может и постановщик: ждать человека, который вышел на обед, незачем. Ответ ловим
   * в `noticeAnswer` — обычной репликой, без кнопок: кнопок в переписке у нас нет, а
   * заводить их ради одного вопроса — отдельная механика на пустом месте.
   */
  async ask(tenantId: string, user: { userId: string; role: string }, draftId: string) {
    const draft = await this.mine(tenantId, user, draftId);
    if (draft.project_id) throw AppException.validation('Проект уже выбран — спрашивать не о чем');
    const chat = await this.chats.get(tenantId, String(draft.chat_id));
    if (!chat) throw AppException.notFound('Чат не найден');

    const projects = await this.repo.projects(tenantId);
    const names = projects.slice(0, 8).map((p) => `«${p.name}»`).join(', ');
    const who = draft.author_id ? await this.chats.userName(tenantId, String(draft.author_id)) : null;
    const body = [
      `${who ? `${who}, ` : ''}к какому проекту относится это поручение?`,
      `Ответьте названием проекта одним сообщением${names ? ` — например, ${names}` : ''}.`,
      'Как только ответите, я дооформлю задачу.',
    ].join('\n');

    const message = await this.chats.addMessage({
      tenantId, chatId: String(draft.chat_id), authorId: user.userId, body, fileId: null, isAi: true,
    });
    const to = chat.kind === 'project' ? await this.chats.teamIds(tenantId) : await this.chats.memberIds(String(chat.id));
    this.realtime.emitToUsers(tenantId, to, 'chat.message', { chatId: String(chat.id), message });

    const updated = (await this.repo.patch(tenantId, draftId, {
      status: 'needs_clarification', questionMessageId: String(message.id),
    })) ?? draft;
    void this.announce(tenantId, String(draft.chat_id), updated);
    return { draft: this.view(updated), context: await this.context(tenantId), already: null };
  }

  /**
   * Пришла реплика в чат — не ответ ли это на наш вопрос о проекте.
   *
   * Зовётся из отправки сообщения. Отвечать могут автор сообщения и постановщик; имя
   * проекта ищем тем же сопоставлением, что и в быстрой команде — полным совпадением
   * значимых слов, без угадывания: поставить задачу не в тот проект хуже, чем не
   * поставить вовсе.
   */
  async noticeAnswer(tenantId: string, chatId: string, authorId: string, text: string): Promise<void> {
    const body = String(text ?? '').trim();
    if (!body) return;
    const waiting = await this.repo.awaiting(tenantId, chatId);
    if (!waiting.length) return;
    const mine = waiting.filter((d) => [String(d.author_id), String(d.initiator_id)].includes(String(authorId)));
    if (!mine.length) return;

    const projects = await this.repo.projects(tenantId);
    const projectId = matchProjectInText(body, projects);
    if (!projectId) return;
    const name = projects.find((p) => String(p.id) === String(projectId))?.name ?? 'проект';

    for (const draft of mine) {
      const updated = await this.repo.patch(tenantId, String(draft.id), { projectId, status: 'ready' });
      if (!updated) continue;
      const chat = await this.chats.get(tenantId, chatId);
      const message = await this.chats.addMessage({
        tenantId,
        chatId,
        authorId,
        body: `Принял: проект «${name}». Черновик задачи «${updated.title}» готов — осталось подтвердить.`,
        fileId: null,
        isAi: true,
      });
      if (chat) {
        const to = chat.kind === 'project' ? await this.chats.teamIds(tenantId) : await this.chats.memberIds(chatId);
        this.realtime.emitToUsers(tenantId, to, 'chat.message', { chatId, message });
      }
      void this.announce(tenantId, chatId, updated);
    }
  }

  /**
   * Подтвердили — создаём задачу.
   *
   * Создание идёт общим путём (`nl.apply`) — тем же, каким задача появляется из голоса
   * и из быстрой команды: два механизма для одного и того же разошлись бы на первой
   * правке. Дальше остаются связи: под сообщением видно, что задача заведена (иначе
   * заведут вторую), а в задаче — откуда она взялась.
   *
   * Повтор безопасен: у черновика уже есть номер задачи — возвращаем его, а не создаём
   * вторую. Это и есть защита от дублей при двойном нажатии и обрыве связи.
   */
  async confirm(
    tenantId: string, user: { userId: string; role: string }, draftId: string,
    /** Теги и подтверждение постановщика: без них сервер задачу не создаст (ТЗ по тегам). */
    tags?: { tagIds?: string[]; suggestedTagIds?: string[]; tagsConfirmed?: boolean; confirmedWithoutTags?: boolean },
  ) {
    const draft = await this.mine(tenantId, user, draftId);
    if (draft.task_id) {
      return { taskId: String(draft.task_id), title: draft.title, projectId: draft.project_id, already: true };
    }
    if (!draft.project_id) throw AppException.validation('Выберите проект — без него задачу не создать');
    if (!String(draft.title ?? '').trim()) throw AppException.validation('Назовите задачу');

    const res: any = await this.nl.apply(tenantId, user.userId, {
      intent: 'create_task',
      task: {
        projectId: String(draft.project_id),
        title: draft.title,
        description: draft.description || undefined,
        assigneeId: draft.assignee_id ? String(draft.assignee_id) : undefined,
        deadline: draft.deadline ?? undefined,
        priority: draft.priority,
        checklist: draft.checklist,
        tagIds: tags?.tagIds ?? [],
        suggestedTagIds: tags?.suggestedTagIds ?? [],
        tagsConfirmed: tags?.tagsConfirmed === true,
        confirmedWithoutTags: tags?.confirmedWithoutTags === true,
      },
    });
    const created = res?.task;
    if (!created?.id) throw AppException.conflict('Задача не создалась');
    const taskId = String(created.id);
    const messageId = String(draft.message_id);
    const chatId = String(draft.chat_id);

    /*
      Связь сообщение ↔ задача. Если по этому сообщению задача уже была (человек
      намеренно создал вторую), прежнюю отметку не перебиваем: первая ссылка ведёт
      туда, где обсуждение уже идёт.
    */
    const msg = await this.chats.messageBody(tenantId, messageId);
    if (!msg?.task_id) await this.chats.linkTask(tenantId, messageId, taskId);
    await this.chats.link({
      tenantId, chatId, entityType: 'task', entityId: taskId, relation: 'created_from', actorId: user.userId,
    });
    await this.chats.audit({
      tenantId, chatId, actorId: user.userId, action: 'task_created',
      detail: { messageId, taskId, title: created.title, draftId: String(draft.id) },
    });

    /*
      Вложения сообщения — в задачу.

      Скриншот и видео и были половиной постановки: «вот тут съезжает» плюс картинка.
      Файл не копируем, а привязываем второй раз — это тот же файл, и две его копии в
      хранилище ничего не улучшат. Уезжает только отмеченное галочкой: остальное
      человек снял сознательно.
    */
    for (const f of draft.files ?? []) {
      if (f.include === false) continue;
      await this.chats.attachFileToTask(tenantId, taskId, String(f.fileId)).catch(() => undefined);
    }

    const updated = (await this.repo.patch(tenantId, draftId, { status: 'created', taskId })) ?? draft;
    const chat = await this.chats.get(tenantId, chatId);
    if (chat) {
      const to = chat.kind === 'project' ? await this.chats.teamIds(tenantId) : await this.chats.memberIds(chatId);
      // Отметку под сообщением должны увидеть все сразу: иначе второй человек заводит
      // по той же фразе вторую задачу.
      this.realtime.emitToUsers(tenantId, to, 'chat.task_linked', {
        chatId, messageId, taskId, title: created.title, projectId: String(created.project_id ?? draft.project_id),
      });
    }
    void this.announce(tenantId, chatId, updated);
    return {
      taskId, title: created.title, projectId: String(created.project_id ?? draft.project_id), already: false,
    };
  }

  /** Отменили до создания: черновик закрывается, строка под сообщением исчезает. */
  async cancel(tenantId: string, user: { userId: string; role: string }, draftId: string) {
    const draft = await this.mine(tenantId, user, draftId);
    if (draft.status === 'created') throw AppException.conflict('Задача уже создана');
    const updated = (await this.repo.patch(tenantId, draftId, { status: 'cancelled' })) ?? draft;
    void this.announce(tenantId, String(draft.chat_id), updated);
    return { ok: true };
  }
}
