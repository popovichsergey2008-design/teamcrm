import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { DbService } from '../../database/db.service';
import { FilesService } from '../files/files.service';
import { detectKind, extractText } from '../knowledge/file-text';
import { TaskActivityRepository } from '../tasks/task-activity.repository';
import { formatReview, parseReview, REVIEW_SYSTEM, ReviewResult } from './task-review.prompt';

/** Сколько последних сообщений отдаём проверяющему: дальше растёт цена, а не качество. */
const RECENT_MESSAGES = 40;
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

/**
 * «Проверить задачу с помощью ИИ».
 *
 * Что здесь происходит: собираем карточку целиком — постановку, чек-лист, всю
 * переписку, список вложений, текст из приложенных документов и сами скриншоты, —
 * и просим модель сверить обещанное с показанным. Отчёт ложится в переписку задачи,
 * как ответ помощника, и виден всем участникам.
 *
 * Границы, которые здесь важнее качества:
 *
 * 1. Это НЕ приёмка. Проверка ничего не закрывает и не двигает: решение о том,
 *    сделана ли работа, остаётся за постановщиком. ИИ только собирает доводы.
 * 2. Честное «не смог» лучше вежливого «молодец». Половина задач проверяется
 *    только руками, и модель обязана это говорить прямо, называя, что посмотреть.
 * 3. Ничего не выдумывать: каждый вывод — со ссылкой на источник в задаче.
 */
@Injectable()
export class TaskReviewService {
  private readonly log = new Logger('TaskReview');

  constructor(
    private readonly db: DbService,
    private readonly ai: AiService,
    private readonly files: FilesService,
    private readonly activity: TaskActivityRepository,
  ) {}

  async review(tenantId: string, taskId: string, userId: string) {
    const task = await this.db.one<any>(
      `SELECT t.id::text, t.title, t.description, t.priority, t.deadline_at, t.closed_at,
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

    const [checklist, messages, attachments] = await Promise.all([
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
      текст_из_документов: docs,
      // Модель должна знать, чего она НЕ видела: иначе решит, что видела всё.
      не_смог_посмотреть: skipped,
      снимков_приложено: images.length,
    };

    let parsed: ReviewResult | null = null;
    try {
      const raw = await this.ai.generate(
        tenantId, REVIEW_SYSTEM, JSON.stringify(context, null, 1), 'task_review',
        { images, params: { max_tokens: 1800 } },
      );
      parsed = parseReview(raw);
    } catch (e) {
      this.log.warn(`проверка задачи ${taskId}: ${(e as Error).message}`);
      throw AppException.conflict('ИИ сейчас недоступен — попробуйте позже');
    }
    if (!parsed) throw AppException.conflict('ИИ ответил непонятно — попробуйте ещё раз');

    const body = formatReview(parsed);
    await this.saveAiMessage(tenantId, taskId, userId, body);
    // В историю — факт и вывод: через неделю видно, кто и когда просил проверку.
    await this.activity.log(tenantId, taskId, userId, 'ai_review', { verdict: parsed.verdict });

    return { ...parsed, body };
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
