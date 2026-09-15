import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { DbService } from '../../database/db.service';
import { FilesService } from '../files/files.service';
import { detectKind, extractText } from '../knowledge/file-text';
import { TaskActivityRepository } from '../tasks/task-activity.repository';
import { KnowledgeService } from '../knowledge/knowledge.service';
import {
  EvidenceNeed, formatReview, parseNeeds, parseReview, REVIEW_FINAL, REVIEW_SYSTEM, ReviewResult,
} from './task-review.prompt';

/** Сколько последних сообщений отдаём проверяющему: дальше растёт цена, а не качество. */
const RECENT_MESSAGES = 40;
/** Записей истории: по ним видно, что с задачей вообще делали и когда. */
const RECENT_HISTORY = 40;
/**
 * Сколько скриншотов показываем модели.
 *
 * Четыре — компромисс: доказательство выполнения обычно на одном-двух снимках, а
 * каждый следующий заметно дорожает и размывает внимание модели.
 */
const MAX_IMAGES = 4;
/** Крупнее этого картинку не шлём: провайдеры режут запрос, а толку от 4К-снимка не больше. */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** Сколько знаков берём из каждого приложенного документа. */
const DOC_CHARS = 6000;
/** Столько же — но когда документ запросили отдельно: значит, он и есть доказательство. */
const DOC_CHARS_FULL = 20000;
/**
 * Сколько раз проверяющему разрешено дозапросить материалы.
 *
 * Два круга: первый — «дайте переписку целиком», второй — «а теперь вот этот файл».
 * Дальше растёт только счёт за запросы: дозапрос третьего круга ни разу не менял
 * вывод, зато удваивал время ответа.
 */
const MAX_ROUNDS = 2;

/**
 * «Проверить задачу с помощью ИИ».
 *
 * Что здесь происходит: собираем карточку целиком — постановку, чек-лист, всю
 * переписку, список вложений, текст из приложенных документов и сами скриншоты, —
 * и просим модель сверить обещанное с показанным. Отчёт ложится в переписку задачи,
 * как ответ помощника, и виден всем участникам.
 *
 * Проверка идёт КРУГАМИ, а не одним вопросом. Если материалов не хватает, проверяющий
 * возвращает не вердикт, а список того, что ему нужно (вся переписка без сокращений,
 * полный текст конкретного файла, регламент из базы знаний), мы это достаём и
 * спрашиваем снова. Так делает человек, которому дали неполную папку, — и именно
 * этого не хватало: один заход по обрезанной карточке давал «подтверждений нет»
 * там, где подтверждение лежало в письме на двадцать первом сообщении.
 *
 * Границы, которые здесь важнее качества:
 *
 * 1. Это НЕ приёмка. Проверка ничего не закрывает и не двигает: решение о том,
 *    сделана ли работа, остаётся за постановщиком. ИИ только собирает доводы.
 * 2. Честное «не смог» лучше вежливого «молодец». Половина задач проверяется
 *    только руками, и модель обязана это говорить прямо, называя, что посмотреть.
 * 3. Ничего не выдумывать: каждый вывод — со ссылкой на источник в задаче.
 */
/** Как дозапрос выглядит в отчёте: человек должен видеть, за чем ИИ ходил. */
function needLabel(n: EvidenceNeed): string {
  if (n.tool === 'переписка') return 'переписку целиком';
  if (n.tool === 'файл') return `файл «${n.arg}»`;
  return `базу знаний по запросу «${n.arg}»`;
}

@Injectable()
export class TaskReviewService {
  private readonly log = new Logger('TaskReview');

  constructor(
    private readonly db: DbService,
    private readonly ai: AiService,
    private readonly files: FilesService,
    private readonly activity: TaskActivityRepository,
    private readonly knowledge: KnowledgeService,
  ) {}

  async review(tenantId: string, taskId: string, userId: string) {
    const task = await this.db.one<any>(
      `SELECT t.id::text, t.title, t.description, t.priority, t.deadline_at, t.closed_at,
              t.project_id::text AS project_id,
              t.approval_state, c.name AS column_name, p.name AS project_name,
              ua.full_name AS assignee_name, um.full_name AS creator_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
    LEFT JOIN board_columns c ON c.id = t.column_id
    LEFT JOIN users ua ON ua.id = t.assignee_id
    LEFT JOIN users um ON um.id = t.created_by
        WHERE t.tenant_id=$1 AND t.id=$2`,
      [tenantId, taskId],
    );
    if (!task) throw AppException.notFound('Задача не найдена');

    const [checklist, messages, attachments, history, spent] = await Promise.all([
      this.db.many<{ text: string; is_done: boolean }>(
        `SELECT text, is_done FROM task_checklist_items
          WHERE tenant_id=$1 AND task_id=$2 ORDER BY position`,
        [tenantId, taskId],
      ),
      this.db.many<{ author_name: string; body: string; is_ai: boolean; created_at: Date }>(
        `SELECT u.full_name AS author_name, c.body, c.is_ai, c.created_at
           FROM task_comments c JOIN users u ON u.id = c.author_id
          WHERE c.tenant_id=$1 AND c.task_id=$2
          ORDER BY c.created_at DESC LIMIT $3`,
        [tenantId, taskId, RECENT_MESSAGES],
      ),
      this.db.many<{ file_id: string; file_name: string; content_type: string; size_bytes: string }>(
        `SELECT a.file_id, f.file_name, f.content_type, f.size_bytes
           FROM task_attachments a JOIN files f ON f.id = a.file_id
          WHERE a.tenant_id=$1 AND a.task_id=$2
          ORDER BY a.created_at`,
        [tenantId, taskId],
      ),
      /*
        История задачи — след работы, которого не было у проверяющего раньше.

        Из-за этого он судил по одному чек-листу и объявлял «не выполнено» там, где
        задачу переносили по колонкам, прикладывали файлы и обсуждали неделю. Перенос
        в «Тестирование» и приложенный отчёт — доказательства не хуже галочки.
      */
      this.db.many<{ kind: string; detail: unknown; created_at: Date; actor: string | null }>(
        `SELECT a.kind, a.detail, a.created_at, u.full_name AS actor
           FROM task_activity a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.tenant_id=$1 AND a.task_id=$2
          ORDER BY a.created_at DESC LIMIT $3`,
        [tenantId, taskId, RECENT_HISTORY],
      ),
      /** Учтённое время: часы на задачу говорят о работе честнее любых отметок. */
      this.db.one<{ minutes: string | null; people: string | null }>(
        `SELECT ROUND(SUM(EXTRACT(EPOCH FROM (COALESCE(timestamp_end, now()) - timestamp_start)) / 60))::text AS minutes,
                COUNT(DISTINCT user_id)::text AS people
           FROM time_logs WHERE tenant_id=$1 AND task_id=$2`,
        [tenantId, taskId],
      ),
    ]);

    const { images, docs, skipped } = await this.readAttachments(tenantId, attachments);

    const context = {
      задача: {
        номер: task.id,
        название: task.title,
        описание: task.description ?? '',
        проект: task.project_name,
        колонка: task.column_name,
        исполнитель: task.assignee_name,
        постановщик: task.creator_name,
        срок: task.deadline_at,
        закрыта: !!task.closed_at,
        на_согласовании: task.approval_state === 'pending',
      },
      чек_лист: checklist.map((c) => ({ шаг: c.text, отмечен_сделанным: c.is_done })),
      // Переписка в прямом порядке: рассуждать о ходе работы удобнее с начала.
      переписка: [...messages].reverse().map((m) => ({
        кто: m.is_ai ? 'ИИ-помощник' : m.author_name,
        когда: m.created_at,
        текст: String(m.body ?? '').slice(0, 2000),
      })),
      вложения: attachments.map((a) => ({ имя: a.file_name, тип: a.content_type, байт: Number(a.size_bytes) })),
      история_задачи: [...history].reverse().map((h) => ({
        когда: h.created_at, кто: h.actor ?? 'система', что: h.kind, подробности: h.detail ?? null,
      })),
      учтено_времени_минут: Number(spent?.minutes ?? 0),
      людей_списывали_время: Number(spent?.people ?? 0),
      текст_из_документов: docs,
      // Модель должна знать, чего она НЕ видела: иначе решит, что видела всё.
      не_смог_посмотреть: skipped,
      снимков_приложено: images.length,
    };

    let parsed: ReviewResult | null = null;
    const extra: { запрос: string; ответ: unknown }[] = [];
    try {
      for (let round = 0; round <= MAX_ROUNDS && !parsed; round += 1) {
        // На последнем круге просить материалы уже нельзя — нужен вывод.
        const last = round === MAX_ROUNDS;
        const raw = await this.ai.generate(
          tenantId,
          last ? `${REVIEW_SYSTEM}\n\n${REVIEW_FINAL}` : REVIEW_SYSTEM,
          JSON.stringify(extra.length ? { ...context, дополнительно: extra } : context, null, 1),
          'task_review',
          { images, params: { max_tokens: 1800 } },
        );
        const needs = last ? [] : parseNeeds(raw);
        if (needs.length) {
          for (const n of needs) {
            extra.push({ запрос: needLabel(n), ответ: await this.fetchEvidence(tenantId, taskId, task.project_id, attachments, n) });
          }
          continue;
        }
        parsed = parseReview(raw);
      }
    } catch (e) {
      this.log.warn(`проверка задачи ${taskId}: ${(e as Error).message}`);
      throw AppException.conflict('ИИ сейчас недоступен — попробуйте позже');
    }
    if (!parsed) throw AppException.conflict('ИИ ответил непонятно — попробуйте ещё раз');

    const body = formatReview(parsed, {
      messages: messages.length,
      attachments: attachments.length,
      history: history.length,
      minutes: Number(spent?.minutes ?? 0),
      images: images.length,
      extra: extra.map((e) => e.запрос),
    });
    await this.saveAiMessage(tenantId, taskId, userId, body);
    // В историю — факт и вывод: через неделю видно, кто и когда просил проверку.
    await this.activity.log(tenantId, taskId, userId, 'ai_review', { verdict: parsed.verdict });

    return { ...parsed, body };
  }

  /**
   * Достать то, что проверяющий попросил.
   *
   * Каждый запрос выполняется НАШИМ кодом по закрытому списку: модель называет, что
   * ей нужно, но не решает, откуда это брать. Иначе проверка задачи превратилась бы
   * в произвольный доступ к данным арендатора.
   */
  private async fetchEvidence(
    tenantId: string,
    taskId: string,
    projectId: string | null,
    attachments: { file_id: string; file_name: string; content_type: string; size_bytes: string }[],
    need: EvidenceNeed,
  ): Promise<unknown> {
    if (need.tool === 'переписка') {
      const rows = await this.db.many<{ author_name: string; body: string; is_ai: boolean; created_at: Date }>(
        `SELECT u.full_name AS author_name, c.body, c.is_ai, c.created_at
           FROM task_comments c JOIN users u ON u.id = c.author_id
          WHERE c.tenant_id=$1 AND c.task_id=$2
          ORDER BY c.created_at`,
        [tenantId, taskId],
      );
      return rows.map((m) => ({
        кто: m.is_ai ? 'ИИ-помощник' : m.author_name, когда: m.created_at, текст: String(m.body ?? ''),
      }));
    }

    if (need.tool === 'файл') {
      const want = need.arg.toLowerCase();
      const row = attachments.find((a) => a.file_name.toLowerCase() === want)
        ?? attachments.find((a) => a.file_name.toLowerCase().includes(want));
      if (!row) return 'такого вложения в задаче нет';
      if (String(row.content_type ?? '').startsWith('image/')) return 'это снимок — он уже показан выше';
      try {
        const buf = await this.bytes(tenantId, String(row.file_id));
        const text = buf ? (await extractText(buf, row.file_name, row.content_type))?.text?.trim() ?? '' : '';
        return text ? { имя: row.file_name, текст: text.slice(0, DOC_CHARS_FULL) } : 'текст из файла не извлёкся';
      } catch (e) {
        this.log.debug?.(`дозапрос файла ${row.file_name}: ${(e as Error).message}`);
        return 'файл прочитать не удалось';
      }
    }

    try {
      const hits = await this.knowledge.search(tenantId, need.arg, 5, projectId ?? undefined);
      return hits.length
        ? hits.map((h) => ({ откуда: h.title ?? h.sourceType, проект: h.projectName, фрагмент: h.snippet }))
        : 'в базе знаний по этому запросу ничего нет';
    } catch (e) {
      this.log.debug?.(`дозапрос базы знаний «${need.arg}»: ${(e as Error).message}`);
      return 'база знаний сейчас недоступна';
    }
  }

  /**
   * Чтение вложений.
   *
   * Картинки уходят модели как есть — на них и показывают результат. Из документов
   * достаём текст тем же кодом, что и база знаний: заводить второй разбор форматов
   * значит однажды разойтись с ним в мелочах.
   *
   * Всё, что прочитать не удалось (видео, архив, слишком большой файл), возвращаем
   * отдельным списком: модель обязана знать, чего она не видела, иначе решит, что
   * видела всё, и уверенно ошибётся.
   */
  private async readAttachments(
    tenantId: string,
    rows: { file_id: string; file_name: string; content_type: string; size_bytes: string }[],
  ) {
    const images: { mime: string; base64: string }[] = [];
    const docs: { имя: string; текст: string }[] = [];
    const skipped: string[] = [];

    for (const a of rows) {
      const mime = String(a.content_type ?? '');
      const size = Number(a.size_bytes ?? 0);
      const isImage = mime.startsWith('image/');
      if (isImage && images.length >= MAX_IMAGES) { skipped.push(`${a.file_name} (показали только первые ${MAX_IMAGES} снимков)`); continue; }
      if (isImage && size > MAX_IMAGE_BYTES) { skipped.push(`${a.file_name} (снимок слишком большой)`); continue; }
      // detectKind вернул пусто — формат нам незнаком (видео, архив, что угодно).
      if (!isImage && !detectKind(a.file_name, mime)) { skipped.push(`${a.file_name} (${mime || 'неизвестный тип'} — прочитать нечем)`); continue; }

      try {
        const buf = await this.bytes(tenantId, String(a.file_id));
        if (!buf) { skipped.push(`${a.file_name} (не удалось скачать)`); continue; }
        if (isImage) {
          images.push({ mime, base64: buf.toString('base64') });
        } else {
          const text = (await extractText(buf, a.file_name, mime))?.text?.trim() ?? '';
          if (text) docs.push({ имя: a.file_name, текст: text.slice(0, DOC_CHARS) });
          else skipped.push(`${a.file_name} (текст не извлёкся)`);
        }
      } catch (e) {
        skipped.push(`${a.file_name} (ошибка чтения)`);
        this.log.debug?.(`вложение ${a.file_name}: ${(e as Error).message}`);
      }
    }
    return { images, docs, skipped };
  }

  private async bytes(tenantId: string, fileId: string): Promise<Buffer | null> {
    const { stream } = await this.files.getForDownload(tenantId, fileId);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return chunks.length ? Buffer.concat(chunks) : null;
  }

  /** Отчёт в ленте обсуждения — с пометкой ИИ, как и ответы помощника. */
  private async saveAiMessage(tenantId: string, taskId: string, userId: string, body: string): Promise<void> {
    await this.db.query(
      `INSERT INTO task_comments (tenant_id, task_id, author_id, body, is_client_visible, is_ai)
       VALUES ($1,$2,$3,$4,false,true)`,
      [tenantId, taskId, userId, body],
    );
  }
}
