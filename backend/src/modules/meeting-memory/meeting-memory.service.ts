import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { maskSecrets } from '../../common/secrets';
import { neutralizePersonal, PRIVACY_PROMPT_RULE } from '../../common/personal-topics';
import { DbService } from '../../database/db.service';
import { AiService } from '../ai/ai.service';
import {
  bucketOf, countBuckets, CurrentCall, mergeTracks, MeetingCandidate, parseRecap, pickPrevious,
  reasonText, recapFallback, RecapPoint, stamp, transcriptForModel,
} from './meeting-memory-rules';

const run = promisify(execFile);

type Viewer = { tenantId: string; userId: string; role: string };

/** Кусок хвоста дорожки: 5 минут — Whisper отвечает быстро, куски идут параллельно. */
const TAIL_CHUNK_SEC = 300;
/** Пересказ строится не дольше этого: опоздавший ждёт на экране. */
const MODEL_BUDGET_MS = 12_000;
/** Повторное нажатие в течение 20 с отдаёт тот же пересказ — без нового счёта за распознавание. */
const RECAP_CACHE_MS = 20_000;

const RECAP_SYSTEM = 'Ты помогаешь опоздавшему на рабочий созвон. По стенограмме (метки [секунды] от начала записи) '
  + 'перескажи, что уже обсудили, так, чтобы прочитать за 15 секунд. Ответ — JSON '
  + '{"points":[{"sec":число из метки реплики,"speaker":"кто","text":"суть до 12 слов"}]}. '
  + 'Не больше 5 пунктов, по порядку разговора, главное: решения, договорённости, сроки, открытые вопросы. '
  + 'Только то, что прозвучало, без выдумок. sec — метка реплики, где это прозвучало. ' + PRIVACY_PROMPT_RULE;

export interface LiveTrack { userId: string; displayName: string; file: string; offsetSec: number }

export interface SoFarResult {
  status: 'ok' | 'no_recording' | 'no_stt' | 'empty';
  source: 'model' | 'rules' | 'chat' | 'empty';
  points: { sec: number | null; stamp: string | null; at: string; speaker: string | null; text: string }[];
  /** сколько минут записи уже разобрано */
  heardSec: number;
  recordingStartedAt: string | null;
  note: string | null;
}

interface RoomCache {
  startedAt: number;
  tracks: Map<string, { doneSec: number; segs: { start: number; text: string }[] }>;
  busy: Promise<SoFarResult> | null;
  last: { at: number; result: SoFarResult } | null;
}

/**
 * #4902, п. 12. Карточка прошлой встречи в начале звонка и «Кратко до сих пор».
 *
 * Живой стенограммы во время звонка в QEVO нет: запись — дорожка на участника, разбор —
 * после. Поэтому «Кратко» дорасшифровывает хвосты идущих дорожек (только то, что ещё не
 * разобрано этим звонком), сшивает реплики по времени и пересказывает. Записи нет —
 * честно говорим об этом и показываем, что успели написать в чате звонка.
 */
@Injectable()
export class MeetingMemoryService {
  private readonly log = new Logger('MeetingMemory');
  private readonly rooms = new Map<string, RoomCache>();

  constructor(private readonly db: DbService, private readonly ai: AiService) {}

  // ───── карточка прошлой встречи ─────

  async previous(v: Viewer, roomId: string) {
    const t0 = Date.now();
    const call = await this.db.one<{ chat_id: string | null; ids: string[]; started_at: Date }>(
      `SELECT chat_id::text, COALESCE(participant_ids, '{}')::text[] AS ids, started_at
         FROM call_log WHERE tenant_id = $1 AND room_id = $2
        ORDER BY (ended_at IS NULL) DESC, started_at DESC LIMIT 1`, [v.tenantId, roomId.slice(0, 64)]);
    if (!call) return { found: false as const, pending: true };
    const lead = v.role === 'owner' || v.role === 'manager';
    // журнал звонка пишется при входе фоном — вошедший мог опередить его на доли секунды
    if (!call.ids.includes(String(v.userId)) && !lead) return { found: false as const, pending: true };

    const topic = await this.db.one<{ title: string | null }>(
      `SELECT COALESCE(
          (SELECT e.title FROM calendar_events e WHERE e.tenant_id = $1 AND e.meet_room_id = $2 ORDER BY e.id DESC LIMIT 1),
          (SELECT c.title FROM chats c WHERE c.tenant_id = $1 AND c.id = $3::bigint AND c.kind <> 'dm')) AS title`,
      [v.tenantId, roomId.slice(0, 64), call.chat_id]);
    const cur: CurrentCall = {
      roomId, chatId: call.chat_id, topic: topic?.title ?? null,
      participantIds: call.ids.map(String), startedAt: new Date(call.started_at),
    };

    const rows = await this.db.many<{ id: string; room_id: string | null; chat_id: string | null; title: string | null; at: Date; tasks: number; people: string[] }>(
      `SELECT m.id::text, m.room_id, m.chat_id::text, m.title, COALESCE(m.happened_at, m.created_at) AS at,
              (SELECT count(*) FROM meeting_task_drafts d JOIN tasks t ON t.id = d.task_id AND t.deleted_at IS NULL
                WHERE d.tenant_id = m.tenant_id AND d.meeting_id = m.id)::int AS tasks,
              ARRAY(SELECT DISTINCT x FROM (
                  SELECT s.speaker_user_id::text AS x FROM meeting_segments s WHERE s.meeting_id = m.id AND s.speaker_user_id IS NOT NULL
                  UNION SELECT m.created_by::text WHERE m.created_by IS NOT NULL
                  UNION SELECT unnest(cl.participant_ids)::text FROM (
                      SELECT c.participant_ids FROM call_log c
                       WHERE c.tenant_id = m.tenant_id AND m.room_id IS NOT NULL AND c.room_id = m.room_id AND c.started_at <= m.created_at
                       ORDER BY c.started_at DESC LIMIT 1) cl
              ) q WHERE x IS NOT NULL) AS people
         FROM meetings m
        WHERE m.tenant_id = $1 AND m.status = 'done' AND m.created_at < $2
          AND m.created_at > $2::timestamptz - interval '120 days'
        ORDER BY m.created_at DESC LIMIT 80`, [v.tenantId, cur.startedAt]);
    const list: MeetingCandidate[] = rows.map((r) => ({
      id: r.id, roomId: r.room_id, chatId: r.chat_id, title: r.title, participantIds: r.people ?? [], at: new Date(r.at), tasks: Number(r.tasks),
    }));
    const pick = pickPrevious(cur, list);
    if (!pick) return { found: false as const, pending: false, ms: Date.now() - t0 };

    // прошлую встречу видят её участники, участники её чата и руководство — не все подряд
    const m = pick.meeting;
    if (!lead && !m.participantIds.includes(String(v.userId))) {
      const member = m.chatId ? await this.db.one(`SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2`, [m.chatId, v.userId]) : null;
      if (!member) return { found: false as const, pending: false, ms: Date.now() - t0 };
    }

    const tasks = await this.db.many<{ id: string; title: string; stage: string; started: boolean; assignee: string | null }>(
      `SELECT t.id::text, t.title, task_stage(t.column_id, t.approval_state, t.closed_at) AS stage,
              (EXISTS (SELECT 1 FROM time_logs l WHERE l.tenant_id = t.tenant_id AND l.task_id = t.id)
               OR t.column_id IS DISTINCT FROM (SELECT c.id FROM board_columns c WHERE c.project_id = t.project_id ORDER BY c.position LIMIT 1)) AS started,
              u.full_name AS assignee
         FROM meeting_task_drafts d
         JOIN tasks t ON t.id = d.task_id AND t.tenant_id = d.tenant_id AND t.deleted_at IS NULL
    LEFT JOIN users u ON u.id = t.assignee_id
        WHERE d.tenant_id = $1 AND d.meeting_id = $2
        ORDER BY t.id LIMIT 60`, [v.tenantId, m.id]);
    const items = tasks.map((t) => ({
      id: t.id, title: maskSecrets(t.title), assignee: t.assignee, stage: t.stage, bucket: bucketOf(t.stage, !!t.started),
    }));
    return {
      found: true as const,
      meeting: { id: m.id, title: m.title, at: m.at, reason: pick.reasons[0], reasonText: reasonText(pick.reasons) },
      counts: countBuckets(items),
      // в карточке — сначала то, что не двигается: о нём и стоит спросить в начале звонка
      tasks: [...items].sort((a, b) => order(a.bucket) - order(b.bucket)).slice(0, 8),
      ms: Date.now() - t0,
    };
  }

  /**
   * Метка из пересказа после звонка: в какую встречу (разобранную запись) она ведёт.
   * Пока запись не разобрана — встречи ещё нет, отвечаем честно.
   */
  async moment(v: Viewer, roomId: string, sec: number) {
    const m = await this.db.one<{ id: string }>(
      `SELECT m.id::text FROM meetings m WHERE m.tenant_id = $1 AND m.room_id = $2 AND m.status = 'done'
        ORDER BY m.created_at DESC LIMIT 1`, [v.tenantId, roomId.slice(0, 64)]);
    if (!m) return { ready: false, meetingId: null, url: null };
    const t = Math.max(0, Math.floor(Number(sec) || 0));
    return { ready: true, meetingId: m.id, url: `/meetings/${m.id}?t=${t}` };
  }

  // ───── «Кратко до сих пор» ─────

  /** Звонок закончился или запись остановлена — разобранное больше не нужно. */
  forget(roomId: string): void {
    this.rooms.delete(roomId);
  }

  async soFar(i: {
    tenantId: string; roomId: string; userId: string; chatId: string | null; callStartedAt: number;
    recording: { startedAt: number; tracks: LiveTrack[] } | null;
  }): Promise<SoFarResult> {
    if (!i.recording) {
      this.rooms.delete(i.roomId);
      return this.fromChat(i, 'no_recording', 'Запись не ведётся — пересказывать нечего. Включите ИИ, и «Кратко» заработает с этого момента.');
    }
    if (!(await this.ai.canTranscribe(i.tenantId).catch(() => false))) {
      return this.fromChat(i, 'no_stt', 'Расшифровка недоступна: не подключён ИИ для речи.');
    }
    let cache = this.rooms.get(i.roomId);
    if (!cache || cache.startedAt !== i.recording.startedAt) {
      cache = { startedAt: i.recording.startedAt, tracks: new Map(), busy: null, last: null };
      this.rooms.set(i.roomId, cache);
    }
    if (cache.last && Date.now() - cache.last.at < RECAP_CACHE_MS) return cache.last.result;
    // двое опоздавших нажали одновременно — считаем один раз
    if (cache.busy) return cache.busy;
    const c = cache;
    c.busy = this.build(i, c, i.recording).finally(() => { c.busy = null; });
    return c.busy;
  }

  private async build(
    i: { tenantId: string; roomId: string; userId: string },
    cache: RoomCache, rec: { startedAt: number; tracks: LiveTrack[] },
  ): Promise<SoFarResult> {
    const names = rec.tracks.map((t) => t.displayName).join(', ');
    await Promise.all(rec.tracks.map(async (t) => {
      const st = cache.tracks.get(t.file) ?? { doneSec: 0, segs: [] };
      cache.tracks.set(t.file, st);
      try {
        const { chunks, durationSec } = await liveTail(t.file, st.doneSec);
        const parts = await Promise.all(chunks.map(async (ch) => {
          const segs = await this.ai.transcribeSegments(i.tenantId, ch.buffer, 'live.mp3', ch.durationSec, names).catch(() => []);
          return segs.map((s) => ({ start: st.doneSec + ch.offsetSec + s.start, text: s.text }));
        }));
        st.segs.push(...parts.flat());
        st.doneSec += durationSec;
      } catch (e) {
        this.log.warn(`кратко до сих пор ${i.roomId}: дорожка ${t.displayName}: ${(e as Error).message}`);
      }
    }));
    const segments = mergeTracks(rec.tracks.map((t) => ({
      speaker: t.displayName, offsetSec: t.offsetSec, segments: cache.tracks.get(t.file)?.segs ?? [],
    })));
    const heardSec = Math.max(0, ...rec.tracks.map((t) => t.offsetSec + (cache.tracks.get(t.file)?.doneSec ?? 0)));

    let points: RecapPoint[] = [];
    let source: SoFarResult['source'] = 'empty';
    if (segments.length && await this.ai.hasModel(i.tenantId).catch(() => false)) {
      const raw = await within(this.ai.generate(i.tenantId, RECAP_SYSTEM, transcriptForModel(segments), 'meeting_live_recap', { fast: true, timeoutMs: MODEL_BUDGET_MS }), MODEL_BUDGET_MS, '')
        .catch(() => '');
      points = parseRecap(raw, segments);
      if (points.length) source = 'model';
    }
    if (!points.length && segments.length) { points = recapFallback(segments); source = points.length ? 'rules' : 'empty'; }

    const result: SoFarResult = {
      status: points.length ? 'ok' : 'empty',
      source,
      points: points.map((p) => ({
        sec: Math.round(p.sec), stamp: stamp(p.sec), at: new Date(rec.startedAt + p.sec * 1000).toISOString(),
        speaker: p.speaker, text: neutralizePersonal(maskSecrets(p.text)),
      })),
      heardSec: Math.round(heardSec),
      recordingStartedAt: new Date(rec.startedAt).toISOString(),
      note: points.length ? null : 'Пока не прозвучало ничего, что можно пересказать.',
    };
    cache.last = { at: Date.now(), result };
    void this.db.query(
      `INSERT INTO meeting_live_recaps (tenant_id, room_id, requested_by, source, points, recording_started_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [i.tenantId, i.roomId.slice(0, 64), i.userId, source, JSON.stringify(result.points), new Date(rec.startedAt)],
    ).catch(() => undefined);
    return result;
  }

  /** Без записи — последние сообщения чата звонка: это тоже «что уже сказали». */
  private async fromChat(
    i: { tenantId: string; chatId: string | null; callStartedAt: number },
    status: 'no_recording' | 'no_stt', note: string,
  ): Promise<SoFarResult> {
    const rows = i.chatId ? await this.db.many<{ author: string | null; body: string; created_at: Date }>(
      `SELECT u.full_name AS author, m.body, m.created_at FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id = $1 AND m.chat_id = $2 AND m.deleted_at IS NULL AND NOT m.is_ai AND m.created_at >= $3
          AND length(m.body) > 2
        ORDER BY m.created_at DESC LIMIT 5`, [i.tenantId, i.chatId, new Date(i.callStartedAt)]).catch(() => []) : [];
    const points = rows.reverse().map((r) => ({
      sec: null, stamp: null, at: new Date(r.created_at).toISOString(), speaker: r.author,
      text: neutralizePersonal(maskSecrets(r.body.replace(/\s+/g, ' ').slice(0, 140))),
    }));
    return { status, source: points.length ? 'chat' : 'empty', points, heardSec: 0, recordingStartedAt: null, note };
  }
}

function order(b: string): number {
  return b === 'not_started' ? 0 : b === 'in_progress' ? 1 : b === 'review' ? 2 : 3;
}

function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const late = new Promise<T>((r) => { t = setTimeout(() => r(fallback), Math.max(0, ms)); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}

/**
 * Неразобранный хвост идущей дорожки: от `fromSec` до конца написанного — в mp3 16 кГц,
 * кусками по 5 минут. Файл ffmpeg ещё пишет; читаем то, что уже на диске.
 */
async function liveTail(file: string, fromSec: number): Promise<{ chunks: { buffer: Buffer; offsetSec: number; durationSec: number }[]; durationSec: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'live-'));
  try {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      ...(fromSec > 0 ? ['-ss', fromSec.toFixed(2)] : []),
      '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k',
      '-f', 'segment', '-segment_time', String(TAIL_CHUNK_SEC), '-reset_timestamps', '1', join(dir, 'p_%03d.mp3'),
    ], { timeout: 120_000, maxBuffer: 1 << 20 });
    const names = (await readdir(dir)).filter((f) => f.startsWith('p_')).sort();
    const chunks: { buffer: Buffer; offsetSec: number; durationSec: number }[] = [];
    for (const [k, name] of names.entries()) {
      const path = join(dir, name);
      const d = await probeSec(path);
      const buffer = await readFile(path);
      // меньше полутора секунд — обрывок слова, Whisper сочинит на нём фразу; дождётся следующего раза
      if (d >= 1.5 && buffer.length > 2048) chunks.push({ buffer, offsetSec: k * TAIL_CHUNK_SEC, durationSec: d });
    }
    const last = chunks[chunks.length - 1];
    return { chunks, durationSec: last ? last.offsetSec + last.durationSec : 0 };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function probeSec(path: string): Promise<number> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], { timeout: 30_000 });
    const v = Number(String(stdout).trim());
    return Number.isFinite(v) ? v : 0;
  } catch { return 0; }
}
