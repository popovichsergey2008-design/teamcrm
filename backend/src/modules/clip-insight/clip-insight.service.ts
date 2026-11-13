import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { maskSecrets } from '../../common/secrets';
import { PRIVACY_PROMPT_RULE } from '../../common/personal-topics';
import { DbService } from '../../database/db.service';
import { AiService } from '../ai/ai.service';
import { ClipHeard, onClipHeard } from '../chats/chat-hooks';
import { ChatsRepository } from '../chats/chats.repository';
import { NlService } from '../nl/nl.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  bugMarks, bugTaskText, Mark, needsSummary, parseInsight, Segment, summaryFallback, timedText,
} from './clip-insight-rules';

type Viewer = { tenantId: string; userId: string; role: string };

/** Кратко и метки — не дольше этого: текст к этому времени уже на экране. */
const MODEL_BUDGET_MS = 12_000;

const VOICE_SYSTEM = 'Ты помощник в рабочем мессенджере. По расшифровке голосового сообщения напиши, о чём оно, '
  + 'в 1–2 короткие строки (до 200 знаков): суть, просьба, срок, если есть. Ответ — JSON {"summary":"…"}. '
  + 'Только то, что сказано, без выдумок. ' + PRIVACY_PROMPT_RULE;

const SCREEN_SYSTEM = 'Ты помогаешь разбирать запись экрана с голосом в рабочем мессенджере. По расшифровке '
  + '(в квадратных скобках — секунда от начала записи) напиши кратко в 1–2 строки, что показано и что не так, '
  + 'и отметь моменты: где видна или названа проблема (label "баг"), где показан важный шаг (label "шаг"). '
  + 'Ответ — JSON {"summary":"…","marks":[{"sec":секунда из скобок,"label":"баг","text":"что именно, до 10 слов"}]}. '
  + 'Не больше 6 меток. Только то, что сказано, без выдумок. ' + PRIVACY_PROMPT_RULE;

export interface InsightView {
  messageId: string;
  kind: 'voice' | 'screen';
  status: 'running' | 'ready' | 'failed';
  summary: string | null;
  summaryBy: 'model' | 'rules' | null;
  segments: Segment[];
  marks: Mark[];
  durationSec: number | null;
  readyMs: number | null;
  bugTaskId: string | null;
}

/**
 * #4902, п. 14. Разбор клипа чата: кратко в 1–2 строки, реплики с метками времени,
 * «0:42 баг» у записи экрана и задача-баг с видео.
 *
 * Сам текст делает чат (ChatsService.clipText — тот же, что был, теперь и у голосовых
 * сразу): он кладёт расшифровку в сообщение и сообщает сюда хуком реплики Whisper.
 * Здесь — только то, что сверху; ошибка разбора отправку и текст не трогает.
 */
@Injectable()
export class ClipInsightService implements OnModuleInit {
  private readonly log = new Logger('ClipInsight');

  constructor(
    private readonly db: DbService,
    private readonly ai: AiService,
    private readonly chats: ChatsRepository,
    private readonly nl: NlService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    onClipHeard((c) => this.digest(c));
  }

  /** Клип распознан: кратко и метки — моделью, если есть, иначе правилами. */
  private async digest(c: ClipHeard): Promise<void> {
    const segments = c.segments.map((s) => ({ start: round2(s.start), end: round2(s.end), text: maskSecrets(s.text) }));
    await this.db.query(
      `INSERT INTO chat_clip_insights (message_id, tenant_id, chat_id, kind, status, segments, duration_sec, ready_ms)
       VALUES ($1, $2, $3, $4, 'running', $5::jsonb, $6, $7)
       ON CONFLICT (message_id) DO UPDATE SET status = 'running', segments = EXCLUDED.segments,
            duration_sec = EXCLUDED.duration_sec, ready_ms = EXCLUDED.ready_ms, updated_at = now()`,
      [c.messageId, c.tenantId, c.chatId, c.kind, JSON.stringify(segments), c.durationSec || null, Math.round(c.sinceUploadMs)],
    );
    let summary: string | null = null;
    let marks: Mark[] = [];
    let by: 'model' | 'rules' = 'rules';
    const wantSummary = c.kind === 'screen' || needsSummary(c.text);
    if (wantSummary && await this.ai.hasModel(c.tenantId).catch(() => false)) {
      const system = c.kind === 'screen' ? SCREEN_SYSTEM : VOICE_SYSTEM;
      const input = c.kind === 'screen' && segments.length ? timedText(segments) : c.text.slice(0, 9000);
      const raw = await within(
        this.ai.generate(c.tenantId, system, input, c.kind === 'screen' ? 'chat_clip_screen' : 'chat_clip_voice', { fast: true, timeoutMs: MODEL_BUDGET_MS }),
        MODEL_BUDGET_MS, '').catch(() => '');
      const parsed = parseInsight(raw, segments);
      if (parsed.summary) { summary = parsed.summary; by = 'model'; }
      marks = parsed.marks;
    }
    if (!summary && wantSummary) summary = summaryFallback(c.text) || null;
    // у записи экрана метки нужны всегда; модель не отметила — правилами
    if (c.kind === 'screen' && !marks.length) marks = bugMarks(segments);
    const row = await this.db.one<{ message_id: string }>(
      `UPDATE chat_clip_insights SET status = 'ready', summary = $2, summary_by = $3, marks = $4::jsonb, updated_at = now()
        WHERE message_id = $1 RETURNING message_id::text`,
      [c.messageId, summary ? maskSecrets(summary) : null, summary ? by : null, JSON.stringify(marks)],
    ).catch(() => null);
    if (!row) return;
    const view = await this.one(c.tenantId, c.messageId);
    if (view) this.realtime.emitToUsers(c.tenantId, c.to, 'chat.clip.insight', { chatId: c.chatId, messageId: c.messageId, insight: view as unknown as Record<string, unknown> });
  }

  private async one(tenantId: string, messageId: string): Promise<InsightView | null> {
    const rows = await this.rows(tenantId, [messageId]);
    return rows[0] ?? null;
  }

  private async rows(tenantId: string, ids: string[], userId?: string): Promise<InsightView[]> {
    if (!ids.length) return [];
    const list = await this.db.many<{
      message_id: string; kind: 'voice' | 'screen'; status: InsightView['status']; summary: string | null; summary_by: InsightView['summaryBy'];
      segments: Segment[]; marks: Mark[]; duration_sec: string | null; ready_ms: number | null; bug_task_id: string | null;
    }>(
      `SELECT i.message_id::text, i.kind, i.status, i.summary, i.summary_by, i.segments, i.marks, i.duration_sec::text, i.ready_ms,
              i.bug_task_id::text
         FROM chat_clip_insights i
         JOIN chats c ON c.id = i.chat_id
        WHERE i.tenant_id = $1 AND i.message_id = ANY($2::bigint[])
          AND ($3::bigint IS NULL OR c.kind = 'project'
               OR EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $3::bigint))`,
      [tenantId, ids, userId ?? null]);
    return list.map((r) => ({
      messageId: r.message_id, kind: r.kind, status: r.status, summary: r.summary, summaryBy: r.summary_by,
      segments: r.segments ?? [], marks: r.marks ?? [], durationSec: r.duration_sec ? Number(r.duration_sec) : null,
      readyMs: r.ready_ms, bugTaskId: r.bug_task_id,
    }));
  }

  /** Разбор клипов по номерам сообщений — пачкой: в ленте их может быть несколько. */
  async list(v: Viewer, ids: string[]) {
    if (v.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    const clean = [...new Set(ids.filter((x) => /^\d{1,19}$/.test(x)))].slice(0, 100);
    const items = await this.rows(v.tenantId, clean, v.userId);
    const speech = await this.ai.canTranscribe(v.tenantId).catch(() => false);
    return { items, speech };
  }

  /** Сообщение с клипом, доступное человеку, — общая проверка для задачи-бага. */
  private async clipMessage(v: Viewer, messageId: string) {
    if (v.role === 'client') throw AppException.forbidden('Чаты команды недоступны');
    const msg = await this.db.one<{ id: string; chat_id: string; file_id: string | null; body: string; transcript: string | null; created_at: Date; author: string | null; chat_kind: string; chat_title: string | null; project_id: string | null }>(
      `SELECT m.id::text, m.chat_id::text, m.file_id::text, m.body, m.transcript, m.created_at, u.full_name AS author,
              c.kind AS chat_kind, c.title AS chat_title, COALESCE(c.project_id, c.linked_project_id)::text AS project_id
         FROM chat_messages m JOIN chats c ON c.id = m.chat_id LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id = $1 AND m.id = $2 AND m.deleted_at IS NULL`, [v.tenantId, messageId]);
    if (!msg || !msg.file_id) throw AppException.notFound('Запись не найдена');
    if (msg.chat_kind !== 'project' && !(await this.chats.isMember(msg.chat_id, v.userId))) {
      throw AppException.forbidden('Вы не участник этого чата');
    }
    return msg;
  }

  /** Черновик задачи-бага: название и описание из расшифровки — человек правит и выбирает проект. */
  async bugDraft(v: Viewer, messageId: string) {
    const msg = await this.clipMessage(v, messageId);
    const ins = await this.one(v.tenantId, messageId);
    const text = maskSecrets(String(msg.transcript ?? (msg.body !== 'Запись экрана' ? msg.body : '') ?? ''));
    const draft = bugTaskText({
      summary: ins?.summary ?? null, marks: ins?.marks ?? [], segments: ins?.segments ?? [], text,
      chatTitle: msg.chat_title, author: msg.author, at: new Date(msg.created_at),
    });
    return { ...draft, projectId: msg.project_id, taskId: ins?.bugTaskId ?? null };
  }

  /**
   * «Создать задачу-баг с видео». Проект обязателен — его выбирает человек (общая
   * проверка ТЗ-31 внутри NlService). Видео не копируется: тот же файл привязывается
   * к задаче, как у задачи из сообщения.
   */
  async createBug(v: Viewer, messageId: string, dto: { projectId: string; title?: string; description?: string; assigneeId?: string }) {
    const msg = await this.clipMessage(v, messageId);
    const draft = await this.bugDraft(v, messageId);
    const res: any = await this.nl.apply(v.tenantId, v.userId, {
      intent: 'create_task',
      task: {
        projectId: String(dto.projectId),
        title: (dto.title?.trim() || draft.title).slice(0, 255),
        description: maskSecrets((dto.description?.trim() || draft.description).slice(0, 9000)),
        assigneeId: dto.assigneeId || undefined,
        priority: 'high',
      },
    }, { interactive: true });
    const created = res?.task;
    if (!created?.id) throw AppException.conflict('Задача не создалась');
    const taskId = String(created.id);
    await this.chats.attachFileToTask(v.tenantId, taskId, String(msg.file_id)).catch(() => undefined);
    const linked = await this.db.one<{ task_id: string | null }>(`SELECT task_id::text FROM chat_messages WHERE id = $1`, [messageId]);
    if (!linked?.task_id) await this.chats.linkTask(v.tenantId, messageId, taskId).catch(() => undefined);
    await this.chats.link({
      tenantId: v.tenantId, chatId: msg.chat_id, entityType: 'task', entityId: taskId, relation: 'created_from', actorId: v.userId,
    }).catch(() => undefined);
    await this.db.query(`UPDATE chat_clip_insights SET bug_task_id = $2, updated_at = now() WHERE message_id = $1`, [messageId, taskId]);
    return { taskId, title: String(created.title ?? draft.title), projectId: String(dto.projectId) };
  }
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const late = new Promise<T>((r) => { t = setTimeout(() => r(fallback), Math.max(0, ms)); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}
