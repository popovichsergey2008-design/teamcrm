import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { FilesService } from '../files/files.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
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
@Injectable()
export class MeetingsService {
  private readonly log = new Logger('Meetings');

  constructor(
    private readonly repo: MeetingsRepository,
    private readonly files: FilesService,
    private readonly ai: AiService,
    private readonly tasks: TasksService,
    private readonly knowledge: KnowledgeService,
  ) {}

  list(tenantId: string) {
    return this.repo.list(tenantId);
  }

  async details(tenantId: string, id: string) {
    const meeting = await this.repo.get(tenantId, id);
    if (!meeting) throw AppException.notFound('Встреча не найдена');
    const [segments, summary, drafts] = await Promise.all([
      this.repo.segments(tenantId, id),
      this.repo.summary(tenantId, id),
      this.repo.drafts(tenantId, id),
    ]);
    return { meeting, segments, summary, drafts };
  }

  /** Загрузка записи или готовых субтитров. Обработку запускаем фоном и сразу отвечаем. */
  async create(
    tenantId: string, actorId: string,
    input: { title: string; projectId?: string | null; happenedAt?: string | null },
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
      fileId: stored.id, createdBy: actorId,
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
    tracks: { userId: string; displayName: string; buffer: Buffer; fileName: string; offsetSec: number }[];
  }): Promise<string | null> {
    if (!input.tracks.length) return null;

    const meeting = await this.repo.create({
      tenantId: input.tenantId, projectId: input.projectId, title: input.title.slice(0, 255),
      happenedAt: new Date().toISOString(), source: 'call', fileId: null, createdBy: input.actorId ?? '',
    });

    void (async () => {
      try {
        await this.repo.setStatus(meeting.id, 'transcribing');
        const replies: (Reply & { speakerUserId: string | null })[] = [];
        // Словарь встречи нужен и здесь: записи созвонов идут этим путём,
        // а не тем, куда попадают загруженные вручную файлы.
        const hint = await this.speechHint(input.tenantId);

        for (const track of input.tracks) {
          // храним дорожки как вложения встречи — на случай спора «я такого не говорил»
          await this.files.upload({
            tenantId: input.tenantId, userId: input.actorId ?? track.userId, buffer: track.buffer,
            fileName: track.fileName, contentType: 'audio/ogg',
            ownerKind: 'meeting_recording', ownerId: meeting.id, maxBytes: MAX_RECORDING_BYTES,
          }).catch((e) => this.log.warn(`дорожка ${track.userId} не сохранена: ${(e as Error).message}`));

          const { chunks } = await extractAudioChunks(track.buffer, track.fileName);
          for (const chunk of chunks) {
            const segments = await this.ai.transcribeSegments(
              input.tenantId, chunk.buffer, chunk.name, chunk.buffer.length / 4000, hint);
            for (const s of shiftSegments(segments, chunk.offsetSec + track.offsetSec)) {
              replies.push({ ...s, speaker: track.displayName, speakerUserId: track.userId });
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
    return task;
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
