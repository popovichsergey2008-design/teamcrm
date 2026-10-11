import { ProjectViewer } from '../../common/access/project-visibility';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { extractText, MAX_FILE_BYTES } from './file-text';
import { DbService } from '../../database/db.service';
import { RabbitMQService, Q_EMBEDDINGS } from '../../messaging/rabbitmq.service';
import { AiService } from '../ai/ai.service';
import { maskPII } from '../ai/pii';
import { KnowledgeRepository } from './knowledge.repository';
import { FilesService } from '../files/files.service';
import { Anchor, clock, ftsQuery, groupLines, Line, memoryLink, MemoryType, Part, TYPE_LABEL } from './memory-rules';
import { MemoryFilters } from './knowledge.repository';

export type SourceType = MemoryType;
interface IndexMsg { tenantId: string; sourceType: SourceType; sourceId: string; }

/** Текст источника и где он живёт. `parts` — уже нарезанный по репликам/сообщениям, с якорями. */
interface Loaded {
  text?: string;
  parts?: Part[];
  accessScope: string | null;
  title: string | null;
  anchor?: Anchor | null;
  sourceAt?: Date | string | null;
  authorId?: string | null;
  /** переписка: фрагмент видят только участники этого чата */
  chatId?: string | null;
  staffOnly?: boolean;
}

const CHUNK = 1200;
const OVERLAP = 150;

@Injectable()
export class KnowledgeService implements OnModuleInit {
  private readonly log = new Logger('Knowledge');

  constructor(
    private readonly db: DbService,
    private readonly repo: KnowledgeRepository,
    private readonly ai: AiService,
    private readonly mq: RabbitMQService,
    private readonly files: FilesService,
  ) {}

  async onModuleInit() {
    // воркер очереди эмбеддингов
    await this.mq.consume(Q_EMBEDDINGS, (msg: IndexMsg) => this.indexSource(msg), 4);
  }

  enqueue(tenantId: string, sourceType: SourceType, sourceId: string) {
    return this.mq.publish(Q_EMBEDDINGS, { tenantId, sourceType, sourceId });
  }

  private chunk(text: string): string[] {
    const t = text.trim();
    if (t.length <= CHUNK) return t ? [t] : [];
    const out: string[] = [];
    for (let i = 0; i < t.length; i += CHUNK - OVERLAP) out.push(t.slice(i, i + CHUNK));
    return out;
  }

  /** Загружает текст источника + метаданные (scope/title). null — источник исчез/пуст. */
  private async loadSource(msg: IndexMsg): Promise<Loaded | null> {
    if (msg.sourceType === 'chat') return this.loadChatDay(msg.tenantId, msg.sourceId);
    if (msg.sourceType === 'decision') return this.loadDecision(msg.tenantId, msg.sourceId);
    if (msg.sourceType === 'news') return this.loadNews(msg.tenantId, msg.sourceId);
    if (msg.sourceType === 'client_note') return this.loadClientNote(msg.tenantId, msg.sourceId);
    if (msg.sourceType === 'project') {
      // описания у проекта нет — память знает имя, клиента и срок сдачи: «когда сдаём X»
      const r = await this.db.one<any>(
        `SELECT p.name, p.created_at, p.target_date::text AS target, c.name AS client
           FROM projects p LEFT JOIN clients c ON c.id = p.client_id
          WHERE p.tenant_id=$1 AND p.id=$2`,
        [msg.tenantId, msg.sourceId],
      );
      if (!r) return null;
      const text = [`Проект «${r.name}»`, r.client ? `клиент: ${r.client}` : null, r.target ? `срок сдачи: ${r.target}` : null]
        .filter(Boolean).join(', ');
      return { text, accessScope: msg.sourceId, title: `Проект: ${r.name}`, sourceAt: r.created_at };
    }
    if (msg.sourceType === 'task') {
      const r = await this.db.one<any>(
        `SELECT title, description, project_id, created_at, created_by::text FROM tasks WHERE tenant_id=$1 AND id=$2`,
        [msg.tenantId, msg.sourceId],
      );
      if (!r) return null; // индексируем ВСЕ задачи (и открытые, и закрытые проекты)
      const files = await this.db.many<{ file_name: string }>(
        `SELECT f.file_name FROM task_attachments a JOIN files f ON f.id=a.file_id
          WHERE a.tenant_id=$1 AND a.task_id=$2`,
        [msg.tenantId, msg.sourceId],
      );
      const fileText = files.length ? `\nФайлы: ${files.map((f) => f.file_name).join(', ')}` : '';
      return {
        text: [r.title, r.description].filter(Boolean).join('\n') + fileText, accessScope: r.project_id, title: r.title,
        sourceAt: r.created_at, authorId: r.created_by,
      };
    }
    if (msg.sourceType === 'comment') {
      const r = await this.db.one<any>(
        `SELECT c.body, t.project_id, t.title AS task_title, c.task_id::text, c.created_at, c.author_id::text
           FROM task_comments c JOIN tasks t ON t.id=c.task_id
          WHERE c.tenant_id=$1 AND c.id=$2`,
        [msg.tenantId, msg.sourceId],
      );
      if (!r || !String(r.body ?? '').trim()) return null;
      return {
        text: r.body, accessScope: r.project_id, title: r.task_title,
        anchor: { taskId: r.task_id }, sourceAt: r.created_at, authorId: r.author_id,
      };
    }
    if (msg.sourceType === 'meeting') {
      // в память компании кладём сводку и стенограмму: «что мы решили по X» ищется именно там
      // Нарезка по репликам, а не сплошным текстом: у фрагмента есть секунда записи, и
      // ответ ведёт ровно туда, где это сказано (ТЗ-21 §40).
      const m = await this.db.one<any>(
        `SELECT m.title, m.project_id, s.summary, COALESCE(m.happened_at, m.created_at) AS at,
                CASE WHEN c.kind IS NOT NULL AND c.kind <> 'project' THEN m.chat_id::text END AS private_chat
           FROM meetings m
           LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
           LEFT JOIN chats c ON c.id = m.chat_id
          WHERE m.tenant_id=$1 AND m.id=$2`,
        [msg.tenantId, msg.sourceId],
      );
      if (!m) return null;
      const lines = await this.db.many<{ text: string; speaker: string | null; start_sec: string; speaker_user_id: string | null }>(
        `SELECT speaker, text, start_sec, speaker_user_id::text FROM meeting_segments WHERE tenant_id=$1 AND meeting_id=$2 ORDER BY idx`,
        [msg.tenantId, msg.sourceId],
      );
      if (!lines.some((l) => l.text.trim())) return null;
      const at = new Date(m.at);
      const parts: Part[] = [];
      if (m.summary) parts.push({ text: `Итоги встречи «${m.title}»: ${m.summary}`, anchor: { meetingId: msg.sourceId }, at, authorId: null });
      parts.push(...groupLines(lines.map((l): Line => ({
        text: `[${clock(Number(l.start_sec))}] ${l.speaker ? `${l.speaker}: ` : ''}${l.text}`,
        anchor: { meetingId: msg.sourceId, sec: Number(l.start_sec) },
        at: new Date(at.getTime() + Number(l.start_sec) * 1000),
        authorId: l.speaker_user_id,
      })), 500)); // мельче, чем текст: секунда в ссылке точнее
      return { parts, accessScope: m.project_id, title: `Встреча: ${m.title}`, sourceAt: at, chatId: m.private_chat };
    }
    if (msg.sourceType === 'gdoc') {
      const r = await this.db.one<any>(
        `SELECT title, text, project_id FROM google_docs WHERE tenant_id=$1 AND id=$2 AND status='indexed'`,
        [msg.tenantId, msg.sourceId],
      );
      if (!r || !String(r.text ?? '').trim()) return null;
      return { text: [r.title, r.text].filter(Boolean).join('\n'), accessScope: r.project_id, title: r.title };
    }
    if (msg.sourceType === 'file') {
      // Индексируем только вложения задач: у них есть проект, а значит и область доступа.
      // Аватарки и служебные файлы в корпоративную память не попадают.
      const f = await this.db.one<any>(
        `SELECT f.id, f.file_name, f.content_type, f.size_bytes, t.project_id, t.title AS task_title
           FROM files f
           JOIN task_attachments a ON a.file_id = f.id
           JOIN tasks t ON t.id = a.task_id
          WHERE f.tenant_id = $1 AND f.id = $2
          LIMIT 1`,
        [msg.tenantId, msg.sourceId],
      );
      if (!f) return null; // файл удалён или отвязан от задачи — чанки уйдут следом
      if (Number(f.size_bytes) > MAX_FILE_BYTES) {
        this.log.warn(`файл ${f.file_name} не индексирован: ${Math.round(Number(f.size_bytes) / 1048576)} МБ больше лимита`);
        return null;
      }
      const buf = await this.download(msg.tenantId, String(f.id));
      if (!buf) return null;
      const extracted = await extractText(buf, f.file_name, f.content_type);
      if (!extracted) {
        // Ни ошибки, ни тишины: человек должен понимать, почему скан не находится поиском.
        this.log.log(`из файла ${f.file_name} текст не извлечён (формат не поддержан или это скан)`);
        return null;
      }
      return {
        text: `Файл: ${f.file_name} (задача: ${f.task_title})
${extracted.text}`,
        accessScope: f.project_id,
        title: f.file_name,
      };
    }

    // regulation
    const r = await this.db.one<any>(`SELECT title, body FROM regulations WHERE tenant_id=$1 AND id=$2`, [msg.tenantId, msg.sourceId]);
    if (!r) return null;
    return { text: [r.title, r.body].filter(Boolean).join('\n'), accessScope: null, title: r.title };
  }

  /**
   * Переписка за день — один источник; номер — первое сообщение дня в этом чате.
   * Пришло новое сообщение — день переиндексируется целиком (хеш не даст делать это
   * зря). Удалили первое сообщение — у дня новый номер, старый источник уходит сам.
   */
  private async loadChatDay(tenantId: string, firstId: string): Promise<Loaded | null> {
    const head = await this.db.one<any>(
      `SELECT m.chat_id::text, (m.created_at AT TIME ZONE 'UTC')::date::text AS day, c.kind, c.title, c.project_id::text
         FROM chat_messages m JOIN chats c ON c.id = m.chat_id
        WHERE m.tenant_id = $1 AND m.id = $2 AND m.deleted_at IS NULL`,
      [tenantId, firstId],
    );
    if (!head) return null;
    const rows = await this.db.many<any>(
      `SELECT m.id::text, m.body, m.created_at, m.author_id::text, COALESCE(u.full_name, m.guest_name, 'Гость') AS who
         FROM chat_messages m LEFT JOIN users u ON u.id = m.author_id
        WHERE m.chat_id = $1 AND m.deleted_at IS NULL AND NOT m.is_ai
          AND (m.created_at AT TIME ZONE 'UTC')::date = $2::date
        ORDER BY m.id LIMIT 2000`,
      [head.chat_id, head.day],
    );
    if (!rows.length || rows[0].id !== String(firstId)) return null; // день теперь начинается с другого сообщения
    const parts = groupLines(rows
      .filter((r) => String(r.body ?? '').trim())
      .map((r): Line => ({
        text: `${r.who}: ${String(r.body).replace(/\s+/g, ' ').trim()}`,
        anchor: { chatId: head.chat_id, messageId: r.id }, at: r.created_at, authorId: r.author_id,
      })));
    if (!parts.length) return null;
    const name = head.kind === 'dm' ? 'Личная переписка' : `Чат «${head.title ?? 'без названия'}»`;
    return {
      parts, accessScope: head.kind === 'project' ? head.project_id : null, title: name,
      sourceAt: rows[0].created_at, chatId: head.chat_id, staffOnly: head.kind === 'guest',
    };
  }

  /** Решение — со ссылкой туда, где его приняли; изменённое помнит, на что его заменили. */
  private async loadDecision(tenantId: string, id: string): Promise<Loaded | null> {
    const d = await this.db.one<any>(
      `SELECT d.text, d.details, d.project_id::text, d.chat_id::text, d.meeting_id::text, d.source_message_id::text,
              d.decided_at, d.revoked_at, d.superseded_at, n.text AS new_text, c.kind AS chat_kind, mc.kind AS meeting_chat_kind,
              mt.chat_id::text AS meeting_chat
         FROM decisions d
         LEFT JOIN decisions n ON n.id = d.superseded_by
         LEFT JOIN chats c ON c.id = d.chat_id
         LEFT JOIN meetings mt ON mt.id = d.meeting_id
         LEFT JOIN chats mc ON mc.id = mt.chat_id
        WHERE d.tenant_id = $1 AND d.id = $2`,
      [tenantId, id],
    );
    if (!d || d.revoked_at) return null;
    const day = (v: Date | string) => new Date(v).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const changed = d.superseded_at ? `\nРешение изменено ${day(d.superseded_at)}: ${d.new_text ?? ''}` : '';
    const chatId = d.chat_id && d.chat_kind !== 'project' ? d.chat_id
      : d.meeting_chat && d.meeting_chat_kind && d.meeting_chat_kind !== 'project' ? d.meeting_chat : null;
    return {
      text: `Решение от ${day(d.decided_at)}: ${d.text}${d.details ? `\n${d.details}` : ''}${changed}`,
      accessScope: d.project_id,
      title: d.superseded_at ? `Решение (изменено): ${String(d.text).slice(0, 120)}` : `Решение: ${String(d.text).slice(0, 140)}`,
      anchor: {
        decisionId: id, chatId: d.chat_id ?? undefined, messageId: d.source_message_id ?? undefined, meetingId: d.meeting_id ?? undefined,
      },
      sourceAt: d.decided_at, chatId,
    };
  }

  /** Новость — только видимая всей компании или проекту; по отделам — не индексируем. */
  private async loadNews(tenantId: string, id: string): Promise<Loaded | null> {
    const r = await this.db.one<any>(
      `SELECT title, body, visibility, project_id::text, published_at, author_id::text
         FROM feed_posts WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL AND status = 'published'`,
      [tenantId, id],
    );
    if (!r || !['all', 'project'].includes(r.visibility)) return null;
    if (r.visibility === 'project' && !r.project_id) return null;
    const text = [r.title, r.body].filter(Boolean).join('\n').trim();
    if (!text) return null;
    return {
      text, accessScope: r.visibility === 'project' ? r.project_id : null, title: `Новость: ${String(r.title ?? r.body).slice(0, 140)}`,
      sourceAt: r.published_at, authorId: r.author_id,
    };
  }

  /** Заметка о клиенте — сотрудникам; личные заметки в общую память не кладём. */
  private async loadClientNote(tenantId: string, id: string): Promise<Loaded | null> {
    const r = await this.db.one<any>(
      `SELECT n.body, n.client_id::text, n.created_at, n.author_id::text, c.name
         FROM client_notes n JOIN clients c ON c.id = n.client_id
        WHERE n.tenant_id = $1 AND n.id = $2 AND n.deleted_at IS NULL AND NOT n.is_private`,
      [tenantId, id],
    );
    if (!r || !String(r.body ?? '').trim()) return null;
    return {
      text: `Клиент «${r.name}»: ${r.body}`, accessScope: null, title: `Клиент: ${r.name}`,
      anchor: { clientId: r.client_id }, sourceAt: r.created_at, authorId: r.author_id, staffOnly: true,
    };
  }

  /**
   * Скачать вложение целиком в память.
   *
   * Читаем потоком с ограничением: размер в базе может врать (файл подменили в хранилище),
   * а разбор гигантского документа заблокировал бы очередь эмбеддингов.
   */
  private async download(tenantId: string, fileId: string): Promise<Buffer | null> {
    try {
      const { stream } = await this.files.getForDownload(tenantId, fileId);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += (chunk as Buffer).length;
        if (size > MAX_FILE_BYTES) return null;
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    } catch (e) {
      this.log.warn(`не удалось прочитать файл ${fileId}: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  }

  /** Идемпотентная индексация источника: маскирование PII → чанкинг → эмбеддинги → замена чанков. */
  async indexSource(msg: IndexMsg): Promise<void> {
    const src = await this.loadSource(msg);
    if (!src) { await this.repo.deleteBySource(msg.tenantId, msg.sourceType, msg.sourceId); return; }

    const parts: Part[] = src.parts
      ?? (src.text ? [{ text: src.text, anchor: src.anchor ?? {}, at: src.sourceAt ?? null, authorId: src.authorId ?? null }] : []);
    const whole = parts.map((p) => p.text).join('\n');
    // в хеш — и место в доступе: перенесли задачу в закрытый проект — фрагменты переписать
    const hash = createHash('sha256').update(`${src.accessScope ?? ''}|${src.chatId ?? ''}|${src.staffOnly ? 1 : 0}|${whole}`).digest('hex').slice(0, 40);
    if ((await this.repo.sourceHash(msg.tenantId, msg.sourceType, msg.sourceId)) === hash) return; // не изменилось

    const chunks: { content: string; embedding: number[]; anchor: Anchor | null; sourceAt: Date | string | null; authorId: string | null }[] = [];
    for (const part of parts) {
      for (const raw of this.chunk(part.text)) {
        const masked = maskPII(raw).masked;
        const embedding = await this.ai.embed(msg.tenantId, masked, 'embedding');
        chunks.push({
          content: masked, embedding, anchor: Object.keys(part.anchor ?? {}).length ? part.anchor : null,
          sourceAt: part.at ?? src.sourceAt ?? null, authorId: part.authorId ?? null,
        });
      }
    }
    if (!chunks.length) { await this.repo.deleteBySource(msg.tenantId, msg.sourceType, msg.sourceId); return; }

    // подпись модели берём у провайдера арендатора: ключи живут в ai_settings, а не в .env
    const model = await this.ai.embedModelFor(msg.tenantId);
    await this.repo.replaceChunks({
      tenantId: msg.tenantId, sourceType: msg.sourceType, sourceId: msg.sourceId,
      accessScope: src.accessScope, title: src.title, hash, model, chunks,
      chatId: src.chatId ?? null, staffOnly: src.staffOnly === true,
    });
    this.log.log(`indexed ${msg.sourceType}#${msg.sourceId} (${chunks.length} chunk(s))`);
  }

  /** Семантический поиск. Опционально в рамках одного проекта (+ общие регламенты). */
  async search(tenantId: string, query: string, k = 8, projectId?: string, types?: SourceType[], viewer?: ProjectViewer) {
    const vec = await this.ai.embed(tenantId, query, 'embedding');
    return this.searchByVector(tenantId, vec, k, projectId, types, viewer);
  }

  /** Поиск по готовому вектору (переиспользуется в AI Brain / кэше — без повторного эмбеддинга). */
  async searchByVector(tenantId: string, vec: number[], k = 8, projectId?: string, types?: SourceType[], viewer?: ProjectViewer) {
    const hits = await this.repo.search(tenantId, vec, k, projectId, types, viewer);
    // подписи проектов для разреза «по проектам»
    const scopeIds = [...new Set(hits.map((h) => h.access_scope).filter(Boolean) as string[])];
    const names = new Map<string, string>();
    if (scopeIds.length) {
      const rows = await this.db.many<{ id: string; name: string }>(
        `SELECT id, name FROM projects WHERE tenant_id=$1 AND id = ANY($2::bigint[])`, [tenantId, scopeIds],
      );
      for (const r of rows) names.set(String(r.id), r.name);
    }
    return hits.map((h) => ({
      sourceType: h.source_type, sourceId: h.source_id, title: h.title,
      projectId: h.access_scope, projectName: h.access_scope ? names.get(String(h.access_scope)) ?? null : null,
      snippet: h.content.slice(0, 400), score: Number(h.score),
    }));
  }

  /**
   * «Вторая память» (ТЗ-21 §35–45): по смыслу и по словам, с фильтрами, права — до
   * поиска. Каждый фрагмент — со ссылкой туда, где это было: секунда записи, сообщение,
   * задача. Без настоящей модели эмбеддингов ищем только по словам — это честнее, чем
   * подмешивать случайные «похожие».
   */
  async memory(tenantId: string, q: string, viewer: ProjectViewer, f: MemoryFilters = {}, k = 10) {
    const real = (await this.ai.embedModelFor(tenantId).catch(() => 'mock-embed')) !== 'mock-embed';
    const vec = real ? await this.ai.embed(tenantId, q, 'embedding').catch(() => null) : null;
    const hits = await this.repo.hybrid(tenantId, vec, ftsQuery(q), k, f, viewer);
    return this.decorate(tenantId, hits);
  }

  /**
   * Для «Мозга»: тот же гибридный поиск по готовому вектору вопроса. Вектор от заглушки
   * (нет ключа) не используем — только слова.
   */
  async recall(tenantId: string, q: string, vec: number[] | null, viewer: ProjectViewer, projectId?: string, k = 6) {
    const real = (await this.ai.embedModelFor(tenantId).catch(() => 'mock-embed')) !== 'mock-embed';
    const hits = await this.repo.hybrid(tenantId, real ? vec : null, ftsQuery(q), k, { projectId: projectId ?? null }, viewer);
    return this.decorate(tenantId, hits);
  }

  /** Подписи и ссылки к найденному: тип по-русски, проект, кто сказал, куда вести. */
  async decorate(tenantId: string, hits: import('./knowledge.repository').SearchHit[]) {
    const scopeIds = [...new Set(hits.map((h) => h.access_scope).filter(Boolean) as string[])];
    const authorIds = [...new Set(hits.map((h) => h.author_id).filter(Boolean) as string[])];
    const [projects, people] = await Promise.all([
      scopeIds.length
        ? this.db.many<{ id: string; name: string }>(`SELECT id::text, name FROM projects WHERE tenant_id=$1 AND id = ANY($2::bigint[])`, [tenantId, scopeIds])
        : Promise.resolve([]),
      authorIds.length
        ? this.db.many<{ id: string; name: string }>(`SELECT id::text, full_name AS name FROM users WHERE tenant_id=$1 AND id = ANY($2::bigint[])`, [tenantId, authorIds])
        : Promise.resolve([]),
    ]);
    const pn = new Map(projects.map((p) => [String(p.id), p.name]));
    const un = new Map(people.map((p) => [String(p.id), p.name]));
    return hits.map((h) => {
      const anchor = (h.anchor ?? null) as Anchor | null;
      return {
        sourceType: h.source_type, typeLabel: TYPE_LABEL[h.source_type as MemoryType] ?? h.source_type,
        sourceId: String(h.source_id), title: h.title, snippet: h.content.slice(0, 400),
        link: memoryLink(h.source_type, String(h.source_id), h.access_scope ? String(h.access_scope) : null, anchor),
        sec: anchor?.sec ?? null, at: h.source_at ?? null,
        author: h.author_id ? un.get(String(h.author_id)) ?? null : null,
        projectId: h.access_scope ? String(h.access_scope) : null,
        projectName: h.access_scope ? pn.get(String(h.access_scope)) ?? null : null,
        private: !!h.chat_id,
        score: Number(h.score),
      };
    });
  }

  /** Постановка всех знаний арендатора в очередь индексации (в т.ч. импортированных из Битрикса). */
  async backfill(tenantId: string): Promise<{ queued: number }> {
    let queued = 0;
    const tasks = await this.db.many<{ id: string }>(`SELECT id FROM tasks WHERE tenant_id=$1`, [tenantId]);
    for (const t of tasks) { this.enqueue(tenantId, 'task', t.id); queued++; }
    const files = await this.db.many<{ id: string }>(
      `SELECT DISTINCT f.id FROM files f JOIN task_attachments a ON a.file_id = f.id WHERE f.tenant_id=$1`,
      [tenantId],
    );
    for (const f of files) { this.enqueue(tenantId, 'file', f.id); queued++; }
    const comments = await this.db.many<{ id: string }>(`SELECT id FROM task_comments WHERE tenant_id=$1`, [tenantId]);
    for (const c of comments) { this.enqueue(tenantId, 'comment', c.id); queued++; }
    const regs = await this.db.many<{ id: string }>(`SELECT id FROM regulations WHERE tenant_id=$1`, [tenantId]);
    for (const r of regs) { this.enqueue(tenantId, 'regulation', r.id); queued++; }
    return { queued };
  }

  stats(tenantId: string) {
    return this.repo.countByTenant(tenantId);
  }

  /** Список источников базы знаний (для ручного просмотра содержимого) + имена проектов. */
  async listSources(tenantId: string, opts: { projectId?: string; type?: string; q?: string; limit?: number; offset?: number; viewer?: ProjectViewer }) {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const offset = Math.max(opts.offset ?? 0, 0);
    const rows = await this.repo.listSources(tenantId, { projectId: opts.projectId, type: opts.type, q: opts.q, limit, offset, viewer: opts.viewer });
    const scopeIds = [...new Set(rows.map((r) => r.access_scope).filter(Boolean) as string[])];
    const names = new Map<string, string>();
    if (scopeIds.length) {
      const prj = await this.db.many<{ id: string; name: string }>(
        `SELECT id, name FROM projects WHERE tenant_id=$1 AND id = ANY($2::bigint[])`, [tenantId, scopeIds],
      );
      for (const p of prj) names.set(String(p.id), p.name);
    }
    return {
      items: rows.map((r) => ({
        sourceType: r.source_type, sourceId: r.source_id, title: r.title, chunks: r.chunks, snippet: r.snippet,
        projectId: r.access_scope, projectName: r.access_scope ? names.get(String(r.access_scope)) ?? null : null,
      })),
      limit, offset, hasMore: rows.length === limit,
    };
  }

  /** Ключ доступа человека — для кэшей ответов ИИ (см. репозиторий). */
  accessKey(tenantId: string, viewer: ProjectViewer) {
    return this.repo.accessKey(tenantId, viewer);
  }

  /** Источник из закрытого проекта человеку не показываем — даже по прямому номеру. */
  async canOpenSource(tenantId: string, type: string, id: string, viewer: ProjectViewer): Promise<boolean> {
    const scope = await this.repo.scopeOf(tenantId, type, id);
    if (scope === undefined || scope === null) return true;
    return this.repo.projectVisible(tenantId, String(scope), viewer);
  }

  /** Полное содержимое одного источника из исходной таблицы (для просмотра в базе знаний). */
  async sourceContent(tenantId: string, type: string, id: string): Promise<{ sourceType: string; title: string | null; text: string; url?: string | null; projectName?: string | null } | null> {
    const projName = async (projectId: string | null) =>
      projectId ? (await this.db.one<{ name: string }>(`SELECT name FROM projects WHERE tenant_id=$1 AND id=$2`, [tenantId, projectId]))?.name ?? null : null;

    if (type === 'task') {
      const r = await this.db.one<any>(`SELECT title, description, project_id FROM tasks WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
      if (!r) return null;
      return { sourceType: type, title: r.title, text: String(r.description ?? ''), projectName: await projName(r.project_id) };
    }
    if (type === 'comment') {
      const r = await this.db.one<any>(
        `SELECT c.body, t.title AS task_title, t.project_id FROM task_comments c JOIN tasks t ON t.id=c.task_id WHERE c.tenant_id=$1 AND c.id=$2`, [tenantId, id]);
      if (!r) return null;
      return { sourceType: type, title: r.task_title, text: String(r.body ?? ''), projectName: await projName(r.project_id) };
    }
    if (type === 'gdoc') {
      const r = await this.db.one<any>(`SELECT title, text, url, project_id FROM google_docs WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
      if (!r) return null;
      return { sourceType: type, title: r.title, text: String(r.text ?? ''), url: r.url, projectName: await projName(r.project_id) };
    }
    if (type === 'regulation') {
      const r = await this.db.one<any>(`SELECT title, body FROM regulations WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
      if (!r) return null;
      return { sourceType: type, title: r.title, text: String(r.body ?? '') };
    }
    return null;
  }
}
