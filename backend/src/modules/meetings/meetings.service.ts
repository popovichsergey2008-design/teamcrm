import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { FilesService } from '../files/files.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SecretaryService } from '../secretary/secretary.service';
import { TasksService } from '../tasks/tasks.service';
import { describeFfmpegError, extractAudioChunks } from './audio.util';
import { MEETING_PROMPT, validateMeetingAnalysis } from './meeting-schema';
import { MeetingsRepository } from './meetings.repository';
import { parseSubtitles, repliesToText, Reply, shiftSegments } from './transcript.util';

/** Записи встреч тяжелее обычных вложений: час видео легко весит сотни мегабайт. */
const MAX_RECORDING_BYTES = 600 * 1024 * 1024;
const SUBTITLE_EXT = /\.(vtt|srt)$/i;

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/**
 * Разбор записи встречи: файл → стенограмма → сводка и черновики задач.
 *
 * Задачи создаются ТОЛЬКО после подтверждения человеком и через обычный TasksService —
 * у ИИ нет отдельного входа в домен. Обработка идёт фоном: час записи — это минуты работы.
 */
/** Больше десяти задач с одной встречи — уже не разбор, а засорение доски. */
const MAX_AUTO_TASKS = 10;

@Injectable()
export class MeetingsService {
  private readonly log = new Logger('Meetings');

  constructor(
    private readonly repo: MeetingsRepository,
    private readonly files: FilesService,
    private readonly ai: AiService,
    private readonly tasks: TasksService,
    private readonly knowledge: KnowledgeService,
    private readonly secretary: SecretaryService,
    private readonly realtime: RealtimeService,
  ) {}

  list(tenantId: string) {
    return this.repo.list(tenantId);
  }

  async details(tenantId: string, id: string) {
    const meeting = await this.repo.get(tenantId, id);
    if (!meeting) throw AppException.notFound('Встреча не найдена');
    const [segments, summary, drafts, tasks] = await Promise.all([
      this.repo.segments(tenantId, id),
      this.repo.summary(tenantId, id),
      this.repo.drafts(tenantId, id),
      // что из предложенного стало настоящими задачами — со ссылкой и текущим статусом
      this.repo.linkedTasks(tenantId, id),
    ]);
    return { meeting, segments, summary, drafts, tasks };
  }

  /** Встреча, из которой выросла задача: обратный переход из карточки в Summary. */
  meetingOfTask(tenantId: string, taskId: string) {
    return this.repo.meetingOfTask(tenantId, taskId);
  }

  /** Загрузка записи или готовых субтитров. Обработку запускаем фоном и сразу отвечаем. */
  async create(
    tenantId: string, actorId: string,
    input: { title: string; projectId?: string | null; happenedAt?: string | null; chatId?: string | null },
    file: { buffer: Buffer; originalname: string; mimetype: string },
  ) {
    const isSubtitles = SUBTITLE_EXT.test(file.originalname);
    const stored = await this.files.upload({
      tenantId, userId: actorId, buffer: file.buffer, fileName: file.originalname,
      // .vtt/.srt приходят как text/plain или octet-stream — нормализуем, чтобы пройти валидацию
      contentType: isSubtitles ? 'text/plain' : file.mimetype,
      ownerKind: 'meeting_recording', maxBytes: MAX_RECORDING_BYTES,
    });

    const meeting = await this.repo.create({
      tenantId, projectId: input.projectId ?? null, title: input.title.trim().slice(0, 255),
      happenedAt: input.happenedAt ?? null, source: isSubtitles ? 'transcript' : 'audio',
      fileId: stored.id, createdBy: actorId, chatId: input.chatId ?? null,
    });

    void this.process(tenantId, meeting.id);
    return meeting;
  }

  /**
   * Запись СВОЕГО созвона: дорожка на каждого участника, поэтому говорящий известен
   * достоверно — не по эвристике имени из субтитров, а по авторизованному пользователю.
   * Ради этого и городился огород с PlainTransport и ffmpeg.
   */
  async ingestCallRecording(input: {
    tenantId: string;
    actorId: string | null;
    projectId: string | null;
    title: string;
    /** Комната созвона: по ней встреча связывается с событием календаря. */
    roomId?: string | null;
    /** Чат, из которого начали созвон: туда придёт карточка с итогом. */
    chatId?: string | null;
    tracks: { userId: string; displayName: string; buffer: Buffer; fileName: string; offsetSec: number }[];
  }): Promise<string | null> {
    if (!input.tracks.length) return null;

    const meeting = await this.repo.create({
      tenantId: input.tenantId, projectId: input.projectId, title: input.title.slice(0, 255),
      happenedAt: new Date().toISOString(), source: 'call', fileId: null, createdBy: input.actorId,
      chatId: input.chatId ?? null,
    });

    // Созвон шёл в комнате события — свяжем: итог уйдёт приглашённым, а следующая
    // повестка этой серии узнает, чем закончилась прошлая встреча.
    if (input.roomId) {
      const event = await this.repo.eventByRoom(input.tenantId, input.roomId).catch(() => null);
      if (event) await this.repo.linkEvent(meeting.id, event.id).catch(() => undefined);
    }

    void (async () => {
      try {
        await this.repo.setStatus(meeting.id, 'transcribing');
        const replies: (Reply & { speakerUserId: string | null })[] = [];
        // Словарь встречи нужен и здесь: записи созвонов идут этим путём,
        // а не тем, куда попадают загруженные вручную файлы.
        const hint = await this.speechHint(input.tenantId);

        // Владелец файлов — сотрудник: files.uploaded_by ссылается на users(id), а дорожка
        // вполне может принадлежать гостю. Некому владеть — дорожки не храним, но стенограмму
        // всё равно делаем: она ценнее исходных файлов.
        const owner = input.actorId ?? input.tracks.find((t) => !t.userId.startsWith('guest:'))?.userId ?? null;
        if (!owner) this.log.warn(`встреча ${meeting.id}: дорожки не сохранены — в комнате не было сотрудника`);

        for (const track of input.tracks) {
          // храним дорожки как вложения встречи — на случай спора «я такого не говорил»
          if (owner) await this.files.upload({
            tenantId: input.tenantId, userId: owner, buffer: track.buffer,
            fileName: track.fileName, contentType: 'audio/ogg',
            ownerKind: 'meeting_recording', ownerId: meeting.id, maxBytes: MAX_RECORDING_BYTES,
          }).catch((e) => this.log.warn(`дорожка ${track.userId} не сохранена: ${(e as Error).message}`));

          const { chunks } = await extractAudioChunks(track.buffer, track.fileName);
          for (const chunk of chunks) {
            const segments = await this.ai.transcribeSegments(
              input.tenantId, chunk.buffer, chunk.name, chunk.buffer.length / 4000, hint);
            // Гость сотрудником не является: speaker_user_id ссылается на users(id),
            // и запись туда «guest:<uuid>» уронила бы расшифровку всей встречи.
            const guest = track.userId.startsWith('guest:');
            for (const s of shiftSegments(segments, chunk.offsetSec + track.offsetSec)) {
              replies.push({
                ...s,
                speaker: guest ? `${track.displayName} (гость)` : track.displayName,
                speakerUserId: guest ? null : track.userId,
              });
            }
          }
        }

        if (!replies.length) {
          await this.repo.setStatus(meeting.id, 'error', 'Речь не распознана — проверьте ключ OpenAI');
          return;
        }
        // дорожки писались параллельно: сводим в одну ленту по времени, иначе диалог не читается
        replies.sort((a, b) => a.start - b.start);
        await this.repo.replaceSegments(input.tenantId, meeting.id, replies);
        await this.repo.setDuration(meeting.id, Math.round(replies[replies.length - 1].end));

        await this.repo.setStatus(meeting.id, 'analyzing');
        await this.analyze(input.tenantId, meeting.id, input.projectId, replies);
        await this.repo.setStatus(meeting.id, 'done');
        this.knowledge.enqueue(input.tenantId, 'meeting', meeting.id);
        // Итог возвращается в тот разговор, из которого созвон начали: иначе половина
        // договорённостей не доходит до тех, кто в созвоне не был.
        await this.postCardToChat(input.tenantId, meeting.id, input.chatId ?? null)
          .catch((e) => this.log.warn(`карточка мита в чат не ушла: ${(e as Error).message}`));
      } catch (e) {
        this.log.warn(`созвон ${meeting.id}: ${(e as Error).message}`);
        await this.repo.setStatus(meeting.id, 'error', describeFfmpegError(e)).catch(() => undefined);
      }
    })();

    return meeting.id;
  }

  /** Повторная обработка — после сбоя или когда появился ключ распознавания. */
  async retry(tenantId: string, id: string) {
    const meeting = await this.repo.get(tenantId, id);
    if (!meeting) throw AppException.notFound('Встреча не найдена');
    await this.repo.setStatus(id, 'queued', null);
    void this.process(tenantId, id);
    return { restarted: true };
  }

  /** Конвейер: стенограмма → разбор → черновики. Ошибки не роняют процесс, а видны в статусе. */
  async process(tenantId: string, meetingId: string): Promise<void> {
    try {
      const meeting = await this.repo.get(tenantId, meetingId);
      if (!meeting?.file_id) return;

      await this.repo.setStatus(meetingId, 'transcribing');
      const { stream } = await this.files.getForDownload(tenantId, meeting.file_id);
      const source = await toBuffer(stream);

      const replies = meeting.source === 'transcript'
        ? parseSubtitles(source.toString('utf8'))
        : await this.transcribeRecording(tenantId, meetingId, source, meeting.title);

      if (!replies.length) {
        await this.repo.setStatus(meetingId, 'error',
          meeting.source === 'transcript'
            ? 'В файле субтитров не нашлось реплик'
            : 'Распознавание вернуло пустой результат — проверьте ключ OpenAI и качество записи');
        return;
      }
      await this.repo.replaceSegments(tenantId, meetingId, replies);
      if (meeting.source === 'transcript') {
        await this.repo.setDuration(meetingId, Math.round(replies[replies.length - 1].end));
      }

      await this.repo.setStatus(meetingId, 'analyzing');
      await this.analyze(tenantId, meetingId, meeting.project_id, replies);

      await this.repo.setStatus(meetingId, 'done');
      this.knowledge.enqueue(tenantId, 'meeting', meetingId); // стенограмма → корпоративная память
    } catch (e) {
      this.log.warn(`meeting ${meetingId} failed: ${(e as Error).message}`);
      await this.repo.setStatus(meetingId, 'error', describeFfmpegError(e)).catch(() => undefined);
    }
  }

  /**
   * Словарь встречи для распознавания: имена команды и рабочие слова.
   *
   * Без него Whisper подставляет похожее по звучанию из общего языка — так
   * «на Юру» превращалось в «на евро», а «стенограмма» в «синаграмму».
   * Имена сотрудников он угадать не может в принципе, их надо назвать.
   */
  private async speechHint(tenantId: string): Promise<string> {
    const team = await this.repo.teamMembers(tenantId).catch(() => []);
    const names = team.map((u) => u.full_name).filter(Boolean).slice(0, 40).join(', ');
    return [
      'Рабочий созвон команды.',
      names ? `Участники: ${names}.` : '',
      'Термины: задача, стенограмма, дедлайн, созвон, доска, проект, спринт, тестирование, интеграция.',
    ].filter(Boolean).join(' ');
  }

  /** Звук → куски → распознавание каждого куска → сшивка по времени. */
  private async transcribeRecording(tenantId: string, meetingId: string, source: Buffer, name: string): Promise<Reply[]> {
    const { chunks, durationSec } = await extractAudioChunks(source, name);
    if (durationSec) await this.repo.setDuration(meetingId, durationSec);

    const hint = await this.speechHint(tenantId);
    const replies: Reply[] = [];
    for (const chunk of chunks) {
      const segments = await this.ai.transcribeSegments(tenantId, chunk.buffer, chunk.name, chunk.buffer.length / 4000, hint);
      replies.push(...shiftSegments(segments, chunk.offsetSec));
    }
    return replies;
  }

  /** Стенограмма → LLM → строгая схема → черновики задач с сопоставленными исполнителями. */
  /**
   * Карточка итога в чат.
   *
   * Ошибка здесь не должна ничего ронять: разбор уже сделан и лежит в разделе встреч,
   * а карточка — способ донести его до людей, а не сам результат.
   */
  private async postCardToChat(tenantId: string, meetingId: string, chatId: string | null): Promise<void> {
    if (!chatId) return;
    const [meeting, summary, drafts] = await Promise.all([
      this.repo.get(tenantId, meetingId),
      this.repo.summary(tenantId, meetingId).catch(() => null),
      this.repo.drafts(tenantId, meetingId).catch(() => []),
    ]);
    if (!meeting) return;

    const mins = Math.max(1, Math.round(Number(meeting.duration_sec ?? 0) / 60));
    const lines = [`Созвон завершён · ${mins} мин`];
    const text = String((summary as { summary?: string } | null)?.summary ?? '').trim();
    if (text) lines.push(text.slice(0, 600));
    if (drafts.length) lines.push(`Предложено задач: ${drafts.length}`);

    const messageId = await this.repo.postMeetingCard(tenantId, String(chatId), meetingId, lines.join('\n'));
    if (!messageId) return;
    // Карточка обязана появиться у всех сразу, как обычное сообщение: чат, который
    // «оживает» только после перезагрузки, никто не считает живым.
    const to = await this.repo.chatAudience(tenantId, String(chatId));
    this.realtime.emitToUsers(tenantId, to, 'chat.message', {
      chatId: String(chatId),
      message: {
        id: messageId, chat_id: String(chatId), author_id: null, author_name: null,
        body: lines.join('\n'), file_id: null, file_name: null,
        created_at: new Date().toISOString(), edited_at: null, meeting_id: String(meetingId),
      },
    });
  }

  private async analyze(tenantId: string, meetingId: string, projectId: string | null, replies: Reply[]): Promise<void> {
    const [team, projects] = await Promise.all([
      this.repo.teamMembers(tenantId),
      this.repo.projectsWithColumns(tenantId).catch(() => []),
    ]);
    // Состав команды и доски идут вместе со стенограммой: без них модель не свяжет
    // «поставь на Юру» с Юрием Про и «в колонку Тексты» — с настоящей колонкой.
    const roster = team.length
      ? `Сотрудники компании: ${team.map((u) => u.full_name).slice(0, 60).join(', ')}.\n`
      : '';
    const boards = projects.length
      ? `Проекты и их колонки:\n${projects.slice(0, 40)
        .map((p) => `- ${p.name}: ${(p.columns ?? []).map((c) => c.name).join(', ') || '—'}`).join('\n')}\n`
      : '';
    const transcript = `${roster}${boards}\n${repliesToText(replies).slice(0, 120_000)}`; // защита от гигантских встреч
    const raw = await this.ai.generate(tenantId, MEETING_PROMPT, transcript, 'meeting_analyze');
    const parsed = safeJson(raw);
    const { value, errors } = validateMeetingAnalysis(parsed);
    if (errors.length) this.log.warn(`meeting ${meetingId}: разбор с замечаниями — ${errors.join('; ')}`);
    if (!value) {
      await this.repo.saveSummary(tenantId, meetingId, 'ИИ не смог разобрать встречу. Стенограмма доступна целиком.', [], []);
      return;
    }

    await this.repo.saveSummary(tenantId, meetingId, value.summary, value.decisions, value.risks);
    // Протокол встречи — самая дорогая ручная работа из всего, что делает ассистент:
    // раньше его писал человек по памяти, если вообще писал.
    void this.secretary.record({
      tenantId, kind: 'meeting_summary',
      summary: `Протокол встречи: ${value.decisions.length} договорённостей, ${value.tasks.length} задач`,
      subjectType: 'meeting', subjectId: meetingId,
    });

    await this.repo.replaceDrafts(tenantId, meetingId, value.tasks.map((t) => {
      // Названный вслух проект важнее выбранного при загрузке записи: на встрече
      // говорят о деле, а поле в форме часто оставляют пустым.
      const project = matchNamed(projects, t.projectHint);
      const column = project ? matchNamed(project.columns ?? [], t.columnHint) : null;
      return {
        title: t.title,
        description: t.description,
        assigneeId: matchTeamMember(team, t.assigneeHint),
        assigneeHint: t.assigneeHint,
        projectId: project?.id ?? projectId,
        projectHint: t.projectHint,
        columnId: column?.id ?? null,
        columnHint: t.columnHint,
        // Постановщик — тот, кто поручил на встрече, а не тот, кто нажмёт «создать».
        authorId: matchTeamMember(team, t.authorHint),
        authorHint: t.authorHint,
        deadlineAt: t.deadline,
        quote: t.quote,
      };
    }));

    await this.afterMeeting(tenantId, meetingId, value.summary, value.decisions.length);
  }

  /**
   * Что происходит ПОСЛЕ разбора: задачи и рассылка итога.
   *
   * Раньше разбор заканчивался строкой в базе, и о нём знал только тот, кто сам
   * открыл страницу встречи. Теперь итог доходит до всех, кто на встрече был.
   *
   * Задачи создаются сами ТОЛЬКО там, где модель уверенно назвала и исполнителя,
   * и проект. Остальное остаётся черновиком: «ИИ ничего не создаёт молча» — правило,
   * которое дорого нарушать целиком, а ошибается модель именно в исполнителях.
   * Выключается тумблером «создавать задачи со встречи сразу».
   */
  private async afterMeeting(tenantId: string, meetingId: string, summary: string, decisions: number): Promise<void> {
    try {
      const [settings, meeting] = await Promise.all([
        this.repo.meetingSettings(tenantId),
        this.repo.get(tenantId, meetingId),
      ]);
      if (settings.mode === 'off') return; // ассистент выключен — молчим и ничего не создаём

      const created: { title: string; assigneeId: string | null }[] = [];
      if (settings.autoTasks) {
        const actor = meeting?.created_by ?? null;
        for (const d of await this.repo.drafts(tenantId, meetingId)) {
          if (d.status !== 'pending' || !d.assignee_id || !d.project_id) continue;
          if (created.length >= MAX_AUTO_TASKS) break; // на всякий случай: разбор мог насчитать десятки
          try {
            // тем же путём, что и руками: постановщик — тот, кто поручил на встрече
            await this.applyDraft(tenantId, String(actor ?? d.assignee_id), d.id);
            created.push({ title: d.title, assigneeId: d.assignee_id });
          } catch (e) {
            this.log.warn(`встреча ${meetingId}: черновик ${d.id} не применён — ${(e as Error).message}`);
          }
        }
      }

      const pending = (await this.repo.drafts(tenantId, meetingId)).filter((d) => d.status === 'pending').length;
      for (const person of await this.repo.audience(tenantId, meetingId)) {
        const mine = created.filter((t) => String(t.assigneeId) === String(person.user_id)).map((t) => t.title);
        this.realtime.emitToUsers(tenantId, [String(person.user_id)], 'assistant.meeting-result', {
          meetingId: String(meetingId),
          title: meeting?.title ?? 'Встреча',
          summary: summary.slice(0, 400),
          decisions,
          created: created.length,
          pending,
          mine,
        });
      }
    } catch (e) {
      // итог — не причина ронять разбор: стенограмма и сводка уже сохранены
      this.log.warn(`итог встречи ${meetingId}: ${(e as Error).message}`);
    }
  }

  /** Подтверждение черновика: создаём обычную задачу тем же путём, что и руками. */
  async applyDraft(tenantId: string, actorId: string, draftId: string, patch?: {
    title?: string; description?: string | null; assigneeId?: string | null; projectId?: string | null;
  }) {
    const draft = await this.repo.draft(tenantId, draftId);
    if (!draft) throw AppException.notFound('Черновик не найден');
    if (draft.status !== 'pending') throw AppException.conflict('Черновик уже обработан');

    const projectId = patch?.projectId ?? draft.project_id;
    if (!projectId) throw AppException.validation('Выберите проект для задачи');

    // Колонка — только если она принадлежит выбранному проекту: проект могли
    // сменить руками, и колонка из другого проекта сломала бы доску.
    const columnId = draft.column_id && String(projectId) === String(draft.project_id)
      ? draft.column_id : undefined;

    const task = await this.tasks.create(tenantId, {
      projectId,
      columnId,
      title: (patch?.title ?? draft.title).slice(0, 255),
      description: patch?.description ?? draft.description ?? undefined,
      assigneeId: (patch?.assigneeId ?? draft.assignee_id) ?? undefined,
      // Постановщик — тот, кто поручил на встрече. Нажавший «создать» лишь
      // подтвердил чужое поручение, и приписывать его себе неправильно.
      managerId: draft.author_id ?? undefined,
    } as any, actorId);

    await this.repo.markDraftApplied(draftId, task.id);
    void this.secretary.record({
      tenantId, userId: draft.author_id ?? actorId, kind: 'meeting_task',
      summary: `Задача со встречи: «${task.title}»`, subjectType: 'task', subjectId: task.id,
    });
    return task;
  }

  /**
   * Сохранить правку черновика, не создавая задачу.
   *
   * ИИ формулирует черновик, а не готовую задачу: имя расслышано неточно, поручение
   * сжато до неузнаваемости, исполнитель определён по последней реплике. Дать
   * исправить это ДО создания дешевле, чем потом чинить задачу на доске — и честнее
   * по отношению к тому, кому она достанется.
   */
  async updateDraft(tenantId: string, draftId: string, patch: {
    title?: string; description?: string | null; assigneeId?: string | null; projectId?: string | null;
  }) {
    const draft = await this.repo.draft(tenantId, draftId);
    if (!draft) throw AppException.notFound('Черновик не найден');
    if (draft.status !== 'pending') throw AppException.conflict('Черновик уже обработан');
    if (patch.title !== undefined && !String(patch.title).trim()) {
      throw AppException.validation('Название задачи не может быть пустым');
    }
    const updated = await this.repo.updateDraft(tenantId, draftId, patch);
    return updated ?? draft;
  }

  async rejectDraft(tenantId: string, draftId: string) {
    const draft = await this.repo.draft(tenantId, draftId);
    if (!draft) throw AppException.notFound('Черновик не найден');
    await this.repo.markDraftRejected(draftId);
    return { rejected: true };
  }
}

/** LLM любит обрамлять JSON пояснениями и ```-блоками — достаём объект из текста. */
function safeJson(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

/**
 * Имя, прозвучавшее на встрече → сотрудник. При неоднозначности возвращаем null:
 * лучше пустой исполнитель, который заполнит человек, чем задача на не того.
 */
/**
 * Проект или колонка по названию, как оно прозвучало.
 *
 * Точное совпадение, затем вхождение — речь редко воспроизводит название
 * дословно: «в текстах», «колонка Тексты». Неоднозначность оставляем пустой:
 * положить задачу не туда хуже, чем не положить никуда.
 */
export function matchNamed<T extends { id: string; name: string }>(items: T[], hint: string | null): T | null {
  if (!hint) return null;
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim();
  const needle = norm(hint);
  if (needle.length < 2) return null;

  const exact = items.filter((x) => norm(x.name) === needle);
  if (exact.length === 1) return exact[0];

  const partial = items.filter((x) => norm(x.name).includes(needle) || needle.includes(norm(x.name)));
  return partial.length === 1 ? partial[0] : null;
}

export function matchTeamMember(team: { id: string; full_name: string }[], hint: string | null): string | null {
  if (!hint) return null;
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim();
  const needle = norm(hint);
  if (needle.length < 2) return null;

  const exact = team.filter((u) => norm(u.full_name) === needle);
  if (exact.length === 1) return exact[0].id;

  const byToken = team.filter((u) => norm(u.full_name).split(/\s+/).includes(needle));
  if (byToken.length === 1) return byToken[0].id;

  const byPrefix = team.filter((u) => norm(u.full_name).startsWith(needle));
  return byPrefix.length === 1 ? byPrefix[0].id : null;
}
