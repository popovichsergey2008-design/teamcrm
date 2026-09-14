import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { DbService } from '../../database/db.service';
import { extractAudioChunks } from '../meetings/audio.util';

/**
 * Помощник внутри переписки.
 *
 * Три разные задачи, но одно правило, которое важнее всех трёх: **ИИ видит только то,
 * что видит спрашивающий**. Ответ по чужой переписке — не удобство, а утечка, поэтому
 * каждая выборка здесь ограничена чатами человека тем же условием, что и список чатов:
 * он участник — или это чат проекта, доступный всей команде.
 *
 * 1. `@AI` в чате — вопрос по истории этого разговора.
 * 2. Сводка непрочитанного: «47 непрочитанных» — это не ответ на вопрос «что там».
 * 3. Поиск по переписке словами: «где Глеб писал пароль от стенда».
 */
@Injectable()
export class ChatsAiService {
  private readonly log = new Logger('ChatsAi');

  constructor(private readonly db: DbService, private readonly ai: AiService) {}

  /** Чаты, доступные человеку. Одно условие на все три сценария — чтобы не разошлись. */
  private static readonly SCOPE = `(
    c.kind = 'project'
    OR EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = $2)
  )`;

  /**
   * Вопрос помощнику по этому чату.
   *
   * Берём последние сообщения, а не всю историю: дальше растёт цена, а не качество.
   * Ответ возвращаем — сохранением занимается ChatsService, чтобы вся запись в чат
   * шла одним путём.
   */
  async answer(tenantId: string, chatId: string, userId: string, question: string, crm?: Record<string, unknown>): Promise<string> {
    const text = String(question ?? '').trim();
    if (text.length < 2) throw AppException.validation('Слишком короткий вопрос');

    const rows = await this.db.many<{ author_name: string | null; body: string; created_at: Date; is_ai: boolean }>(
      `SELECT u.full_name AS author_name, m.body, m.created_at, m.is_ai
         FROM chat_messages m
         JOIN chats c ON c.id = m.chat_id
    LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id=$1 AND m.chat_id=$3 AND m.deleted_at IS NULL AND ${ChatsAiService.SCOPE}
        ORDER BY m.id DESC LIMIT 60`,
      [tenantId, userId, chatId],
    );
    if (!rows.length) throw AppException.validation('В этом чате пока не о чем спрашивать');

    const history = rows.reverse().map((r) => ({
      author: r.is_ai ? 'AI-помощник' : (r.author_name ?? 'система'),
      at: new Date(r.created_at).toLocaleString('ru-RU'),
      text: String(r.body ?? '').slice(0, 800),
    }));

    // Контекст CRM — проект, задачи, последний мит — приходит от ChatsService уже
    // проверенным: помощник видит ровно то, что видит спрашивающий, и не больше.
    return this.generate(tenantId, ASK_SYSTEM, { question: text, history, crm: crm ?? null }, 'chat_assistant');
  }

  /**
   * Сводка непрочитанного.
   *
   * «47 непрочитанных» не отвечает на единственный вопрос, который человек задаёт,
   * открывая чат после отпуска: что там решили и что от меня хотят. Без chatId
   * собираем по всем чатам — это и есть «что я пропустил».
   */
  async digest(tenantId: string, userId: string, chatId?: string | null): Promise<{ text: string; messages: number }> {
    const rows = await this.db.many<{ chat: string; author_name: string | null; body: string; created_at: Date }>(
      `SELECT COALESCE(p.name, c.title, peer.full_name, 'Личный диалог') AS chat,
              u.full_name AS author_name, m.body, m.created_at
         FROM chat_messages m
         JOIN chats c ON c.id = m.chat_id
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN chat_members me ON me.chat_id = c.id AND me.user_id = $2
    LEFT JOIN LATERAL (
           SELECT u2.full_name FROM chat_members m2
             JOIN users u2 ON u2.id = m2.user_id
            WHERE m2.chat_id = c.id AND m2.user_id <> $2 AND c.kind = 'dm' LIMIT 1
         ) peer ON TRUE
    LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id=$1 AND m.deleted_at IS NULL AND ${ChatsAiService.SCOPE}
          AND m.author_id IS DISTINCT FROM $2::bigint
          AND (me.last_read_at IS NULL OR m.created_at > me.last_read_at)
          AND ($3::bigint IS NULL OR c.id = $3::bigint)
        ORDER BY m.created_at DESC LIMIT 200`,
      [tenantId, userId, chatId ?? null],
    );
    if (!rows.length) return { text: 'Непрочитанного нет — всё разобрано.', messages: 0 };

    const history = rows.reverse().map((r) => ({
      chat: r.chat,
      author: r.author_name ?? 'система',
      at: new Date(r.created_at).toLocaleString('ru-RU'),
      text: String(r.body ?? '').slice(0, 600),
    }));
    const text = await this.generate(tenantId, DIGEST_SYSTEM, { history }, 'chat_digest');
    return { text, messages: rows.length };
  }

  /**
   * Поиск по переписке словами.
   *
   * Сначала находим кандидатов обычным поиском по тексту, и только потом отдаём их
   * модели: спрашивать её «поищи в базе» бессмысленно — она базы не видит, а список
   * ссылок нужен настоящий, а не пересказанный по памяти.
   */
  async search(tenantId: string, userId: string, query: string) {
    const q = String(query ?? '').trim();
    if (q.length < 3) throw AppException.validation('Слишком короткий запрос');

    // ключевые слова: длинные слова запроса — предлоги и «где» только мешают
    const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3).slice(0, 6);
    const pattern = words.length ? words.map((w) => `%${w}%`) : [`%${q}%`];

    const hits = await this.db.many<{
      id: string; chat_id: string; chat: string; author_name: string | null; body: string; created_at: Date;
    }>(
      `SELECT m.id, m.chat_id,
              COALESCE(p.name, c.title, peer.full_name, 'Личный диалог') AS chat,
              u.full_name AS author_name, m.body, m.created_at
         FROM chat_messages m
         JOIN chats c ON c.id = m.chat_id
    LEFT JOIN projects p ON p.id = c.project_id
    LEFT JOIN LATERAL (
           SELECT u2.full_name FROM chat_members m2
             JOIN users u2 ON u2.id = m2.user_id
            WHERE m2.chat_id = c.id AND m2.user_id <> $2 AND c.kind = 'dm' LIMIT 1
         ) peer ON TRUE
    LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id=$1 AND m.deleted_at IS NULL AND ${ChatsAiService.SCOPE}
          AND m.body ILIKE ANY($3::text[])
        ORDER BY m.created_at DESC LIMIT 40`,
      [tenantId, userId, pattern],
    );
    if (!hits.length) return { answer: 'В доступной переписке ничего похожего не нашлось.', refs: [] };

    const answer = await this.generate(tenantId, SEARCH_SYSTEM, {
      question: q,
      found: hits.map((h, i) => ({
        n: i + 1, chat: h.chat, author: h.author_name ?? 'система',
        at: new Date(h.created_at).toLocaleString('ru-RU'), text: String(h.body ?? '').slice(0, 600),
      })),
    }, 'chat_search');

    return {
      answer,
      refs: hits.slice(0, 10).map((h) => ({
        messageId: String(h.id), chatId: String(h.chat_id), chat: h.chat,
        author: h.author_name, at: h.created_at, text: String(h.body ?? '').slice(0, 200),
      })),
    };
  }

  /**
   * Расшифровка клипа.
   *
   * Видео с экрана тоже сюда: распознаётся звуковая дорожка, а извлекает её тот же
   * конвейер, что и у записей созвонов. Ошибку наверх не поднимаем — вызывающий
   * отправит клип без текста, и это лучше, чем потерять запись.
   */
  async transcribe(tenantId: string, buffer: Buffer, fileName: string): Promise<string> {
    try {
      const { chunks } = await extractAudioChunks(buffer, fileName);
      const parts: string[] = [];
      for (const chunk of chunks) {
        const text = await this.ai.transcribeAudio(tenantId, chunk.buffer, chunk.name);
        if (text?.trim()) parts.push(text.trim());
      }
      return parts.join(' ').slice(0, 4000);
    } catch (e) {
      this.log.warn(`расшифровка клипа: ${(e as Error).message}`);
      return '';
    }
  }

  /** Один вызов модели на все сценарии: разные промпты, одинаковая обработка отказа. */
  private async generate(tenantId: string, system: string, payload: unknown, feature: string): Promise<string> {
    try {
      const raw = await this.ai.generate(tenantId, system, JSON.stringify(payload), feature);
      const text = String(raw ?? '').trim();
      if (!text) throw new Error('пустой ответ');
      return text.slice(0, 4000);
    } catch (e) {
      this.log.warn(`${feature}: ${(e as Error).message}`);
      throw AppException.conflict('ИИ сейчас недоступен — попробуйте ещё раз');
    }
  }
}

/**
 * Задания моделям.
 *
 * Общее у всех трёх: отвечать по присланному, а не по общим соображениям. Модель,
 * дописывающая недостающее, в рабочей переписке хуже, чем молчащая: придуманную
 * договорённость примут за настоящую.
 */
const ASK_SYSTEM = [
  'Ты — помощник в рабочем чате. Отвечай на вопрос ПО ПРИСЛАННОЙ переписке этого чата.',
  'Чего в переписке нет — того не выдумывай; так и скажи, что этого в разговоре не было.',
  'Не пересказывай переписку целиком: человек её видит. Отвечай на заданный вопрос.',
  'Пиши по-русски, коротко и по делу: 2–6 предложений или короткий список.',
  'Если в переписке есть договорённость или решение — назови, кто и когда это сказал.',
  'В поле crm — то, к чему привязан чат: проект с живыми задачами, связанные задачи, итог последнего созвона.',
  'На вопросы о задачах, сроках, статусах и решениях отвечай по crm так же, как по переписке; номера задач называй как #N.',
].join(' ');

const DIGEST_SYSTEM = [
  'Ты — помощник, который пересказывает пропущенную переписку.',
  'Сгруппируй по чатам. По каждому: что решили, что изменилось, что требуется от читателя.',
  'Главное — ВОПРОСЫ И ПРОСЬБЫ, адресованные читателю: их выноси первыми и явно.',
  'Не пересказывай каждое сообщение — только то, ради чего человек стал бы это читать.',
  'Пиши по-русски. Не больше 12 строк. Без вводных фраз вроде «в этой переписке обсуждалось».',
].join(' ');

const SEARCH_SYSTEM = [
  'Ты — поиск по рабочей переписке. Тебе прислали найденные сообщения с номерами.',
  'Ответь на вопрос человека, опираясь ТОЛЬКО на них, и укажи, кто и когда это писал.',
  'Если среди присланного ответа нет — скажи прямо, что не нашлось; не додумывай.',
  'Пиши по-русски, коротко: сначала ответ, потом 1–3 подтверждающие цитаты.',
].join(' ');
