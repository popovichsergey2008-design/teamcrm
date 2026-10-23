import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { trackBackground } from '../../common/background-work';
import { ProjectViewer } from '../../common/access/project-visibility';
import { AppException } from '../../common/http/app-exception';
import { AiPlanService } from '../ai-plan/ai-plan.service';
import { AiService } from '../ai/ai.service';
import { FilesService } from '../files/files.service';
import { detectKind, extractText } from '../knowledge/file-text';
import { PushService } from '../notifications/push.service';
import { PromptsService } from '../prompts/prompts.service';
import { RealtimeService } from '../realtime/realtime.service';
import { PdfRenderer } from '../reports/pdf.renderer';
import { renderBeforeAfterHtml } from './before-after.html';
import { CHECK_FALLBACK, CHECK_PROMPT, SPLIT_FALLBACK, SPLIT_PROMPT } from './before-after.prompt';
import { BeforeAfterRepository, CheckTaskRow, ReportRow } from './before-after.repository';
import {
  CheckItem, descriptionImageIds, descriptionText, fingerprint, hasProblems, headline, isImage, ItemSource,
  matchShots, MaterialFile, ModelItem, pageUrls, parseChange, parseCheck, parseSplit, RawItem, remarksText,
  resultMessage, seesImages, settleVerdict, Shot, sideOf, splitItems, summarize,
} from './before-after.rules';
import { PageShooter } from './page-shot';

/** Ключ расхода в «Тариф и ИИ» и в каталоге usage-catalog. */
export const BEFORE_AFTER_FEATURE = 'task_before_after';
/** Снимки страниц — веб-кредиты, как чтение страницы ботом (ТЗ-33). */
export const BEFORE_AFTER_SHOT_FEATURE = 'before_after_shot';

/** Картинок в одном запросе к модели: дальше дорожает, а внимание модели размывается. */
const MAX_IMAGES = 10;
/** Крупнее не шлём: провайдеры режут запрос, а толку от 4К-снимка не больше. */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** В PDF картинка покрупнее допустима, но не бесконечно. */
const PDF_IMAGE_BYTES = 5 * 1024 * 1024;
/** Знаков из каждого документа «стало» (результат агента в .docx). */
const DOC_CHARS = 4000;
/** Ручных запусков в час на человека. */
const PER_USER_HOUR = 20;
/** Отчётов в сутки на компанию — и ручных, и автоматических. */
const PER_TENANT_DAY = 300;
/** Пауза перед автозапуском: файл, приложенный сразу после «Сдать», должен попасть в отчёт. */
const AUTO_DELAY_MS = 45_000;
/** Сколько страниц снимаем сами, если исполнитель ничего не приложил. */
const MAX_PAGE_SHOTS = 2;
/** Задача «сам себе» без единого перехода: граница «до/после» — через столько после создания. */
const SELF_TASK_GRACE_MS = 10 * 60_000;

/** Этапы сдачи: перенос сюда запускает проверку сам (ТЗ-30, типы колонок). */
export const HANDOFF_STAGES = new Set(['review', 'testing', 'approval', 'done']);

interface Collected {
  checklist: { text: string; done: boolean }[];
  description: string | null;
  descText: string;
  before: Shot[];
  after: Shot[];
  sizes: Map<string, number>;
  afterDocs: { fileId: string; name: string; mime: string; size: number }[];
  afterMessages: { id: string; author: string | null; body: string; at: Date }[];
  urls: string[];
  fp: string;
  doers: string[];
}

export interface ReportDto {
  id: string;
  version: number;
  status: ReportRow['status'];
  trigger: ReportRow['trigger'];
  requestedBy: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  mode: ReportRow['mode'];
  model: string | null;
  items: CheckItem[];
  summary: Record<string, unknown>;
  error: string | null;
}

function toDto(r: ReportRow): ReportDto {
  return {
    id: r.id, version: Number(r.version), status: r.status, trigger: r.trigger, requestedBy: r.requested_by_name,
    createdAt: r.created_at, finishedAt: r.finished_at, mode: r.mode, model: r.model,
    items: (r.items ?? []) as CheckItem[], summary: r.summary ?? {}, error: r.error,
  };
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/**
 * Отчёт «было/стало» (#4657).
 *
 * Заказчик: постановщик должен глазами пробежать отчёт и увидеть, внесены ли правки,
 * вместо того чтобы самому открывать сайт и сверять по скриншотам. Поэтому отчёт —
 * не текст в переписке, а пары снимков по пунктам: слева исходный вид с замечаниями,
 * справа результат, и вердикт по каждому пункту.
 *
 * Как устроено:
 * 1. Пункты и привязку снимков считают правила (before-after.rules): чек-лист, список
 *    в описании, автор и время каждого файла. Модель дробит описание, только если
 *    правила пунктов не нашли.
 * 2. Нет снимков «стало», но в задаче есть адрес — снимаем страницу сами Chromium
 *    с защитой от внутренних адресов (тариф «Расширенный», веб-кредит за снимок).
 * 3. Модель компании смотрит пары и говорит по пункту «исправлено / нет / не понять».
 *    Последнее слово — за кодом: без «стало» — «результат не приложен», без модели —
 *    «проверьте глазами». Отчёт строится и без ключа ИИ.
 * 4. Каждый запуск — новая версия; ничего не изменилось — новой не будет.
 */
@Injectable()
export class BeforeAfterService {
  private readonly log = new Logger('BeforeAfter');
  /** Окно частоты на человека: время запусков за последний час. */
  private readonly hits = new Map<string, number[]>();
  /** Отложенные автозапуски: повторная сдача в течение паузы переносит запуск. */
  private readonly timers = new Map<string, { timer: NodeJS.Timeout; done: () => void }>();

  constructor(
    private readonly repo: BeforeAfterRepository,
    private readonly ai: AiService,
    private readonly prompts: PromptsService,
    private readonly files: FilesService,
    private readonly push: PushService,
    private readonly plan: AiPlanService,
    private readonly shooter: PageShooter,
    private readonly pdfRenderer: PdfRenderer,
    private readonly realtime: RealtimeService,
  ) {}

  // ───────────── для экрана ─────────────

  /** Вкладка «Было/стало»: последние версии, текущий отчёт и что можно сделать. */
  async overview(tenantId: string, taskId: string, viewer: ProjectViewer) {
    const task = await this.repo.visibleTask(tenantId, taskId, viewer);
    if (!task) throw AppException.notFound('Задача не найдена');
    const [rows, current, collected] = await Promise.all([
      this.repo.list(tenantId, taskId),
      this.repo.latest(tenantId, taskId),
      this.collect(tenantId, task),
    ]);
    const lastReady = rows.find((r) => r.status === 'ready');
    return {
      task: this.taskMeta(task, viewer),
      versions: rows.map((r) => ({
        id: r.id, version: Number(r.version), status: r.status, trigger: r.trigger,
        createdAt: r.created_at, requestedBy: r.requested_by_name, summary: r.summary ?? {},
      })),
      current: current ? toDto(current) : null,
      /** Материалы поменялись после последней готовой проверки — повод проверить заново. */
      changed: lastReady ? lastReady.fingerprint !== collected.fp : null,
      materials: { before: collected.before.length, after: collected.after.length, messages: collected.afterMessages.length },
    };
  }

  async get(tenantId: string, taskId: string, reportId: string, viewer: ProjectViewer): Promise<ReportDto> {
    const task = await this.repo.visibleTask(tenantId, taskId, viewer);
    if (!task) throw AppException.notFound('Задача не найдена');
    const row = await this.repo.get(tenantId, taskId, reportId);
    if (!row) throw AppException.notFound('Отчёт не найден');
    return toDto(row);
  }

  /**
   * «Проверить было/стало».
   *
   * Отвечает сразу: работа (снимки, модель) идёт фоном, экран опрашивает статус.
   * Идёт проверка — показываем её, а не запускаем вторую; материалы те же, что
   * у последнего готового отчёта, — его же и возвращаем с пометкой unchanged.
   */
  async run(tenantId: string, taskId: string, viewer: ProjectViewer): Promise<{ report: ReportDto; unchanged: boolean }> {
    if (viewer.role === 'client') throw AppException.forbidden('Проверка доступна сотрудникам компании');
    const task = await this.repo.visibleTask(tenantId, taskId, viewer);
    if (!task) throw AppException.notFound('Задача не найдена');

    const latest = await this.repo.latest(tenantId, taskId);
    if (latest?.status === 'running') return { report: toDto(latest), unchanged: false };

    const collected = await this.collect(tenantId, task);
    const ready = await this.repo.latestReady(tenantId, taskId);
    if (ready && ready.fingerprint === collected.fp) {
      const row = await this.repo.get(tenantId, taskId, ready.id);
      if (row) return { report: toDto(row), unchanged: true };
    }

    await this.checkRate(tenantId, String(viewer.userId));
    const id = await this.repo.create(tenantId, taskId, 'manual', String(viewer.userId), collected.fp);
    const row = id ? await this.repo.get(tenantId, taskId, id) : await this.repo.latest(tenantId, taskId);
    if (!row) throw AppException.conflict('Не удалось начать проверку — попробуйте ещё раз');
    if (id) void trackBackground(this.execute(tenantId, task, id, 'manual', String(viewer.userId), collected));
    return { report: toDto(row), unchanged: false };
  }

  /**
   * Автозапуск после сдачи (перенос в проверку/тестирование/согласование/готово).
   *
   * Отложен: агент и люди часто прикладывают файл сразу ПОСЛЕ «Сдать», и отчёт без
   * него был бы отчётом «результат не приложен». Повторная сдача в паузе переносит
   * запуск. Пауза и сама работа — в trackBackground: выкладка их дождётся.
   */
  scheduleAuto(tenantId: string, taskId: string, actorId: string | null): void {
    const key = `${tenantId}:${taskId}`;
    const prev = this.timers.get(key);
    if (prev) { clearTimeout(prev.timer); prev.done(); }
    const delay = Number(process.env.BEFORE_AFTER_AUTO_DELAY_MS ?? AUTO_DELAY_MS);
    void trackBackground(new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(key);
        this.runAuto(tenantId, taskId, actorId)
          .catch((e) => this.log.warn(`автопроверка задачи ${taskId}: ${(e as Error).message}`))
          .finally(resolve);
      }, delay);
      timer.unref?.();
      this.timers.set(key, { timer, done: resolve });
    }));
  }

  /** Сама автопроверка: условия, отпечаток, работа целиком (не фоном — её ждёт scheduleAuto). */
  async runAuto(tenantId: string, taskId: string, actorId: string | null): Promise<string | null> {
    const task = await this.repo.task(tenantId, taskId);
    if (!task) return null;
    // Проверять некому: постановщика нет или задачу сдаёт он сам — смотрит своими глазами.
    if (!task.created_by || (actorId && String(actorId) === String(task.created_by))) return null;
    const collected = await this.collect(tenantId, task);
    // «Было/стало» — про снимки: задача без единой картинки проверяется кнопкой, а не сама.
    if (!collected.before.length && !collected.after.length) return null;

    const latest = await this.repo.latest(tenantId, taskId);
    if (latest?.status === 'running') return null;
    const ready = await this.repo.latestReady(tenantId, taskId);
    if (ready && ready.fingerprint === collected.fp) return null;
    if ((await this.repo.countToday(tenantId)) >= PER_TENANT_DAY) return null;

    const id = await this.repo.create(tenantId, taskId, 'auto', actorId, collected.fp);
    if (!id) return null;
    await this.execute(tenantId, task, id, 'auto', actorId, collected);
    return id;
  }

  /** PDF-версия отчёта: те же пункты и снимки, картинки внутри файла — печать идёт без сети. */
  async pdf(tenantId: string, taskId: string, reportId: string, viewer: ProjectViewer) {
    const task = await this.repo.visibleTask(tenantId, taskId, viewer);
    if (!task) throw AppException.notFound('Задача не найдена');
    const row = await this.repo.get(tenantId, taskId, reportId);
    if (!row || row.status !== 'ready') throw AppException.notFound('Готовый отчёт не найден');
    const report = toDto(row);
    const ids = new Set<string>();
    const loose = (report.summary.loose ?? {}) as { before?: Shot[]; after?: Shot[] };
    for (const it of report.items) for (const s of [...it.before, ...it.after]) ids.add(s.fileId);
    for (const s of [...(loose.before ?? []), ...(loose.after ?? [])]) ids.add(s.fileId);
    const images = new Map<string, string>();
    let total = 0;
    for (const id of ids) {
      if (total > 40 * 1024 * 1024) break;
      const got = await this.bytes(tenantId, id, PDF_IMAGE_BYTES).catch(() => null);
      if (!got || !isImage(got.mime)) continue;
      total += got.buf.length;
      images.set(id, `data:${got.mime};base64,${got.buf.toString('base64')}`);
    }
    const html = renderBeforeAfterHtml({ title: task.title, taskId: task.id, report, images });
    const footer = `<div style="font-family:Inter,'DejaVu Sans',sans-serif;font-size:7px;width:100%;padding:0 12mm;color:#94a3b8;display:flex;justify-content:space-between">
      <span>Было/стало · задача #${task.id} · версия ${report.version}</span>
      <span>стр. <span class="pageNumber"></span> из <span class="totalPages"></span></span></div>`;
    const buffer = await this.pdfRenderer.render(html, footer);
    return {
      buffer,
      fileName: `Было-стало — задача ${task.id}, версия ${report.version}.pdf`,
      asciiName: `before-after-task-${task.id}-v${report.version}.pdf`,
    };
  }

  // ───────────── сбор материалов ─────────────

  private taskMeta(task: CheckTaskRow, viewer: ProjectViewer) {
    const isCreator = !!task.created_by && String(task.created_by) === String(viewer.userId);
    const pending = task.approval_state === 'pending';
    return {
      id: task.id, title: task.title, projectId: task.project_id,
      approvalPending: pending,
      /** Принять или вернуть может постановщик и владелец — как в самой задаче. */
      canDecide: pending && (isCreator || viewer.role === 'owner'),
      isCreator,
      closed: !!task.closed_at,
    };
  }

  /**
   * Всё, из чего строится отчёт, — и отпечаток этого «всего».
   *
   * Сторона каждого файла — по автору (sideOf): постановщик и прочие — замечания,
   * исполнитель и соисполнители — результат; задача «сам себе» — по времени.
   */
  private async collect(tenantId: string, task: CheckTaskRow): Promise<Collected> {
    const [checklistRows, attachments, comments, doers, agent, firstMove] = await Promise.all([
      this.repo.checklist(tenantId, task.id),
      this.repo.attachments(tenantId, task.id),
      this.repo.comments(tenantId, task.id),
      this.repo.doers(tenantId, task.id, task.assignee_id),
      this.repo.agentOutput(tenantId, task.id),
      this.repo.firstTransition(tenantId, task.id),
    ]);
    const checklist = checklistRows.map((c) => ({ text: String(c.text ?? ''), done: !!c.is_done }));
    const descImages = descriptionImageIds(task.description);
    const people = {
      creatorId: task.created_by,
      doers: new Set(doers),
      boundary: firstMove ?? new Date(new Date(task.created_at).getTime() + SELF_TASK_GRACE_MS),
      agentFiles: new Set(agent.fileIds),
      descriptionFiles: new Set(descImages),
    };

    const before: Shot[] = [];
    const after: Shot[] = [];
    const sizes = new Map<string, number>();
    const afterDocs: Collected['afterDocs'] = [];
    for (const a of attachments) {
      const f: MaterialFile = {
        fileId: String(a.file_id), name: a.file_name, mime: a.content_type, uploadedBy: a.uploaded_by,
        uploaderName: a.author, at: new Date(a.created_at), caption: a.caption,
      };
      const side = sideOf(f, people);
      sizes.set(f.fileId, Number(a.size_bytes) || 0);
      if (isImage(f.mime)) {
        const shot: Shot = {
          fileId: f.fileId, name: f.name, mime: f.mime, by: f.uploaderName, at: iso(f.at),
          origin: people.descriptionFiles.has(f.fileId) ? 'description' : f.caption != null ? 'comment' : 'attachment',
          caption: f.caption ? f.caption.replace(/\s+/g, ' ').trim().slice(0, 300) : null,
        };
        (side === 'before' ? before : after).push(shot);
      } else if (side === 'after' && !/^video\//i.test(f.mime) && detectKind(f.name, f.mime)) {
        // документ исполнителя или агента — его текст и есть результат
        afterDocs.push({ fileId: f.fileId, name: f.name, mime: f.mime, size: Number(a.size_bytes) || 0 });
      }
    }
    // картинки описания — в том порядке, в каком стоят в тексте, а не по времени загрузки
    before.sort((x, y) => {
      const ix = descImages.indexOf(x.fileId);
      const iy = descImages.indexOf(y.fileId);
      if (ix >= 0 && iy >= 0) return ix - iy;
      if (ix >= 0) return -1;
      if (iy >= 0) return 1;
      return 0;
    });

    const agentComments = new Set(agent.commentIds);
    const selfTask = !task.created_by || people.doers.has(String(task.created_by)) || !people.doers.size;
    const afterMessages = comments
      .filter((c) => agentComments.has(c.id) || (selfTask
        ? new Date(c.created_at).getTime() >= people.boundary.getTime()
        : !!c.author_id && people.doers.has(String(c.author_id))))
      .filter((c) => c.body.trim().length > 1)
      .map((c) => ({ id: c.id, author: agentComments.has(c.id) ? 'ИИ-агент' : c.author, body: c.body, at: new Date(c.created_at) }));

    const descText = descriptionText(task.description);
    const urls = pageUrls([descText, ...afterMessages.map((m) => m.body)], this.ownHosts(), MAX_PAGE_SHOTS);
    const fp = fingerprint({
      t: task.title, d: descText, di: descImages,
      c: checklist.map((c) => [c.text, c.done]),
      b: before.map((s) => s.fileId), a: after.map((s) => s.fileId), ad: afterDocs.map((d) => d.fileId),
      m: afterMessages.map((m) => m.id), u: urls,
    });
    return {
      checklist, description: task.description, descText, before, after, sizes, afterDocs, afterMessages, urls, fp, doers,
    };
  }

  /** Свои адреса: ссылка на задачу в QEVO — не сайт, который правили. */
  private ownHosts(): string[] {
    const hosts = ['qevo.one', 'anthill.team'];
    try { hosts.push(new URL(process.env.APP_BASE_URL || 'https://qevo.one').hostname); } catch { /* по умолчанию */ }
    return hosts;
  }

  // ───────────── сама проверка ─────────────

  private async execute(
    tenantId: string, task: CheckTaskRow, reportId: string, trigger: 'manual' | 'auto', actorId: string | null, c: Collected,
  ): Promise<void> {
    try {
      const hasModel = await this.ai.hasModel(tenantId);
      let inputTokens = 0;
      let outputTokens = 0;
      const notes: string[] = [];

      // 1. Пункты
      const rule = splitItems({ checklist: c.checklist, description: c.description });
      let raw: RawItem[] = rule.items;
      let source: ItemSource = rule.source ?? 'whole';
      if (!raw.length && hasModel && c.descText.trim().length > 40) {
        const split = await this.splitByModel(tenantId, task, c.descText, actorId);
        inputTokens += split.input; outputTokens += split.output;
        if (split.items.length) { raw = split.items.map((title) => ({ title })); source = 'ai'; }
      }
      if (!raw.length) {
        raw = [{ title: task.title, detail: c.descText.slice(0, 600) || undefined }];
        source = 'whole';
      }

      // 2. Снимок страницы, если исполнитель ничего не показал
      const pageShots = !c.after.length && c.urls.length
        ? await this.shootPages(tenantId, task, c.urls, actorId, notes)
        : [];
      const afterAll = [...c.after, ...pageShots];

      // 3. Привязка снимков к пунктам
      const b = matchShots(raw, c.before);
      const a = matchShots(raw, afterAll);
      const items: CheckItem[] = raw.map((r, i) => ({
        n: i + 1, title: r.title, detail: r.detail ?? null, source, done: r.done ?? null,
        change: parseChange(`${r.title} ${r.detail ?? ''}`),
        before: b.byItem[i], after: a.byItem[i], verdict: 'eyes', reason: '',
      }));
      let looseBefore = b.loose;
      let looseAfter = a.loose;

      // 4. Модель сравнивает
      const afterText = await this.afterText(tenantId, c);
      let modelItems = new Map<number, ModelItem>();
      let modelAnswered = false;
      let modelSees = false;
      let model: string | null = null;
      let modelSummary = '';
      if (hasModel) {
        const res = await this.askModel(tenantId, task, items, looseBefore, looseAfter, afterText, c, actorId);
        inputTokens += res.input; outputTokens += res.output;
        model = res.model;
        if (res.parsed) {
          modelAnswered = true;
          modelSees = seesImages(res.model);
          modelSummary = res.parsed.summary;
          modelItems = new Map(res.parsed.items.map((m) => [m.n, m]));
          // модель разложила снимки «без привязки» — переносим их к пунктам
          const take = (loose: Shot[], nums: number[], side: 'before' | 'after') => {
            const picked = nums.map((n) => res.shown[n - 1]).filter((s) => s && s.side === side && loose.includes(s.shot)).map((s) => s.shot);
            return { picked, rest: loose.filter((s) => !picked.includes(s)) };
          };
          for (const it of items) {
            const m = modelItems.get(it.n);
            if (!m) continue;
            const pb = take(looseBefore, m.beforeShots, 'before');
            it.before = [...it.before, ...pb.picked]; looseBefore = pb.rest;
            const pa = take(looseAfter, m.afterShots, 'after');
            it.after = [...it.after, ...pa.picked]; looseAfter = pa.rest;
          }
        } else {
          notes.push('ИИ ответил непонятно — пункты отмечены «проверьте глазами».');
        }
      }

      // 5. Вердикты — за кодом
      const hasAfterOther = !!afterText.trim() || looseAfter.length > 0;
      for (const it of items) {
        const m = modelItems.get(it.n) ?? null;
        const v = settleVerdict({
          model: m, hasModel: hasModel && modelAnswered, modelSees,
          hasAfterShots: it.after.length > 0, hasAfterOther,
        });
        it.verdict = v.verdict;
        it.reason = v.reason;
        if (!it.change && m && (m.from || m.to)) it.change = { from: m.from, to: m.to };
      }
      if (!hasModel) notes.push('ИИ не подключён — отчёт собран без проверки: сравните снимки глазами. Подключить: Интеграции → ИИ.');
      else if (modelAnswered && !modelSees && (c.before.length || afterAll.length)) {
        notes.push(`Модель${model ? ` ${model}` : ''} не умеет смотреть снимки — пункты со снимками проверьте глазами.`);
      }

      const s = summarize(items);
      const mode: 'ai' | 'eyes' = hasModel && modelAnswered ? 'ai' : 'eyes';
      await this.repo.finish(tenantId, reportId, {
        items,
        summary: {
          ...s, headline: headline(s), message: resultMessage(s, mode), itemsSource: source,
          loose: { before: looseBefore, after: looseAfter }, notes, modelSummary,
          afterMessages: c.afterMessages.length, afterDocs: c.afterDocs.map((d) => d.name),
        },
        mode, model, inputTokens, outputTokens,
      });
      this.realtime.emitScoped(tenantId, task.project_id, 'task.before_after', { taskId: task.id, reportId, status: 'ready' }, false);
      if (trigger === 'auto') await this.notify(tenantId, task, actorId, s, mode, items, c.doers);
    } catch (e) {
      this.log.warn(`отчёт «было/стало» по задаче ${task.id}: ${(e as Error).message}`);
      await this.repo.fail(tenantId, reportId, 'Проверка не удалась — попробуйте ещё раз').catch(() => undefined);
      this.realtime.emitScoped(tenantId, task.project_id, 'task.before_after', { taskId: task.id, reportId, status: 'failed' }, false);
    }
  }

  /** Описание без чек-листа и списка → пункты моделью. Не вышло — пойдёт одним пунктом. */
  private async splitByModel(tenantId: string, task: CheckTaskRow, descText: string, actorId: string | null) {
    const prompt = await this.prompts.resolve(tenantId, SPLIT_PROMPT, {}, actorId ?? undefined).catch(() => null);
    const system = prompt?.body ?? SPLIT_FALLBACK;
    const user = JSON.stringify({ название: task.title, описание: descText.slice(0, 4000) });
    try {
      const res = await this.ai.generateWithModel(tenantId, system, user, BEFORE_AFTER_FEATURE, {
        promptVersionId: prompt?.versionId ?? null, model: prompt?.model ?? null,
        params: { max_tokens: 600, ...(prompt?.params ?? {}) },
      });
      return { items: res.degraded ? [] : parseSplit(res.text), input: Math.ceil((system.length + user.length) / 4), output: Math.ceil(res.text.length / 4) };
    } catch (e) {
      this.log.warn(`пункты задачи ${task.id}: ${(e as Error).message}`);
      return { items: [] as string[], input: 0, output: 0 };
    }
  }

  /** Отчёт исполнителя словами: его сообщения и текст документов «стало». */
  private async afterText(tenantId: string, c: Collected): Promise<string> {
    const parts: string[] = c.afterMessages.slice(-15).map((m) => `${m.author ?? '—'}: ${m.body.replace(/\s+/g, ' ').slice(0, 600)}`);
    for (const d of c.afterDocs.slice(-3)) {
      if (d.size > 15 * 1024 * 1024) continue;
      try {
        const got = await this.bytes(tenantId, d.fileId, 15 * 1024 * 1024);
        const text = got ? (await extractText(got.buf, d.name, d.mime))?.text?.trim() ?? '' : '';
        if (text) parts.push(`Документ «${d.name}»: ${text.replace(/\s+/g, ' ').slice(0, DOC_CHARS)}`);
      } catch (e) {
        this.log.debug?.(`документ ${d.name}: ${(e as Error).message}`);
      }
    }
    return parts.join('\n');
  }

  /**
   * Вопрос модели: пункты, подписанные снимки и отчёт исполнителя.
   *
   * Снимки идут парами по пунктам — сначала «было», потом «стало», — затем без
   * привязки. Каждый подписан тем же номером, что и в запросе: иначе модель не скажет,
   * какой из десяти снимков свежий и к чему он.
   */
  private async askModel(
    tenantId: string, task: CheckTaskRow, items: CheckItem[], looseBefore: Shot[], looseAfter: Shot[],
    afterText: string, c: Collected, actorId: string | null,
  ) {
    const order: { shot: Shot; side: 'before' | 'after'; item: number | null }[] = [];
    const seen = new Set<string>();
    const add = (shot: Shot, side: 'before' | 'after', item: number | null) => {
      if (seen.has(`${side}:${shot.fileId}`)) return;
      seen.add(`${side}:${shot.fileId}`);
      order.push({ shot, side, item });
    };
    for (const it of items) {
      for (const s of it.before) add(s, 'before', it.n);
      for (const s of it.after) add(s, 'after', it.n);
    }
    for (const s of looseBefore) add(s, 'before', null);
    for (const s of looseAfter) add(s, 'after', null);

    const images: { mime: string; base64: string }[] = [];
    const shown: { shot: Shot; side: 'before' | 'after'; item: number | null }[] = [];
    const notShown: string[] = [];
    for (const o of order) {
      if (images.length >= MAX_IMAGES) { notShown.push(`${o.shot.name} (лишний — показали ${MAX_IMAGES})`); continue; }
      if ((c.sizes.get(o.shot.fileId) ?? 0) > MAX_IMAGE_BYTES) { notShown.push(`${o.shot.name} (слишком большой)`); continue; }
      const got = await this.bytes(tenantId, o.shot.fileId, MAX_IMAGE_BYTES).catch(() => null);
      if (!got) { notShown.push(`${o.shot.name} (не удалось скачать)`); continue; }
      images.push({ mime: got.mime, base64: got.buf.toString('base64') });
      shown.push(o);
    }

    const payload = {
      задача: { название: task.title, описание: c.descText.slice(0, 2500) },
      items: items.map((it) => ({
        n: it.n, title: it.title, detail: it.detail, checklist_done: it.done,
        change_from_text: it.change,
        before_shots: shown.map((s, i) => (s.side === 'before' && s.item === it.n ? i + 1 : 0)).filter(Boolean),
        after_shots: shown.map((s, i) => (s.side === 'after' && s.item === it.n ? i + 1 : 0)).filter(Boolean),
      })),
      shots: shown.map((s, i) => ({
        номер: i + 1, side: s.side, item: s.item, имя: s.shot.name, кто: s.shot.by ?? '—', когда: s.shot.at,
        подпись: s.shot.caption ?? null, страница: s.shot.url ?? null,
      })),
      after_text: afterText.slice(0, 9000) || null,
      // модель должна знать, чего она НЕ видела: иначе решит, что видела всё
      не_показано: notShown,
    };
    const prompt = await this.prompts.resolve(tenantId, CHECK_PROMPT, {}, actorId ?? undefined).catch(() => null);
    const system = prompt?.body ?? CHECK_FALLBACK;
    const user = JSON.stringify(payload, null, 1);
    try {
      const res = await this.ai.generateWithModel(tenantId, system, user, BEFORE_AFTER_FEATURE, {
        images, promptVersionId: prompt?.versionId ?? null, model: prompt?.model ?? null,
        params: { max_tokens: 2500, ...(prompt?.params ?? {}) },
      });
      return {
        parsed: res.degraded ? null : parseCheck(res.text, items.length),
        model: res.model, shown,
        input: Math.ceil((system.length + user.length) / 4), output: Math.ceil(res.text.length / 4),
      };
    } catch (e) {
      this.log.warn(`проверка «было/стало» задачи ${task.id}: ${(e as Error).message}`);
      return { parsed: null, model: null, shown, input: 0, output: 0 };
    }
  }

  /**
   * Снимки страниц из задачи — «стало», когда исполнитель ничего не приложил.
   *
   * Тариф — как у чтения страницы ботом: только «Расширенный», по веб-кредиту за
   * снимок. Не вышло — честная строка в отчёте, а не пустота без объяснений.
   */
  private async shootPages(tenantId: string, task: CheckTaskRow, urls: string[], actorId: string | null, notes: string[]): Promise<Shot[]> {
    if (!(await this.plan.can(tenantId, 'ai.web_fetch').catch(() => false))) {
      notes.push('Снимок страницы не сделан: открывать сайты можно в тарифе «Расширенный».');
      return [];
    }
    const owner = actorId ?? task.created_by;
    if (!owner) return [];
    const out: Shot[] = [];
    for (const url of urls) {
      let reservation: string | null = null;
      try {
        reservation = await this.plan.reserveWeb(tenantId, owner, 1);
      } catch (e) {
        notes.push(`Снимок страницы не сделан: ${(e as Error).message}.`);
        break;
      }
      const got = await this.shooter.shoot(url);
      if ('error' in got) {
        await this.plan.releaseWeb(tenantId, reservation);
        notes.push(`Страницу ${url} снять не удалось: ${got.error}.`);
        continue;
      }
      try {
        const host = new URL(got.finalUrl).hostname;
        const f = await this.files.upload({
          tenantId, userId: owner, buffer: got.jpeg, fileName: `Снимок ${host}.jpg`, contentType: 'image/jpeg',
          // файл задачи — права задачи; во вкладку «Файлы» не кладём: это наш снимок, а не работа исполнителя
          ownerKind: 'task_attachment', ownerId: task.id,
        });
        await this.plan.commitWeb(tenantId, reservation, {
          userId: owner, requestId: randomUUID(), feature: BEFORE_AFTER_SHOT_FEATURE, provider: 'chromium',
          webRequests: 0, pagesFetched: 1, bytes: got.jpeg.length, credits: 1,
        });
        out.push({
          fileId: String(f.id), name: f.file_name, mime: 'image/jpeg', by: 'QEVO', at: new Date().toISOString(),
          origin: 'page', caption: `Снимок страницы ${got.finalUrl}`, url: got.finalUrl,
        });
      } catch (e) {
        await this.plan.releaseWeb(tenantId, reservation);
        notes.push(`Снимок ${url} не сохранился.`);
        this.log.warn(`снимок ${url}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /**
   * Итог автопроверки: сообщение помощника в обсуждение, постановщику — в ящик и
   * push; исполнителю — только когда нашли ошибки, чтобы успел исправить до того,
   * как постановщик посмотрит.
   */
  private async notify(
    tenantId: string, task: CheckTaskRow, actorId: string | null, s: ReturnType<typeof summarize>, mode: 'ai' | 'eyes',
    items: CheckItem[], doers: string[],
  ): Promise<void> {
    const message = resultMessage(s, mode);
    const remarks = remarksText(items);
    const path = `/projects/${task.project_id}/task/${task.id}/check`;
    const author = actorId ?? task.created_by;
    if (author) {
      const body = [message, remarks, 'Отчёт «было/стало» — во вкладке «Было/стало» карточки задачи.'].filter(Boolean).join('\n\n');
      const commentId = await this.repo.aiComment(tenantId, task.id, author, body).catch((e) => {
        this.log.warn(`сообщение в задачу ${task.id}: ${(e as Error).message}`);
        return null;
      });
      if (commentId) this.realtime.emitScoped(tenantId, task.project_id, 'task.comment_added', { taskId: task.id, commentId, authorId: author }, false);
    }
    const title = `Было/стало: ${task.title}`.slice(0, 120);
    if (task.created_by) {
      await this.push.personal({ tenantId, userId: String(task.created_by), eventKey: 'task.before_after', title, body: message, path });
    }
    if (hasProblems(s)) {
      for (const d of doers) {
        if (task.created_by && String(d) === String(task.created_by)) continue;
        await this.push.personal({
          tenantId, userId: String(d), eventKey: 'task.before_after', title,
          body: `${message} Исправьте до того, как постановщик посмотрит.`, path,
        });
      }
    }
  }

  // ───────────── служебное ─────────────

  private async bytes(tenantId: string, fileId: string, max: number): Promise<{ buf: Buffer; mime: string } | null> {
    const { file, stream } = await this.files.getForDownload(tenantId, fileId);
    if (Number(file.size_bytes) > max) { stream.destroy?.(); return null; }
    const chunks: Buffer[] = [];
    for await (const ch of stream) chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch));
    return chunks.length ? { buf: Buffer.concat(chunks), mime: String(file.content_type) } : null;
  }

  /** Лимит частоты: человек — в окне часа, компания — за сутки по таблице отчётов. */
  private async checkRate(tenantId: string, userId: string): Promise<void> {
    const now = Date.now();
    const key = `${tenantId}:${userId}`;
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
    if (recent.length >= PER_USER_HOUR) {
      throw new AppException('RATE_LIMITED', `Слишком часто: не больше ${PER_USER_HOUR} проверок в час. Попробуйте позже.`);
    }
    if ((await this.repo.countToday(tenantId)) >= PER_TENANT_DAY) {
      throw new AppException('RATE_LIMITED', 'Дневной лимит проверок «было/стало» в компании исчерпан. Попробуйте завтра.');
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000) this.hits.clear(); // память не растёт бесконечно
  }
}
