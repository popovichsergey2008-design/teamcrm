import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Readable } from 'stream';
import { AppException } from '../../common/http/app-exception';
import { localParts } from '../assistant/ping-rules';
import { tomorrowOf, zonedTime } from '../focus/close-day';
import { FocusDayService, FocusTopItem, Viewer } from '../focus/focus-day.service';
import { FocusService } from '../focus/focus.service';
import { AiService } from '../ai/ai.service';
import { FilesService } from '../files/files.service';
import { PromptsService } from '../prompts/prompts.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from '../tasks/tasks.service';
import { ProjectsRepository } from '../projects/projects.repository';
import { WorkloadGuardService } from '../workload/workload.service';
import { probeBufferSec } from '../meetings/audio.util';
import { BriefPrefs, FocusBriefRepository, SnapshotRow } from './focus-brief.repository';
import {
  acceptPolish, BRIEF_PROMPT_VERSION, BriefFacts, briefText, composeBrief, estimateSpeechSec, factsHash,
  listenLabel, presetFor, speechScript, textHash,
} from './brief-rules';

/** Сколько раз в день можно синтезировать голос заново — повтор после ошибки и «Обновить». */
const MAX_AUDIO = 5;
/** Сколько раз в день — «Обновить брифинг» вручную. */
const MAX_REFRESH = 10;
const POLISH_TIMEOUT_MS = 20_000;

const SYSTEM_FALLBACK = 'Перепиши брифинг живым деловым языком, 3–5 предложений, на «вы». Не меняй факты, числа и названия в «ёлочках». Верни только текст.';
const VOICES = ['alloy', 'nova', 'shimmer', 'echo', 'onyx', 'fable'];

const hhmm = (d: Date, tz: string) => {
  const p = localParts(d, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

/**
 * Персональный ИИ-брифинг «Фокуса дня» (ТЗ-27).
 *
 * Один снимок на человека в день (п. 12–13): факты → текст → голос. Из него же —
 * утренний бриф в ящике секретаря и в Telegram (ТЗ-21), поэтому текст, голос и тройка
 * не спорят. Тройку выбирает движок «Фокуса дня»; брифинг её только объясняет.
 *
 * Порядок (п. 16): факты с правами → тройка движка → текст правилами → (модель
 * шлифует, проверяем) → снимок → голос фоном. Голос не держит экран (п. 31): текст
 * и тройка показываются сразу, «Готовим аудио…» — пока синтез идёт.
 */
@Injectable()
export class FocusBriefService implements OnModuleInit {
  private readonly log = new Logger('FocusBrief');

  constructor(
    private readonly repo: FocusBriefRepository,
    private readonly day: FocusDayService,
    private readonly focus: FocusService,
    private readonly ai: AiService,
    private readonly prompts: PromptsService,
    private readonly files: FilesService,
    private readonly realtime: RealtimeService,
    private readonly tasks: TasksService,
    private readonly projects: ProjectsRepository,
    private readonly workload: WorkloadGuardService,
  ) {}

  onModuleInit(): void {
    this.day.attachBrief((v, ctx) => this.forScreen(v, ctx.planDate));
  }

  // ── экран ──

  /**
   * Брифинг в ответе `GET /focus/today`. Снимка нет — запускаем сборку фоном и отвечаем
   * «собирается»: экран показывает ход сборки и узнаёт о готовности событием.
   */
  async forScreen(v: Viewer, date: string) {
    const prefs = await this.repo.prefs(v.tenantId, v.userId);
    if (!prefs.enabled) return { enabled: false as const };
    const snap = await this.repo.snapshot(v.tenantId, v.userId, date);
    const stale = snap && (snap.status === 'failed' || (snap.status === 'generating' && Date.now() - new Date(snap.updated_at).getTime() > 120_000));
    if (!snap || stale) {
      void this.generate(v).catch((e) => this.log.warn(`брифинг ${v.userId}: ${(e as Error).message}`));
      return { enabled: true as const, status: 'generating' as const };
    }
    if (snap.status !== 'ready') return { enabled: true as const, status: 'generating' as const };
    if (await this.repo.markViewed(snap.id)) await this.repo.event(v.tenantId, v.userId, snap.id, 'viewed').catch(() => undefined);
    // голос включили после сборки — досинтезируем фоном
    if (prefs.audio && snap.audio_status === 'none') void this.audio(v, snap.id).catch(() => undefined);
    return this.present(snap, prefs);
  }

  /** Собрать и дождаться (кнопка «Собрать», первый вход): идущую сборку тоже ждём. */
  async ensureReady(v: Viewer, now = new Date()) {
    const snap = await this.generate(v, { now });
    for (let i = 0; i < 60 && snap && snap.status === 'generating'; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const cur = await this.repo.byId(snap.id);
      if (!cur || cur.status !== 'generating') break;
    }
    return this.view(v, now);
  }

  async view(v: Viewer, now = new Date()) {
    const plan = await this.day.planForBrief(v, now);
    if (!plan) return { enabled: false as const };
    return this.forScreen(v, plan.today);
  }

  private present(s: SnapshotRow, prefs: BriefPrefs) {
    const polished = s.summary_text !== s.rules_text;
    return {
      enabled: true as const,
      status: 'ready' as const,
      id: String(s.id),
      date: s.brief_date,
      text: s.summary_text,
      // предложения со ссылками — только у текста правил; у отшлифованного — общий список
      sentences: polished ? null : s.sentences_json,
      sources: s.source_refs_json,
      actions: s.actions_json,
      polished,
      generatedAt: s.generated_at,
      canRefresh: s.refresh_count < MAX_REFRESH,
      feedback: s.feedback,
      audio: {
        status: prefs.audio ? s.audio_status : 'off',
        durationSec: s.audio_duration_seconds,
        label: listenLabel(s.audio_duration_seconds ?? (s.summary_text ? estimateSpeechSec(s.summary_text) : null)),
        canRetry: s.audio_attempts < MAX_AUDIO,
      },
    };
  }

  // ── сборка ──

  /**
   * Собрать снимок. `refresh` — «Обновить брифинг» (п. 42): пересобирает текст, но
   * тройку не трогает — принятый план меняет только человек. Если факты те же, текст
   * и голос остаются прежними: модель и синтез второй раз не платятся (п. 62).
   */
  async generate(v: Viewer, opts: { refresh?: boolean; now?: Date; withAudio?: 'background' | 'wait' | 'none' } = {}): Promise<SnapshotRow | null> {
    const now = opts.now ?? new Date();
    const plan = await this.day.planForBrief(v, now);
    if (!plan) return null;
    const prefs = await this.repo.prefs(v.tenantId, v.userId);
    if (!prefs.enabled) return null;
    const before = await this.repo.snapshot(v.tenantId, v.userId, plan.today);
    const snap = await this.repo.claim(v.tenantId, v.userId, plan.today, plan.tz, BRIEF_PROMPT_VERSION, !!opts.refresh);
    if (!snap) return before;
    try {
      const facts = await this.collect(v, plan, prefs, now);
      const composed = composeBrief(facts, prefs.length);
      const rules = briefText(composed);
      const version = factsHash(facts, prefs.length);
      let summary = rules;
      let model: string | null = null;
      if (before?.status === 'ready' && before.facts_version === version && before.rules_text === rules) {
        summary = before.summary_text;
        model = before.model;
      } else {
        const p = await this.polish(v, rules).catch(() => null);
        if (p) { summary = p.text; model = p.model; }
      }
      await this.repo.saveReady(snap.id, {
        facts, summary, rules, sentences: composed.sentences, sources: composed.sources, actions: composed.actions,
        mentions: composed.mentions, topIds: plan.top.filter((i) => i.status === 'active' || i.status === 'done').map((i) => i.id),
        model, factsVersion: version, refresh: !!opts.refresh,
      });
      this.realtime.emitToUsers(v.tenantId, [v.userId], opts.refresh ? 'focus.brief.updated' : 'focus.brief.generated', { date: plan.today });
      const mode = opts.withAudio ?? 'background';
      if (mode === 'wait') await this.audio(v, snap.id);
      else if (mode === 'background') void this.audio(v, snap.id).catch(() => undefined);
      return this.repo.byId(snap.id);
    } catch (e) {
      await this.repo.markFailed(snap.id);
      this.realtime.emitToUsers(v.tenantId, [v.userId], 'focus.brief.updated', { date: plan.today });
      throw e;
    }
  }

  /** Модель только переписывает текст правил; не прошла проверку — остаётся текст правил. */
  private async polish(v: Viewer, rules: string): Promise<{ text: string; model: string } | null> {
    if (!(await this.ai.hasModel(v.tenantId))) return null;
    const prompt = await this.prompts.resolve(v.tenantId, 'focus.brief', {}, v.userId);
    const r = await Promise.race([
      this.ai.generateWithModel(v.tenantId, prompt?.body ?? SYSTEM_FALLBACK, rules, 'focus_brief', {
        promptVersionId: prompt?.versionId ?? null, model: prompt?.model, params: prompt?.params,
      }),
      new Promise<null>((res) => setTimeout(() => res(null), POLISH_TIMEOUT_MS).unref?.()),
    ]);
    if (!r) return null;
    const text = r.text.replace(/^["«]|["»]$/g, '').replace(/\s+/g, ' ').trim();
    return acceptPolish(rules, text) ? { text, model: r.model } : null;
  }

  /** Факты — только свои и только то, что человек может открыть сам (п. 54). */
  private async collect(v: Viewer, plan: { tz: string; today: string; dayOff: boolean; top: FocusTopItem[] }, prefs: BriefPrefs, now: Date): Promise<BriefFacts> {
    const { tz, today } = plan;
    const dayStart = zonedTime(today, '00:00', tz);
    const dayEnd = zonedTime(tomorrowOf(dayStart, tz), '00:00', tz);
    const yStart = new Date(dayStart.getTime() - 86_400_000);
    const boss = v.role === 'owner' || v.role === 'manager';
    const preset = presetFor(boss, prefs);
    const top = plan.top
      .filter((i) => (i.status === 'active' || i.status === 'done') && !i.unavailable && i.title)
      .map((i) => ({
        itemId: i.id, rank: i.rank, kind: i.kind, title: i.title!, taskId: i.taskId, projectId: i.projectId,
        projectName: i.projectName, done: i.status === 'done',
        deadlineDate: i.deadlineAt ? localParts(new Date(i.deadlineAt), tz).date : null,
      }));
    const topTaskIds = top.map((i) => i.taskId).filter((x): x is string => !!x);

    const [meetings, postcall, commitments, due, waiting, cal, ann, overloaded, submitted] = await Promise.all([
      this.repo.meetingsYesterday(v.tenantId, v.userId, boss, v.role === 'client', yStart, dayStart),
      this.repo.postcallPending(v.tenantId, v.userId),
      this.repo.commitments(v.tenantId, v.userId, yStart, dayEnd),
      this.repo.dueOutside(v.tenantId, v.userId, dayEnd, topTaskIds),
      this.repo.waiting(v.tenantId, v.userId),
      this.repo.calendar(v.tenantId, v.userId, now, dayStart, dayEnd),
      this.repo.announcements(v.tenantId, v.userId, v.role === 'owner'),
      preset.teamSignals ? this.workload.overloaded(v.tenantId).catch(() => [] as string[]) : Promise.resolve(null),
      this.repo.submittedWaiting(v.tenantId, v.userId),
    ]);

    const label = (type: string, at: Date) => {
      const when = localParts(new Date(at), tz).date === today ? `сегодня ${hhmm(new Date(at), tz)}` : `${hhmm(new Date(at), tz)}, ${new Date(at).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: tz })}`;
      return `${type === 'meeting' ? 'Обещание на встрече' : type === 'chat' ? 'Обещание в чате' : 'Обещание в обсуждении задачи'} · ${when}`;
    };
    return {
      today,
      dayOff: plan.dayOff,
      boss,
      top,
      meetings: meetings.map((m) => ({ id: m.id, title: m.title, at: hhmm(new Date(m.at), tz), decisions: m.decisions.map((d) => d.replace(/\s+/g, ' ').trim().slice(0, 140)) })),
      postcall: postcall.map((p) => ({ meetingId: p.meeting_id, title: p.title })),
      commitments: commitments.map((c) => ({
        id: c.id, action: c.action_text, taskId: c.task_id, projectId: c.project_id,
        sourceLabel: label(c.source_type, c.source_at),
        sourceLink: c.task_id && c.project_id ? `/projects/${c.project_id}/task/${c.task_id}`
          : c.source_type === 'chat' ? `/chat/${c.source_id}` : c.source_type === 'meeting' ? `/meetings/${c.source_id}` : null,
      })),
      submittedWaiting: submitted,
      dueOutside: due.map((d) => ({ taskId: d.id, projectId: d.project_id, title: d.title, overdue: new Date(d.deadline_at).getTime() < dayStart.getTime() })),
      waiting: { proposals: waiting.proposals, approvals: waiting.approvals },
      meetingsToday: cal.count,
      firstMeeting: cal.first ? {
        id: cal.first.id, title: cal.first.title, time: hhmm(new Date(cal.first.starts_at), tz),
        minutesLeft: Math.max(0, Math.round((new Date(cal.first.starts_at).getTime() - now.getTime()) / 60_000)),
      } : null,
      announcements: ann.map((a) => ({ id: a.id, title: (a.title || a.body).replace(/\s+/g, ' ').trim().slice(0, 80) })),
      clients: preset.clients ? { followups: waiting.followups } : null,
      team: overloaded ? { overloaded } : null,
    };
  }

  // ── голос ──

  /**
   * Голос из того же снимка (п. 29–30): текст на экране, приветствие по имени, без
   * кавычек. Тот же текст и голос — тот же файл: повторно не синтезируем (п. 62).
   */
  async audio(v: Viewer, snapshotId: string, force = false): Promise<void> {
    const snap = await this.repo.byId(snapshotId);
    if (!snap || snap.status !== 'ready') return;
    const prefs = await this.repo.prefs(v.tenantId, v.userId);
    if (!prefs.audio) return;
    const name = await this.repo.userName(v.tenantId, v.userId);
    const script = speechScript(name, snap.summary_text, localParts(new Date(), snap.timezone).hour);
    const hash = textHash(`${prefs.voice}|${script}`);
    if (snap.audio_status === 'ready' && snap.audio_text_hash === hash && !force) return;
    if (!(await this.repo.claimAudio(snapshotId, MAX_AUDIO, force || snap.audio_status === 'ready'))) return;
    const done = (status: string) => this.realtime.emitToUsers(v.tenantId, [v.userId], 'focus.brief.audio_ready', { status });
    try {
      const buf = await this.ai.speak(v.tenantId, script, 'focus_brief_voice', prefs.voice);
      if (!buf) {
        // синтеза нет (нет ключа) — это не ошибка: брифинг остаётся текстом
        await this.repo.setAudio(snapshotId, { status: 'off', error: 'Синтез речи не подключён' });
        done('off');
        return;
      }
      const f = await this.files.upload({
        tenantId: v.tenantId, userId: v.userId, buffer: buf, fileName: `focus-brief-${snap.brief_date}.mp3`,
        contentType: 'audio/mpeg', ownerKind: 'assistant_brief',
      });
      const sec = await probeBufferSec(buf, 'brief.mp3').catch(() => estimateSpeechSec(script));
      await this.repo.setAudio(snapshotId, { status: 'ready', fileId: String(f.id), duration: Math.max(1, Math.round(sec)), textHash: hash });
      done('ready');
    } catch (e) {
      await this.repo.setAudio(snapshotId, { status: 'failed', error: (e as Error).message.slice(0, 300) });
      done('failed');
    }
  }

  /** Короткоживущая подписанная ссылка — постоянной публичной нет (п. 59). */
  async audioView(v: Viewer, now = new Date()) {
    const plan = await this.day.planForBrief(v, now);
    const snap = plan ? await this.repo.snapshot(v.tenantId, v.userId, plan.today) : null;
    if (!snap) throw AppException.notFound('Брифинга на сегодня ещё нет');
    const prefs = await this.repo.prefs(v.tenantId, v.userId);
    if (!prefs.audio) return { status: 'off' as const, durationSec: null, playbackUrl: null, expiresAt: null };
    if (snap.audio_status !== 'ready' || !snap.audio_file_id) {
      return { status: snap.audio_status, durationSec: null, playbackUrl: null, expiresAt: null, canRetry: snap.audio_attempts < MAX_AUDIO };
    }
    const signed = this.files.signPlay(v.tenantId, String(snap.audio_file_id), 900);
    return { status: 'ready' as const, durationSec: snap.audio_duration_seconds, playbackUrl: signed.url, expiresAt: signed.expiresAt };
  }

  async regenerateAudio(v: Viewer, now = new Date()) {
    const plan = await this.day.planForBrief(v, now);
    const snap = plan ? await this.repo.snapshot(v.tenantId, v.userId, plan.today) : null;
    if (!snap || snap.status !== 'ready') throw AppException.notFound('Брифинга на сегодня ещё нет');
    if (snap.audio_attempts >= MAX_AUDIO) throw AppException.conflict('Голос на сегодня уже пересобирали много раз — текст брифинга доступен');
    void this.audio(v, snap.id, true).catch(() => undefined);
    return { status: 'pending' as const };
  }

  // ── действия ──

  async refresh(v: Viewer) {
    const plan = await this.day.planForBrief(v);
    const snap = plan ? await this.repo.snapshot(v.tenantId, v.userId, plan.today) : null;
    if (snap && snap.refresh_count >= MAX_REFRESH) throw AppException.conflict('Брифинг сегодня обновляли много раз — попробуйте позже');
    const next = await this.generate(v, { refresh: true });
    if (next) await this.repo.event(v.tenantId, v.userId, next.id, 'refreshed').catch(() => undefined);
    return this.view(v);
  }

  /**
   * «Взять в работу» (п. 24): пункт плана — начат, задача — в колонку «В работе» своего
   * проекта (только вперёд из «к выполнению» и только своя), статус — «работаю над…».
   * Таймер не запускается: это делает «Войти в глубокий фокус».
   */
  async takeToWork(v: Viewer, itemId: string) {
    const { taskId, title } = await this.day.markStarted(v, itemId);
    const board = await this.repo.taskBoard(v.tenantId, taskId);
    let moved: string | null = null;
    if (board && !board.closed && board.assignee_id === String(v.userId)) {
      const target = await this.projects.findColumnByBucket(v.tenantId, board.project_id, 'inprogress');
      if (target && String(target.id) !== board.column_id && Number(target.position) > Number(board.position)) {
        await this.tasks.move(v.tenantId, taskId, { columnId: String(target.id), position: 0 }, v.userId)
          .then(() => { moved = target.name; })
          .catch((e) => this.log.warn(`в работу ${taskId}: ${(e as Error).message}`));
      }
    }
    await this.focus.fromTaskStart(v.tenantId, v.userId, taskId, board?.title ?? title);
    await this.track(v, 'take_work');
    this.realtime.emitToUsers(v.tenantId, [v.userId], 'focus.item.started', { itemId, taskId });
    return { ...(await this.day.today(v)), started: { itemId, taskId, column: moved } };
  }

  async feedback(v: Viewer, value: 1 | -1, reason: string | null) {
    const snap = await this.today(v);
    await this.repo.setFeedback(snap.id, value, value === -1 ? reason : null);
    return { saved: true };
  }

  /** События брифинга для метрик (п. 67): что делают после прочтения. */
  async track(v: Viewer, event: string) {
    const plan = await this.day.planForBrief(v).catch(() => null);
    const snap = plan ? await this.repo.snapshot(v.tenantId, v.userId, plan.today) : null;
    await this.repo.event(v.tenantId, v.userId, snap?.id ?? null, event);
    return { saved: true };
  }

  private async today(v: Viewer) {
    const plan = await this.day.planForBrief(v);
    const snap = plan ? await this.repo.snapshot(v.tenantId, v.userId, plan.today) : null;
    if (!snap) throw AppException.notFound('Брифинга на сегодня ещё нет');
    return snap;
  }

  // ── настройки ──

  async settings(v: Viewer) {
    const p = await this.repo.prefs(v.tenantId, v.userId);
    const boss = v.role === 'owner' || v.role === 'manager';
    const preset = presetFor(boss, p);
    return {
      ...p,
      // что сейчас действует с учётом пресета роли — для переключателей
      effective: preset,
      boss,
      voices: VOICES,
    };
  }

  async saveSettings(v: Viewer, patch: Partial<BriefPrefs>) {
    const cur = await this.repo.prefs(v.tenantId, v.userId);
    const next: BriefPrefs = {
      enabled: patch.enabled ?? cur.enabled,
      generateAt: patch.generateAt && /^([01]\d|2[0-3]):[0-5]\d$/.test(patch.generateAt) ? patch.generateAt : cur.generateAt,
      audio: patch.audio ?? cur.audio,
      voice: patch.voice && VOICES.includes(patch.voice) ? patch.voice : cur.voice,
      length: patch.length === 'short' || patch.length === 'normal' ? patch.length : cur.length,
      teamSignals: patch.teamSignals !== undefined ? patch.teamSignals : cur.teamSignals,
      clients: patch.clients !== undefined ? patch.clients : cur.clients,
    };
    await this.repo.savePrefs(v.tenantId, v.userId, next);
    return this.settings(v);
  }

  async metrics(tenantId: string, days = 14) {
    const m = await this.repo.metrics(tenantId, days);
    const n = (k: string) => Number(m?.[k] ?? 0);
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
    return {
      days,
      briefs: n('briefs'),
      viewRate: pct(n('viewed'), n('briefs')),
      audioPlayRate: pct(n('audio_played'), n('viewed')),
      briefToAction: pct(n('acted'), n('viewed')),
      briefToDeep: pct(n('deep'), n('viewed')),
      polishedShare: pct(n('polished'), n('briefs')),
      thumbsUp: n('thumbs_up'),
      thumbsDown: n('thumbs_down'),
    };
  }

  // ── утро ──

  /** Утренний тик (п. 14): в 08:30 по поясу человека — снимок заранее, с голосом. */
  async morningTick(now = new Date()): Promise<void> {
    const users = await this.repo.activeUsers();
    for (const u of users) {
      const tz = u.tz || 'Europe/Moscow';
      const p = localParts(now, tz);
      const [h, m] = u.generate_at.split(':').map(Number);
      if (p.hour * 60 + p.minute < h * 60 + m) continue;
      if (p.hour >= 12) continue; // проспал тик — соберётся при открытии
      const have = await this.repo.snapshot(u.tenant_id, u.user_id, p.date);
      if (have) continue;
      await this.generate({ tenantId: u.tenant_id, userId: u.user_id, role: u.role }, { now })
        .catch((e) => this.log.warn(`утренний брифинг ${u.user_id}: ${(e as Error).message}`));
    }
  }

  /**
   * Для утреннего брифа секретаря (ТЗ-21): тот же снимок, тот же голос. Ждёт сборку и
   * синтез — сообщение в Telegram уходит уже с голосом. null — брифинг выключен.
   */
  async forMorning(tenantId: string, userId: string, role: string, now = new Date()): Promise<{ text: string; lines: string[]; audio: Buffer | null; audioFileId: string | null; actions: SnapshotRow['actions_json'] } | null> {
    const v = { tenantId, userId, role };
    const plan = await this.day.planForBrief(v, now);
    if (!plan) return null;
    let snap = await this.repo.snapshot(tenantId, userId, plan.today);
    if (!snap || snap.status !== 'ready') snap = await this.generate(v, { now, withAudio: 'wait' });
    else if (snap.audio_status === 'none') { await this.audio(v, snap.id); snap = await this.repo.byId(snap.id); }
    if (!snap || snap.status !== 'ready') return null;
    let audio: Buffer | null = null;
    if (snap.audio_status === 'ready' && snap.audio_file_id) {
      audio = await this.files.getForDownload(tenantId, String(snap.audio_file_id))
        .then(({ stream }) => toBuffer(stream)).catch(() => null);
    }
    const lines = snap.summary_text.split(/(?<=[.!?…])\s+/).filter(Boolean);
    return { text: snap.summary_text, lines, audio, audioFileId: audio ? String(snap.audio_file_id) : null, actions: snap.actions_json };
  }
}

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
