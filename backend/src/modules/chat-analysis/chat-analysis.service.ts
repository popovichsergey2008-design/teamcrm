import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { TasksService } from '../tasks/tasks.service';
import { SecretaryService } from '../secretary/secretary.service';
import { PromptsService } from '../prompts/prompts.service';
import { matchProjectInText } from '../nl/task-draft';
import { dedupKeyOf, ExtractedAction, parseAnalysis, RefCatalog, resolveProject } from './analysis-schema';
import { resolveRoles, taskReadiness } from './roles-rules';
import { ChatAnalysisRepository, DueChatRow, MessageRow } from './chat-analysis.repository';
import { closedSegments, Segment, SegmentMessage } from './segments';

/**
 * Разбор переписки: что агент понял (ТЗ-12, этап 1).
 *
 * На этом этапе агент НИЧЕГО НЕ СОЗДАЁТ. Он читает затихшие разговоры и записывает, что
 * в них увидел, вместе с сообщениями, из которых это выросло. Смысл этапа — посмотреть
 * на своих переписках, насколько он попадает, ПРЕЖДЕ чем давать ему что-то делать.
 *
 * Границы, установленные заказчиком 29.09 и заложенные в код, а не в настройку:
 *   * личные переписки и заметки себе не разбираются вовсе (условие в репозитории);
 *   * мгновенного разбора каждого сообщения нет — только затихший разговор;
 *   * режим по умолчанию «только предлагать»: автосоздания в продукте пока нет.
 */

const FALLBACK_SYSTEM = [
  'Ты разбираешь рабочую переписку команды и находишь в ней смыслы. Ты ничего не создаёшь —',
  'только сообщаешь, что понял. Отвечай строго в JSON.',
  '',
  'Виды наблюдений:',
  '— task: поручение, которое кто-то взялся или обязан сделать;',
  '— decision: принятое решение («решили оставить старую форму до релиза»);',
  '— meeting: договорённость о встрече или созвоне;',
  '— question: вопрос, на который нужен ответ;',
  '— status: сообщение о ходе работы («API готов, осталось протестировать»);',
  '— blocker: помеха, из-за которой работа стоит;',
  '— idea: мысль без обязательства («можно было бы когда-нибудь переделать»).',
  '',
  'Правила, которые важнее всего:',
  '1. Смотри на ВЕСЬ разговор, а не на отдельную реплику. «Я посмотрю сегодня» — задача',
  '   только если выше просили посмотреть; тогда постановщик это автор просьбы.',
  '2. Возвращай ФИНАЛЬНОЕ состояние разговора. Поручение отменили — не возвращай задачу.',
  '   Сменили исполнителя или срок — верни последний вариант.',
  '3. Не задача: шутка, пример, цитата, гипотеза, пересказ прошлого («я вчера сделал»),',
  '   отказ, отмена, размышление без обязательства, вопрос, кусок кода, сообщение бота.',
  '4. Людей и проекты называй ТОЛЬКО пометками из справочника (например u3, p1). Если',
  '   подходящей пометки нет — оставь поле пустым. Не придумывай номера.',
  '5. У каждого наблюдения перечисли сообщения-источники по их id из переписки. Роли:',
  '   instruction — само поручение, acceptance — согласие взять, correction — правка,',
  '   cancellation — отмена, decision — решение, context — остальное.',
  '6. Уверенность ставь честно: 0.95 и выше — только когда сказано прямым текстом.',
  '7. Пустой список actions — нормальный и частый ответ. Обычная переписка не должна',
  '   порождать ничего.',
  '',
  'Формат ответа:',
  '{"actions":[{"type":"task","title":"...","description":"...","project_ref":"p1",',
  '"assigner_ref":"u1","assignee_ref":"u2","deadline":"2026-10-02T18:00:00+03:00",',
  '"meeting_at":null,"confidence":{"intent":0.95,"project":0.9,"assigner":0.95,"assignee":0.9},',
  '"sources":[{"message_id":"881","role":"instruction"}]}]}',
].join('\n');

@Injectable()
export class ChatAnalysisService {
  private readonly log = new Logger('ChatAnalysis');

  constructor(
    private readonly repo: ChatAnalysisRepository,
    private readonly ai: AiService,
    private readonly prompts: PromptsService,
    private readonly tasks: TasksService,
    /** Журнал действий ИИ: по нему видно, сколько работы он снял с людей. */
    private readonly secretary: SecretaryService,
  ) {}

  // ── настройки ──

  settings(tenantId: string) {
    return this.repo.settings(tenantId);
  }

  saveSettings(tenantId: string, patch: { enabled?: boolean; quietMinutes?: number; mode?: string }) {
    return this.repo.saveSettings(tenantId, patch);
  }

  setChatAnalysis(tenantId: string, chatId: string, on: boolean) {
    return this.repo.setChatAnalysis(tenantId, chatId, on);
  }

  /** Наблюдения — только по тем чатам, которые человеку и так видны. */
  actions(tenantId: string, userId: string, o: { chatId?: string | null; limit?: number }) {
    return this.repo.actions(tenantId, userId, o);
  }

  runs(tenantId: string, userId: string, limit?: number) {
    return this.repo.runs(tenantId, userId, limit);
  }

  // ── что делать с наблюдением ──

  /**
   * Завести задачу по наблюдению.
   *
   * Единственный путь, которым разбор переписки превращается в задачу: её заводит
   * ЧЕЛОВЕК, нажав кнопку. Сам агент ничего не создаёт — это решение заказчика.
   *
   * Постановщик — тот, кто поручил в переписке, а не тот, кто нажал «завести».
   * Нажавший лишь подтвердил чужое поручение, и приписывать его себе неправильно
   * (так же сделано в задачах со встреч).
   */
  async confirm(
    tenantId: string, userId: string, id: string,
    patch: { projectId?: string; assigneeId?: string; title?: string } = {},
  ) {
    const a = await this.repo.one(tenantId, userId, id);
    if (!a) throw AppException.notFound('Наблюдение не найдено');
    if (a.action_type !== 'task') throw AppException.validation('Задачей может стать только поручение');
    if (a.created_entity_id) throw AppException.conflict('Задача по этому наблюдению уже заведена');
    if (['rejected', 'cancelled'].includes(a.status)) throw AppException.conflict('Наблюдение уже закрыто');

    const projectId = patch.projectId ?? a.project_id;
    if (!projectId) throw AppException.validation('Выберите проект для задачи');

    const task = await this.tasks.create(tenantId, {
      projectId: String(projectId),
      title: String(patch.title ?? a.title).slice(0, 255),
      description: a.description || undefined,
      assigneeId: (patch.assigneeId ?? a.assignee_id) ?? undefined,
      managerId: a.assigner_id ?? undefined,
      deadlineAt: a.deadline_at ?? undefined,
    } as any, userId);

    // Откуда задача взялась: по этому сообщению карточка открывает исходный разговор.
    if (a.instruction_message_id) {
      await this.repo.linkSourceMessage(tenantId, String(task.id), String(a.instruction_message_id));
    }
    await this.repo.markAction(tenantId, id, { status: 'confirmed', entityType: 'task', entityId: String(task.id) });
    void this.secretary.record({
      tenantId, userId: a.assigner_id ?? userId, kind: 'nl_task',
      summary: `Задача из переписки: «${task.title}»`, subjectType: 'task', subjectId: task.id,
    });
    return { actionId: id, task };
  }

  /** «Это не задача». Наблюдение не удаляем: по отказам видно, где агент ошибается. */
  async reject(tenantId: string, userId: string, id: string) {
    const a = await this.repo.one(tenantId, userId, id);
    if (!a) throw AppException.notFound('Наблюдение не найдено');
    if (a.created_entity_id) throw AppException.conflict('По наблюдению уже заведена задача');
    await this.repo.markAction(tenantId, id, { status: 'rejected' });
    return { actionId: id, status: 'rejected' };
  }

  // ── разбор ──

  /**
   * Один проход по чатам, где разговор затих.
   *
   * `tenantId` задан — разбираем только эту организацию: так ходит кнопка «прогнать
   * сейчас», и чужие переписки она задевать не должна. Без него — обычный проход
   * планировщика по всем.
   *
   * Ошибка в одном чате не отменяет остальные: это N независимых разговоров.
   */
  async tick(now = new Date(), tenantId: string | null = null): Promise<number> {
    let analyzed = 0;
    const chats = await this.repo.dueChats(now, tenantId);
    for (const chat of chats) {
      try {
        analyzed += await this.analyzeChat(chat, now);
      } catch (e) {
        this.log.warn(`чат ${chat.chat_id}: ${(e as Error).message}`);
      }
    }
    return analyzed;
  }

  /**
   * Разобрать затихшие отрезки одного чата.
   *
   * Отметку «докуда разобрано» двигаем ПОСЛЕ каждого удачного отрезка. Сбой прерывает
   * чат на этом месте: оставшиеся сообщения дождутся следующего прохода. Терять
   * переписку из-за недоступной модели нельзя (разд. 61).
   */
  private async analyzeChat(chat: DueChatRow, now: Date): Promise<number> {
    const messages = await this.repo.messagesAfter(chat.tenant_id, chat.chat_id, chat.last_message_id);
    if (!messages.length) return 0;

    const quietMs = Math.max(chat.quiet_minutes, 1) * 60_000;
    const segments = closedSegments(messages.map(toSegmentMessage), quietMs, now);
    if (!segments.length) return 0;

    let done = 0;
    for (const seg of segments) {
      const part = messages.filter((m) => Number(m.id) >= Number(seg.startId) && Number(m.id) <= Number(seg.endId));
      const ok = await this.analyzeSegment(chat, part, seg, 'segment');
      if (!ok) break;
      done++;
    }
    return done;
  }

  /** Разобрать один отрезок. Возвращает false, если проход не удался. */
  private async analyzeSegment(
    chat: DueChatRow, messages: MessageRow[], seg: Segment, mode: 'segment' | 'daily',
  ): Promise<boolean> {
    const runId = await this.repo.startRun({
      tenantId: chat.tenant_id, chatId: chat.chat_id, mode,
      startMessageId: seg.startId, endMessageId: seg.endId, messages: messages.length,
    });

    try {
      const [people, projects] = await Promise.all([
        this.repo.people(chat.tenant_id, chat.chat_id, chat.project_id),
        this.repo.projects(chat.tenant_id),
      ]);

      // Справочник: наружу уходят пометки, обратно принимаются только они (разд. 52).
      const userRef = new Map(people.map((p, i) => [String(p.id), `u${i + 1}`]));
      const projectRef = new Map(projects.map((p, i) => [String(p.id), `p${i + 1}`]));
      const catalog: RefCatalog = {
        users: new Map(people.map((p, i) => [`u${i + 1}`, String(p.id)])),
        projects: new Map(projects.map((p, i) => [`p${i + 1}`, String(p.id)])),
        messageIds: new Set(messages.map((m) => String(m.id))),
      };

      const payload = {
        today: new Date().toISOString(),
        timezone: chat.timezone,
        chat: {
          kind: chat.kind,
          title: chat.title,
          // Чат проекта сам по себе называет проект — это сильнейшее основание (разд. 9).
          project_ref: chat.project_id ? projectRef.get(String(chat.project_id)) ?? null : null,
        },
        people: people.map((p, i) => ({ ref: `u${i + 1}`, name: p.name })),
        projects: projects.map((p, i) => ({ ref: `p${i + 1}`, name: p.name })),
        messages: messages.map((m) => ({
          id: String(m.id),
          at: m.created_at,
          author_ref: m.author_id ? userRef.get(String(m.author_id)) ?? null : null,
          author: m.is_ai ? 'бот' : (m.author_name ?? 'неизвестно'),
          is_bot: m.is_ai,
          reply_to: m.reply_to_id,
          thread_root: m.thread_root_id,
          text: String(m.body ?? '').slice(0, 2000),
        })),
      };

      const prompt = await this.prompts.resolve(chat.tenant_id, 'chat.analysis', {}, chat.chat_id);
      const raw = await this.ai.generate(
        chat.tenant_id, prompt?.body ?? FALLBACK_SYSTEM, JSON.stringify(payload), 'chat_analysis',
        { promptVersionId: prompt?.versionId, model: prompt?.model, params: prompt?.params },
      );

      /*
        Проект берём САМИ, а не у модели.

        Живая проверка показала, чем это кончается иначе: в групповом чате, ни к какому
        проекту не привязанном, модель уверенно приписала задачу первому попавшемуся
        проекту организации. Твёрдых оснований ровно два — чат проекта и название,
        прозвучавшее в самом разговоре; остального не существует, и пусто честнее.
      */
      const spoken = matchProjectInText(
        messages.map((m) => String(m.body ?? '')).join('\n'),
        projects.map((p) => ({ id: String(p.id), name: p.name })),
      );

      // Кто что написал: по авторству определяются постановщик и исполнитель.
      const authorOf = new Map(messages.map((m) => [String(m.id), m.author_id ? String(m.author_id) : null]));

      const actions = parseAnalysis(raw, catalog).map((a) => {
        const p = resolveProject({ chatProjectId: chat.project_id, spokenId: spoken });
        /*
          Роли — по самой переписке, а не по ответу модели (ТЗ разд. 10). Модель
          отвечает на вопрос «где здесь поручение», а «чьё оно» видно по тому, кто
          написал это сообщение. Неверный постановщик — худшая из ошибок функции.
        */
        const roles = resolveRoles({
          sources: a.sources.map((s) => ({ ...s, authorId: authorOf.get(s.messageId) ?? null })),
          modelAssigneeId: a.assigneeId,
        });

        const fixed: ExtractedAction = {
          ...a,
          projectId: p.projectId,
          assignerId: roles.assignerId,
          assigneeId: roles.assigneeId,
          confidence: {
            ...a.confidence,
            project: p.confidence,
            assigner: roles.assignerConfidence,
            assignee: roles.assigneeConfidence,
          },
        };
        // Ключ от повторов считается в том числе по проекту и исполнителю — пересобираем.
        fixed.dedupKey = dedupKeyOf(fixed);

        /*
          Состояние наблюдения. Поручению его считаем: «готово» — человеку остаётся
          нажать «завести». Остальные виды на этом этапе просто замечены.
        */
        const status = fixed.type === 'task'
          ? taskReadiness({
            projectId: fixed.projectId, assigneeId: fixed.assigneeId, assignerId: fixed.assignerId,
            cancelled: roles.cancelled, confidence: fixed.confidence,
          })
          : 'detected';
        return { action: fixed, status };
      });

      let stored = 0;
      for (const { action: a, status } of actions) {
        if (await this.repo.addAction(chat.tenant_id, runId, chat.chat_id, a, status)) stored++;
      }

      await this.repo.finishRun(runId, {
        status: 'done', model: prompt?.model ?? null,
        promptVersion: prompt?.version != null ? String(prompt.version) : null,
        actions: stored,
      });
      // Отметку двигаем только теперь: проход состоялся.
      await this.repo.moveCheckpoint(chat.tenant_id, chat.chat_id, seg.endId, runId);
      if (stored) this.log.log(`чат ${chat.chat_id}: наблюдений ${stored} из ${actions.length}`);
      return true;
    } catch (e) {
      const message = (e as Error).message || 'разбор не удался';
      await this.repo.finishRun(runId, { status: 'failed', error: message.slice(0, 500) });
      this.log.warn(`чат ${chat.chat_id}, отрезок ${seg.startId}–${seg.endId}: ${message}`);
      return false;
    }
  }
}

function toSegmentMessage(m: MessageRow): SegmentMessage {
  return { id: String(m.id), createdAt: new Date(m.created_at), authorId: m.author_id, isAi: m.is_ai };
}

export type { ExtractedAction };
