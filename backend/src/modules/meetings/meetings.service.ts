import { ProjectResolverService } from '../nl/project-resolver.service';
import { ProjectViewer } from '../../common/access/project-visibility';
import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { FilesService } from '../files/files.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { PromptsService } from '../prompts/prompts.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TaskCardService } from '../taskcard/taskcard.service';
import { SecretaryService } from '../secretary/secretary.service';
import { TasksService } from '../tasks/tasks.service';
import { describeFfmpegError, extractAudioChunks, mixTracks } from './audio.util';
import { MEETING_PROMPT, SUMMARY_PROMPT, validateMeetingAnalysis } from './meeting-schema';
import { draftConfidence, newsKind, speakerAt } from './postcall-rules';
import { DraftRow, MeetingsRepository } from './meetings.repository';
import { blocksOf, PostcallService } from './postcall.service';
import { AudioProofService } from './audio-proof.service';
import { TaskActivityRepository } from '../tasks/task-activity.repository';
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

  /**
   * Кому рассказать о готовом разборе созвона.
   *
   * Подписчики регистрируются сами (см. службу заботы): встречам не нужно знать, кто
   * их слушает, — так модули остаются независимыми.
   */
  private readonly sinks: ((e: {
    tenantId: string; meetingId: string; roomId: string; summary: string | null;
  }) => Promise<void>)[] = [];

  onCallProcessed(fn: (e: {
    tenantId: string; meetingId: string; roomId: string; summary: string | null;
  }) => Promise<void>): void {
    this.sinks.push(fn);
  }

  constructor(
    private readonly repo: MeetingsRepository,
    private readonly files: FilesService,
    private readonly ai: AiService,
    private readonly tasks: TasksService,
    private readonly knowledge: KnowledgeService,
    private readonly secretary: SecretaryService,
    private readonly realtime: RealtimeService,
    private readonly taskcard: TaskCardService,
    private readonly postcall: PostcallService,
    private readonly prompts: PromptsService,
    private readonly proofs: AudioProofService,
    private readonly activity: TaskActivityRepository,
    /** ТЗ-31: проект черновика, если у встречи его нет. */
    private readonly projectResolver: ProjectResolverService,
  ) {}

  list(tenantId: string, viewer: ProjectViewer) {
    return this.repo.list(tenantId, viewer);
  }

  /** Встреча видна человеку — иначе «не найдена», не выдаём, что она есть (ТЗ-21, этап 0). */
  async assertVisible(tenantId: string, id: string, viewer: ProjectViewer): Promise<void> {
    if (!(await this.repo.visible(tenantId, String(id), viewer))) throw AppException.notFound('Встреча не найдена');
  }

  async assertDraftVisible(tenantId: string, draftId: string, viewer: ProjectViewer): Promise<void> {
    const meetingId = await this.repo.meetingOfDraft(tenantId, String(draftId));
    if (!meetingId) throw AppException.notFound('Черновик не найден');
    await this.assertVisible(tenantId, meetingId, viewer);
  }

  async details(tenantId: string, id: string, viewer?: ProjectViewer) {
    if (viewer) await this.assertVisible(tenantId, id, viewer);
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

  /**
   * Итоги встречи после звонка (ТЗ-22): всё, что показывает экран, одним ответом —
   * разбор с готовностью блоков, сводка, решения, черновики, созданные задачи.
   * Открытие экрана владельцем отмечается: «итоги не разобраны» ≠ «итоги не видел».
   */
  async postcallView(tenantId: string, id: string, viewer: ProjectViewer & { userId: string }) {
    const details = await this.details(tenantId, id, viewer);
    const [review, decisions] = await Promise.all([
      this.postcall.review(tenantId, id),
      // решения — из журнала: с секундой, кто сказал, и можно отметить «изменили»
      this.repo.meetingDecisions(tenantId, id),
    ]);
    if (review && String(review.owner_id) === String(viewer.userId)) await this.postcall.opened(review);
    // письмо клиенту — только тому, кому его подготовили; отправляет он же
    const followup = await this.postcall.followupFor(tenantId, viewer.userId, id).catch(() => null);
    // ТЗ-25: фрагмент у каждого черновика, запись для предпросмотра (§34), уже существующие задачи (§10)
    const open = details.drafts.filter((d) => d.status === 'pending' || d.status === 'failed');
    const [proofs, duplicates] = await Promise.all([
      this.proofs.forDrafts(tenantId, id, open.map((d) => ({ ...d, id: String(d.id), source_sec: d.source_sec ?? null }))).catch(() => ({})),
      this.repo.duplicateTasks(tenantId, id, open.map((d) => String(d.id))).catch(() => []),
    ]);
    const recording = details.meeting.file_id && details.meeting.source !== 'transcript'
      ? this.files.signPlay(tenantId, String(details.meeting.file_id), 1800) : null;
    return {
      ...details,
      decisions,
      followup,
      proofs,
      recording,
      duplicates: Object.fromEntries(duplicates.map((x) => [x.draft_id, { taskId: x.task_id, projectId: x.project_id, title: x.title }])),
      review: review ? {
        status: review.status,
        ai: review.ai,
        blocks: blocksOf(review),
        ownerId: review.owner_id,
        canClose: this.postcall.canClose(review, viewer.userId),
        participants: review.participants,
        recapSentAt: review.recap_sent_at,
        // веха прозвучала в решениях — экран предложит пост в «Новости» (§26)
        newsWorthy: !!newsKind(decisions.map((d) => d.text)),
        snoozedUntil: review.snoozed_until,
        reviewedAt: review.reviewed_at,
        completedAt: review.completed_at,
      } : null,
    };
  }

  /** «Подготовить пост в Новости» по вехе встречи. */
  async postcallNews(tenantId: string, id: string, viewer: ProjectViewer & { userId: string }) {
    await this.assertVisible(tenantId, id, viewer);
    const [meeting, decisions] = await Promise.all([this.repo.get(tenantId, id), this.repo.meetingDecisions(tenantId, id)]);
    if (!meeting) throw AppException.notFound('Встреча не найдена');
    return this.postcall.toNews(tenantId, id, viewer.userId, meeting, decisions.map((d) => d.text));
  }

  /**
   * Экран итогов открывается сразу после «Завершить», а встреча появляется чуть позже —
   * когда допишется запись. Экран спрашивает по комнате, пока не получит номер.
   */
  async postcallByRoom(tenantId: string, roomId: string, viewer: ProjectViewer) {
    const row = await this.postcall.meetingByRoom(tenantId, roomId);
    if (!row) return { meetingId: null };
    await this.assertVisible(tenantId, row.id, viewer);
    return { meetingId: row.id };
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
    /** Задача, из которой звонили: итог ляжет и в её обсуждение. */
    taskId?: string | null;
    tracks: { userId: string; displayName: string; buffer: Buffer; fileName: string; offsetSec: number }[];
    /** Все, кто побывал на созвоне (ТЗ-22): итоги показывают и молчавших. */
    attendees?: { userId: string; name: string }[];
    /** Сколько шёл созвон — честнее, чем конец последней реплики. */
    durationSec?: number;
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
      await this.repo.setRoom(meeting.id, input.roomId).catch(() => undefined);
      const event = await this.repo.eventByRoom(input.tenantId, input.roomId).catch(() => null);
      if (event) await this.repo.linkEvent(meeting.id, event.id).catch(() => undefined);
    }
    if (input.durationSec) await this.repo.setDuration(meeting.id, input.durationSec).catch(() => undefined);

    // Итоги встречи (ТЗ-22): разбор заводится сразу, экран после звонка уже ждёт его.
    // Без распознавания речи итогов не собрать — короткий экран: запись, участники, время.
    const ai = await this.ai.canTranscribe(input.tenantId).catch(() => false);
    const attendees = input.attendees?.length
      ? input.attendees
      : input.tracks.map((t) => ({ userId: t.userId, name: t.displayName }));
    await this.postcall.start({ tenantId: input.tenantId, meetingId: meeting.id, startedBy: input.actorId, ai, attendees });

    void (async () => {
      try {
        if (!ai) {
          await this.saveCallRecording(input, meeting.id);
          await this.repo.setStatus(meeting.id, 'recorded');
          await this.postcall.mark(input.tenantId, meeting.id, {
            transcript: 'skipped', summary: 'skipped', decisions: 'skipped', tasks: 'skipped', followup: 'skipped',
          });
          return;
        }
        await this.repo.setStatus(meeting.id, 'transcribing');
        await this.postcall.mark(input.tenantId, meeting.id, { transcript: 'running' });
        const replies: (Reply & { speakerUserId: string | null })[] = [];
        // Словарь встречи нужен и здесь: записи созвонов идут этим путём,
        // а не тем, куда попадают загруженные вручную файлы.
        const hint = await this.speechHint(input.tenantId);
        // запись сохраняется параллельно с расшифровкой: сведение ffmpeg не задерживает итоги
        const saved = this.saveCallRecording(input, meeting.id);

        // Дорожки расшифровываются параллельно (ТЗ-22): итоги после звонка ждут самую
        // длинную дорожку, а не сумму всех. Не больше трёх разом — у Whisper свои пределы.
        await inPool(input.tracks, TRANSCRIBE_PARALLEL, async (track) => {
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
        });

        await saved;
        if (!replies.length) {
          await this.repo.setStatus(meeting.id, 'error', 'Речь не распознана — проверьте ключ OpenAI');
          await this.postcall.failRest(input.tenantId, meeting.id);
          return;
        }

        // дорожки писались параллельно: сводим в одну ленту по времени, иначе диалог не читается
        replies.sort((a, b) => a.start - b.start);
        await this.repo.replaceSegments(input.tenantId, meeting.id, replies);
        if (!input.durationSec) await this.repo.setDuration(meeting.id, Math.round(replies[replies.length - 1].end));
        await this.postcall.mark(input.tenantId, meeting.id, { transcript: 'ready' });

        await this.repo.setStatus(meeting.id, 'analyzing');
        await this.postcall.mark(input.tenantId, meeting.id, { summary: 'running', decisions: 'running', tasks: 'running' });
        await this.analyze(input.tenantId, meeting.id, input.projectId, replies);
        await this.repo.setStatus(meeting.id, 'done');
        // письмо клиенту готовит навык секретаря (ТЗ-21) — подписчиком ниже, сразу после разбора
        await this.postcall.mark(input.tenantId, meeting.id, { summary: 'ready', decisions: 'ready', tasks: 'ready', followup: 'running' });
        this.knowledge.enqueue(input.tenantId, 'meeting', meeting.id);
        // Итог возвращается в тот разговор, из которого созвон начали: иначе половина
        // договорённостей не доходит до тех, кто в созвоне не был.
        await this.postCardToChat(input.tenantId, meeting.id, input.chatId ?? null)
          .catch((e) => this.log.warn(`карточка мита в чат не ушла: ${(e as Error).message}`));
        // Созвон начали из задачи — итог возвращается в её обсуждение тем же путём,
        // что и в чат: разговор по задаче есть работа по ней, а не отдельное событие.
        await this.postCardToTask(input.tenantId, meeting.id, input.taskId ?? null, input.actorId)
          .catch((e) => this.log.warn(`итог созвона в задачу не ушёл: ${(e as Error).message}`));
        /*
          Разбор готов — рассказываем тем, кто его ждал.

          Подписка, а не прямой вызов: службе заботы нужен итог созвона, но встречи
          не должны знать о её существовании. Через прямой вызов вышло бы кольцо
          зависимостей (поддержка → агент → помощник → встречи → поддержка), а
          кольца в модулях всегда заканчиваются загадочными отказами при старте.
        */
        const summary = (await this.repo.summary(input.tenantId, meeting.id))?.summary ?? null;
        for (const sink of this.sinks) {
          await sink({ tenantId: input.tenantId, meetingId: meeting.id, roomId: input.roomId ?? '', summary })
            .catch((e) => this.log.warn(`подписчик разбора созвона: ${(e as Error).message}`));
        }
        // письма клиенту не случилось (клиента нет, навык выключен, сбой) — блок не ждёт вечно
        await this.postcall.settleFollowup(input.tenantId, meeting.id);
      } catch (e) {
        this.log.warn(`созвон ${meeting.id}: ${(e as Error).message}`);
        await this.repo.setStatus(meeting.id, 'error', describeFfmpegError(e)).catch(() => undefined);
        await this.postcall.failRest(input.tenantId, meeting.id).catch(() => undefined);
      }
    })();

    return meeting.id;
  }

  /**
   * Сохранить запись созвона: дорожки по людям — на случай спора «я такого не говорил»,
   * и одну сведённую на всех (ТЗ-21) — для проигрывателя и перехода к секунде.
   *
   * Владелец файлов — сотрудник: files.uploaded_by ссылается на users(id), а дорожка
   * вполне может принадлежать гостю. Некому владеть — записи не храним, но стенограмму
   * всё равно делаем: она ценнее исходных файлов. Ошибки не роняют разбор.
   */
  private async saveCallRecording(
    input: { tenantId: string; actorId: string | null; tracks: { userId: string; buffer: Buffer; fileName: string; offsetSec: number }[] },
    meetingId: string,
  ): Promise<void> {
    const owner = input.actorId ?? input.tracks.find((t) => !t.userId.startsWith('guest:'))?.userId ?? null;
    if (!owner) {
      this.log.warn(`встреча ${meetingId}: дорожки не сохранены — в комнате не было сотрудника`);
      return;
    }
    for (const track of input.tracks) {
      await this.files.upload({
        tenantId: input.tenantId, userId: owner, buffer: track.buffer,
        fileName: track.fileName, contentType: 'audio/ogg',
        ownerKind: 'meeting_recording', ownerId: meetingId, maxBytes: MAX_RECORDING_BYTES,
      }).catch((e) => this.log.warn(`дорожка ${track.userId} не сохранена: ${(e as Error).message}`));
    }
    await mixTracks(input.tracks)
      .then(async (mixed) => {
        if (!mixed) return;
        const f = await this.files.upload({
          tenantId: input.tenantId, userId: owner, buffer: mixed, fileName: `meeting-${meetingId}.mp3`, contentType: 'audio/mpeg',
          ownerKind: 'meeting_recording', ownerId: meetingId, maxBytes: MAX_RECORDING_BYTES,
        });
        await this.repo.setFile(meetingId, String(f.id));
      })
      .catch((e) => this.log.warn(`встреча ${meetingId}: запись не сведена — ${(e as Error).message}`));
  }

  /** Повторная обработка — после сбоя или когда появился ключ распознавания. */
  async retry(tenantId: string, id: string) {
    const meeting = await this.repo.get(tenantId, id);
    if (!meeting) throw AppException.notFound('Встреча не найдена');
    await this.repo.setStatus(id, 'queued', null);
    await this.postcall.restart(tenantId, id);
    void this.process(tenantId, id);
    return { restarted: true };
  }

  /** Конвейер: стенограмма → разбор → черновики. Ошибки не роняют процесс, а видны в статусе. */
  async process(tenantId: string, meetingId: string): Promise<void> {
    try {
      const meeting = await this.repo.get(tenantId, meetingId);
      if (!meeting?.file_id) return;

      await this.repo.setStatus(meetingId, 'transcribing');
      await this.postcall.mark(tenantId, meetingId, { transcript: 'running' });
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
        await this.postcall.failRest(tenantId, meetingId);
        return;
      }
      await this.repo.replaceSegments(tenantId, meetingId, replies);
      if (meeting.source === 'transcript') {
        await this.repo.setDuration(meetingId, Math.round(replies[replies.length - 1].end));
      }

      await this.runAnalysis(tenantId, meetingId, meeting.project_id, replies);
    } catch (e) {
      this.log.warn(`meeting ${meetingId} failed: ${(e as Error).message}`);
      await this.repo.setStatus(meetingId, 'error', meetingError(e)).catch(() => undefined);
      await this.postcall.failRest(tenantId, meetingId).catch(() => undefined);
    }
  }

  /** Разбор по готовой стенограмме и отметки «готово» — общий для первого прохода и повтора. */
  private async runAnalysis(tenantId: string, meetingId: string, projectId: string | null, replies: Reply[]): Promise<void> {
    await this.postcall.mark(tenantId, meetingId, { transcript: 'ready', summary: 'running', decisions: 'running', tasks: 'running' });
    await this.repo.setStatus(meetingId, 'analyzing');
    await this.analyze(tenantId, meetingId, projectId, replies);

    await this.repo.setStatus(meetingId, 'done');
    await this.postcall.mark(tenantId, meetingId, { summary: 'ready', decisions: 'ready', tasks: 'ready', followup: 'skipped' });
    this.knowledge.enqueue(tenantId, 'meeting', meetingId); // стенограмма → корпоративная память
  }

  /**
   * «Разобрать заново» (13.10): итоги и задачи — по уже готовой стенограмме, без
   * повторного распознавания записи (оно долгое и платное). Нужно, когда разбор не
   * удался (кончились деньги на API) или вышел пустым. Созданные задачи не трогаем —
   * пересобираются только неподтверждённые черновики. Стенограммы нет — полный повтор.
   */
  async reanalyze(tenantId: string, id: string) {
    const meeting = await this.repo.get(tenantId, id);
    if (!meeting) throw AppException.notFound('Встреча не найдена');
    if (['queued', 'transcribing', 'analyzing'].includes(String(meeting.status))) {
      throw AppException.conflict('Встреча ещё обрабатывается — дождитесь окончания');
    }
    const segs = await this.repo.segments(tenantId, id);
    if (!segs.length) return this.retry(tenantId, id);
    const replies: Reply[] = segs.map((s) => ({
      start: Number(s.start_sec), end: Number(s.end_sec ?? s.start_sec), speaker: s.speaker, text: s.text,
    }));
    await this.repo.setStatus(id, 'analyzing', null);
    void this.runAnalysis(tenantId, id, meeting.project_id, replies).catch(async (e) => {
      this.log.warn(`meeting ${id} reanalyze failed: ${(e as Error).message}`);
      await this.repo.setStatus(id, 'error', meetingError(e)).catch(() => undefined);
      await this.postcall.failRest(tenantId, id).catch(() => undefined);
    });
    return { restarted: true, mode: 'analysis' as const };
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

  /**
   * Итог созвона — в обсуждение задачи.
   *
   * Пишем обычным сообщением от того, кто созвон начал: в переписке задачи не должно
   * быть сущностей, которые выглядят иначе и ведут себя иначе. Ссылка на разбор
   * приложена — за подробностями человек идёт в раздел встреч, а факт разговора,
   * длительность и краткий итог остаются в задаче навсегда.
   *
   * Ошибка здесь ничего не роняет: разбор уже сделан и лежит в митах.
   */
  private async postCardToTask(
    tenantId: string, meetingId: string, taskId: string | null, actorId: string | null,
  ): Promise<void> {
    if (!taskId || !actorId) return;
    const [meeting, summary, drafts] = await Promise.all([
      this.repo.get(tenantId, meetingId),
      this.repo.summary(tenantId, meetingId).catch(() => null),
      this.repo.drafts(tenantId, meetingId).catch(() => []),
    ]);
    if (!meeting) return;

    const mins = Math.max(1, Math.round(Number(meeting.duration_sec ?? 0) / 60));
    const lines = [`Созвон по задаче завершён · ${mins} мин`];
    const text = String((summary as { summary?: string } | null)?.summary ?? '').trim();
    if (text) lines.push(text.slice(0, 1500));
    if (drafts.length) lines.push(`Предложено задач по итогам: ${drafts.length}`);
    lines.push(`Расшифровка и разбор: ${this.base()}/chat/meetings#m${meetingId}`);

    await this.taskcard.addComment(tenantId, String(taskId), String(actorId), lines.join('\n'), false);
  }

  private base(): string {
    return (process.env.APP_BASE_URL || 'https://qevo.one').replace(/\/+$/, '');
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
    // Без даты встречи модель не переведёт «до пятницы» в срок — и срок терялся.
    const meeting = await this.repo.get(tenantId, meetingId);
    const when = new Date(meeting?.happened_at ?? Date.now())
      .toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
    const text = repliesToText(replies).slice(0, 120_000); // защита от гигантских встреч
    const transcript = `Дата встречи: ${when}.\n${roster}${boards}\n${text}`;

    /*
      Итоги встречи (ТЗ-22): «Кратко» — отдельным коротким вызовом, параллельно с полным
      разбором. Первый полезный блок появляется на экране за секунды, а не после того,
      как модель разберёт задачи и решения целиком.
    */
    const quick = this.prompts.resolve(tenantId, 'meeting.summary_quick', {}).catch(() => null)
      .then((prompt) => this.ai.generateWithModel(tenantId, prompt?.body ?? SUMMARY_PROMPT, text.slice(0, 60_000), 'meeting_summary_quick', {
        promptVersionId: prompt?.versionId ?? null, model: prompt?.model, params: prompt?.params,
      }))
      .then(async (r) => {
        // ИИ не ответил — заглушку за итоги не выдаём
        if (r.degraded) return null;
        const summary = String(r.text ?? '').trim().slice(0, 4000);
        if (!summary) return null;
        await this.repo.saveSummaryText(tenantId, meetingId, summary);
        await this.postcall.mark(tenantId, meetingId, { summary: 'ready' });
        return summary;
      })
      .catch((e) => { this.log.warn(`встреча ${meetingId}: краткие итоги — ${(e as Error).message}`); return null; });

    const answer = await this.ai.generateWithModel(tenantId, MEETING_PROMPT, transcript, 'meeting_analyze');
    /*
      Ключ есть, а ИИ не ответил (13.10: кончились деньги на API) — это сбой, а не
      «встреча без задач». Раньше заглушка сохранялась как итог, статус был «готово»,
      и повторить разбор было нечем. Теперь — ошибка с понятной причиной и кнопкой.
    */
    if (answer.degraded) { await quick; throw new AiUnavailableError(); }
    const raw = answer.text;
    const parsed = safeJson(raw);
    const { value, errors } = validateMeetingAnalysis(parsed);
    if (errors.length) this.log.warn(`meeting ${meetingId}: разбор с замечаниями — ${errors.join('; ')}`);
    const quickSummary = await quick;
    if (!value) {
      await this.repo.saveSummary(tenantId, meetingId, quickSummary ?? 'ИИ не смог разобрать встречу. Стенограмма доступна целиком.', [], [], []);
      return;
    }

    // Кто произнёс решение или вопрос — по реплике в этой секунде, а не со слов модели:
    // говорящий у своих созвонов известен достоверно, по дорожке участника.
    const sourced = (list: { text: string; sec: number | null }[]) => list.map((d) => ({ ...d, ...speakerAt(replies, d.sec) }));
    await this.repo.saveSummary(
      tenantId, meetingId, quickSummary ?? value.summary, sourced(value.decisions), value.risks, sourced(value.questions),
    );
    // Протокол встречи — самая дорогая ручная работа из всего, что делает ассистент:
    // раньше его писал человек по памяти, если вообще писал.
    void this.secretary.record({
      tenantId, kind: 'meeting_summary',
      summary: `Протокол встречи: ${value.decisions.length} договорённостей, ${value.tasks.length} задач`,
      subjectType: 'meeting', subjectId: meetingId,
    });

    /*
      ТЗ-31, §26: у встречи нет проекта и вслух его не назвали — определитель по каждой
      задаче (участники, клиент, недавнее) от имени того, кто загрузил запись. Только
      уверенный (HIGH): иначе черновик ждёт выбора — «4 готовы, 1 требует проекта».
    */
    /*
      Повторный разбор («Разобрать заново»): задачи, уже созданные или отклонённые по
      этой встрече, второй раз не предлагаем — иначе автосоздание завело бы дубли.
    */
    const norm = (t: string) => t.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
    const decided = new Set((await this.repo.drafts(tenantId, meetingId).catch(() => []))
      .filter((d) => d.status !== 'pending').map((d) => norm(String(d.title ?? ''))));
    if (decided.size) value.tasks = value.tasks.filter((t) => !decided.has(norm(t.title)));

    const resolvedFor = new Map<number, string>();
    if (!projectId && meeting?.created_by) {
      await Promise.all(value.tasks.map(async (t, i) => {
        if (matchNamed(projects, t.projectHint)) return;
        const r = await this.projectResolver.resolveAs(tenantId, String(meeting.created_by), {
          text: [t.title, t.projectHint, t.quote].filter(Boolean).join(' '),
          peopleIds: [matchTeamMember(team, t.assigneeHint), matchTeamMember(team, t.authorHint)],
        }).catch(() => null);
        if (r?.level === 'HIGH' && r.projectId) resolvedFor.set(i, r.projectId);
      }));
    }

    await this.repo.replaceDrafts(tenantId, meetingId, value.tasks.map((t, i) => {
      // Названный вслух проект важнее выбранного при загрузке записи: на встрече
      // говорят о деле, а поле в форме часто оставляют пустым.
      const project = matchNamed(projects, t.projectHint);
      const column = project ? matchNamed(project.columns ?? [], t.columnHint) : null;
      const assigneeId = matchTeamMember(team, t.assigneeHint);
      const at = speakerAt(replies, t.sec, t.quote);
      return {
        title: t.title,
        description: t.description,
        assigneeId,
        assigneeHint: t.assigneeHint,
        projectId: project?.id ?? projectId ?? resolvedFor.get(i) ?? null,
        projectHint: t.projectHint,
        columnId: column?.id ?? null,
        columnHint: t.columnHint,
        // Постановщик — тот, кто поручил на встрече, а не тот, кто нажмёт «создать».
        authorId: matchTeamMember(team, t.authorHint),
        authorHint: t.authorHint,
        deadlineAt: t.deadline,
        quote: t.quote,
        sourceSec: at.sec,
        sourceSpeaker: at.speaker,
        confidence: draftConfidence(!!assigneeId, t.confidence),
        priority: t.urgent ? 'urgent' : null,
      };
    }));

    await this.afterMeeting(tenantId, meetingId, quickSummary ?? value.summary, value.decisions.length);
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
  async applyDraft(tenantId: string, actorId: string, draftId: string, patch?: DraftPatch, opts: { deferCut?: boolean } = {}) {
    const draft = await this.repo.draft(tenantId, draftId);
    if (!draft) throw AppException.notFound('Черновик не найден');
    if (draft.status !== 'pending' && draft.status !== 'failed') throw AppException.conflict('Черновик уже обработан');
    if (patch) await this.repo.markEdited(draftId, editedFields(draft, patch));

    const projectId = patch?.projectId ?? draft.project_id;

    // Колонка — только если она принадлежит выбранному проекту: проект могли
    // сменить руками, и колонка из другого проекта сломала бы доску.
    const columnId = draft.column_id && String(projectId) === String(draft.project_id)
      ? draft.column_id : undefined;

    if (!(await this.repo.claimDraft(draftId))) throw AppException.conflict('Черновик уже обработан');
    let task: Awaited<ReturnType<TasksService['create']>>;
    try {
      // без проекта задаче некуда лечь — черновик остаётся с причиной, а не молча «ждёт»
      if (!projectId) throw AppException.validation('Выберите проект для задачи');
      task = await this.tasks.create(tenantId, {
        projectId,
        columnId,
        title: (patch?.title ?? draft.title).slice(0, 255),
        description: patch?.description ?? draft.description ?? undefined,
        assigneeId: (patch?.assigneeId ?? draft.assignee_id) ?? undefined,
        // Постановщик — тот, кто поручил на встрече. Нажавший «создать» лишь
        // подтвердил чужое поручение, и приписывать его себе неправильно.
        managerId: draft.author_id ?? undefined,
        // срок, названный на встрече, раньше терялся здесь
        deadlineAt: patch?.deadlineAt !== undefined
          ? (patch.deadlineAt || undefined)
          : (draft.deadline_at ? new Date(draft.deadline_at).toISOString() : undefined),
        priority: (patch?.priority !== undefined ? patch.priority : draft.priority) || undefined,
      } as any, actorId);
    } catch (e) {
      await this.repo.failDraft(draftId, e instanceof AppException ? e.message : 'Не удалось создать задачу');
      throw e;
    }

    await this.repo.markDraftApplied(draftId, task.id);
    await this.afterDraftApplied(tenantId, actorId, draft, String(task.id), String(projectId), patch?.audio, opts.deferCut === true)
      .catch((e) => this.log.warn(`черновик ${draftId}: источник задачи — ${(e as Error).message}`));
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
  async updateDraft(tenantId: string, draftId: string, patch: DraftPatch) {
    const draft = await this.repo.draft(tenantId, draftId);
    if (!draft) throw AppException.notFound('Черновик не найден');
    if (draft.status !== 'pending' && draft.status !== 'failed') throw AppException.conflict('Черновик уже обработан');
    if (patch.title !== undefined && !String(patch.title).trim()) {
      throw AppException.validation('Название задачи не может быть пустым');
    }
    await this.repo.markEdited(draftId, editedFields(draft, patch));
    const updated = await this.repo.updateDraft(tenantId, draftId, patch);
    return updated ?? draft;
  }

  /**
   * Задача родилась на созвоне (ТЗ-25): у неё есть источник. Фрагмент записи с
   * поручением (вырезается фоном — задача его не ждёт), запись в истории задачи и
   * обещание из той же реплики привязывается к задаче, а не живёт отдельно (§38).
   */
  private async afterDraftApplied(
    tenantId: string, actorId: string, draft: DraftRow, taskId: string, projectId: string,
    audio: 'allow' | 'none' | undefined, deferCut: boolean,
  ): Promise<void> {
    const sec = draft.source_sec == null ? null : Number(draft.source_sec);
    const meeting = await this.repo.get(tenantId, draft.meeting_id);
    let proof: 'attached' | 'needs_consent' | 'none' = 'none';
    if (sec != null) {
      proof = await this.proofs.attach({
        tenantId, actorId, taskId, meetingId: draft.meeting_id, draftId: String(draft.id), projectId, sourceSec: sec, consent: audio,
      }).catch(() => 'none' as const);
      if (proof === 'attached' && !deferCut) void this.proofs.cutPending(tenantId, draft.meeting_id);
      await this.repo.linkCommitment(tenantId, draft.meeting_id, sec, taskId).catch(() => undefined);
    }
    await this.activity.log(tenantId, taskId, actorId, 'from_meeting', {
      meetingId: String(draft.meeting_id), meetingTitle: meeting?.title ?? 'встреча', sec, audio: proof === 'attached',
    }).catch(() => undefined);
  }

  /**
   * «Создать выбранные задачи» (ТЗ-22, §15–17). Пакет — это сама встреча: у неё есть
   * номер, состав и состояние каждого черновика. Упавший пункт не отменяет остальные
   * и остаётся черновиком с причиной; повтор создаёт только его — созданный черновик
   * второй раз не применяется (занятие черновика атомарно).
   */
  async createBatch(tenantId: string, actorId: string, meetingId: string, items: (DraftPatch & { draftId: string })[], confirmAll = false) {
    const drafts = await this.repo.drafts(tenantId, meetingId);
    const own = new Map(drafts.map((d) => [String(d.id), d]));
    const created: { draftId: string; taskId: string; title: string }[] = [];
    const failed: { draftId: string; error: string }[] = [];
    let skipped = 0;
    for (const it of items.slice(0, 40)) {
      const d = own.get(String(it.draftId));
      if (!d) { failed.push({ draftId: String(it.draftId), error: 'Черновик не из этой встречи' }); continue; }
      if (d.status === 'applied') { skipped++; continue; } // уже создан — повтор пакета дублей не даёт
      const { draftId, ...patch } = it;
      try {
        const task = await this.applyDraft(tenantId, actorId, String(draftId), Object.keys(patch).length ? patch : undefined, { deferCut: true });
        created.push({ draftId: String(draftId), taskId: String(task.id), title: task.title });
      } catch (e) {
        failed.push({ draftId: String(draftId), error: e instanceof AppException ? e.message : 'Не удалось создать задачу' });
      }
    }
    // фрагменты всех задач пакета — одним скачиванием записи, фоном (§49)
    if (created.length) void this.proofs.cutPending(tenantId, meetingId);
    if (confirmAll) await this.postcall.markConfirmAll(tenantId, meetingId).catch(() => undefined);
    return { created, failed, skipped };
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

/** Правка черновика: то, что человек может поменять до создания задачи. */
export interface DraftPatch {
  title?: string; description?: string | null; assigneeId?: string | null; projectId?: string | null;
  deadlineAt?: string | null; priority?: string | null;
  /** фрагмент записи (ТЗ-25): разрешить показать тем, кто встречу не видит, или без аудио */
  audio?: 'allow' | 'none';
}

/** Что из услышанного ИИ человек исправил: название, исполнителя, проект, срок (§52). */
function editedFields(draft: DraftRow, patch: DraftPatch): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => String(a ?? '') === String(b ?? '');
  if (patch.title !== undefined && !same(patch.title?.trim(), draft.title)) out.push('title');
  if (patch.assigneeId !== undefined && !same(patch.assigneeId, draft.assignee_id)) out.push('assignee');
  if (patch.projectId !== undefined && !same(patch.projectId, draft.project_id)) out.push('project');
  if (patch.deadlineAt !== undefined) {
    const was = draft.deadline_at ? new Date(draft.deadline_at).toISOString().slice(0, 10) : '';
    const now = patch.deadlineAt ? new Date(patch.deadlineAt).toISOString().slice(0, 10) : '';
    if (was !== now) out.push('deadline');
  }
  return out;
}

/** Сколько дорожек созвона расшифровывать одновременно. */
const TRANSCRIBE_PARALLEL = 3;

/** Выполнить по элементам не больше `limit` разом; первая ошибка обрывает всё, как и раньше. */
async function inPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** ИИ не ответил, хотя ключ есть: кончились деньги на API, ключ отозван, сбой провайдера. */
class AiUnavailableError extends Error {
  constructor() { super('ИИ не ответил — закончились средства на API или недоступен ключ'); }
}

/** Текст ошибки встречи для экрана: сбой ИИ — отдельно от проблем с записью. */
function meetingError(e: unknown): string {
  if (e instanceof AiUnavailableError) {
    return 'ИИ не ответил при разборе — закончились средства на API или недоступен ключ. Пополните баланс и нажмите «Разобрать заново»: стенограмма сохранена.';
  }
  return describeFfmpegError(e);
}

