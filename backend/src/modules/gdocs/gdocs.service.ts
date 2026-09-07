import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { DbService } from '../../database/db.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { GdocsRepository } from './gdocs.repository';
import { AppException } from '../../common/http/app-exception';
import { extractGoogleLinks, fetchGoogleDocText } from './gdocs.util';

@Injectable()
export class GdocsService {
  private readonly log = new Logger('Gdocs');
  private readonly scanning = new Set<string>(); // tenantId — защита от параллельных сканов

  constructor(
    private readonly db: DbService,
    private readonly repo: GdocsRepository,
    private readonly knowledge: KnowledgeService,
  ) {}

  /** Запуск скана в фоне (статус — через getStatus). */
  scan(tenantId: string): { started: boolean } {
    if (this.scanning.has(tenantId)) return { started: false };
    this.scanning.add(tenantId);
    void this.runScan(tenantId).finally(() => this.scanning.delete(tenantId));
    return { started: true };
  }

  /** Что нашли и что с этим стало — для экрана импорта. */
  list(tenantId: string) {
    return this.repo.list(tenantId);
  }

  /**
   * Добавить документы ссылками руками.
   *
   * Сканер находит только то, на что уже сослались в задачах или чате. А переезд —
   * это ровно те документы, о которых в системе ещё нет ни слова: регламенты, брифы,
   * таблицы учёта. Поэтому их приносят ссылкой, и это законный путь, а не костыль.
   */
  async addLinks(tenantId: string, text: string, projectId?: string): Promise<{ added: number; skipped: number }> {
    const links = extractGoogleLinks(text);
    if (!links.length) return { added: 0, skipped: 0 };
    const target = projectId || (await this.repo.firstProject(tenantId))?.id;
    // Документ живёт при проекте: знание без разреза по проекту потом нечем искать.
    if (!target) throw AppException.validation('Сначала заведите хотя бы один проект');
    let added = 0;
    for (const l of links) {
      await this.repo.upsertLink({ tenantId, projectId: String(target), docKey: l.docKey, docType: l.docType, url: l.url });
      added++;
    }
    // читаем и индексируем сразу же: человек ждёт результата, а не «поставили в очередь»
    this.scan(tenantId);
    return { added, skipped: 0 };
  }

  async getStatus(tenantId: string) {
    const rows = await this.repo.statusCounts(tenantId);
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = Number(r.n);
    const total = Object.values(byStatus).reduce((s, n) => s + n, 0);
    return { scanning: this.scanning.has(tenantId), total, byStatus };
  }

  private async collectLinks(tenantId: string) {
    // ссылки из описаний задач + комментариев; привязка к проекту задачи
    const tasks = await this.db.many<{ project_id: string; description: string | null }>(
      `SELECT project_id, description FROM tasks WHERE tenant_id=$1 AND description ~* 'docs.google.com|drive.google.com'`,
      [tenantId],
    );
    const comments = await this.db.many<{ project_id: string; body: string }>(
      `SELECT t.project_id, c.body FROM task_comments c JOIN tasks t ON t.id=c.task_id
        WHERE c.tenant_id=$1 AND c.body ~* 'docs.google.com|drive.google.com'`,
      [tenantId],
    );
    /*
      Переписка проектов — третий и самый обильный источник ссылок.

      Документы бросают в чат чаще, чем вписывают в задачу: «вот бриф», «смотри
      таблицу». Пока чаты не сканировались, база знаний не видела половины того, чем
      команда реально пользуется. Берём только чаты, привязанные к проекту: у личных
      переписок нет проекта, а знание без разреза по проекту искать нечем.
    */
    const messages = await this.db.many<{ project_id: string; body: string }>(
      `SELECT c.project_id, m.body
         FROM chat_messages m JOIN chats c ON c.id = m.chat_id
        WHERE m.tenant_id=$1 AND c.project_id IS NOT NULL
          AND m.body ~* 'docs.google.com|drive.google.com'`,
      [tenantId],
    ).catch(() => []);
    const seen = new Set<string>(); // projectId:docType:docKey — не дублировать upsert
    const ids: string[] = [];
    const register = async (projectId: string, text: string | null) => {
      for (const l of extractGoogleLinks(text)) {
        const k = `${projectId}:${l.docType}:${l.docKey}`;
        if (seen.has(k)) continue;
        seen.add(k);
        ids.push(await this.repo.upsertLink({ tenantId, projectId, docKey: l.docKey, docType: l.docType, url: l.url }));
      }
    };
    for (const t of tasks) await register(String(t.project_id), t.description);
    for (const c of comments) await register(String(c.project_id), c.body);
    for (const m of messages) await register(String(m.project_id), m.body);
    return ids;
  }

  private async runScan(tenantId: string): Promise<void> {
    try {
      await this.collectLinks(tenantId);
      const docs = await this.repo.listForTenant(tenantId);
      this.log.log(`gdocs scan tenant=${tenantId}: ${docs.length} уникальных доков`);

      // ограниченная параллельность fetch (Google не любит частые запросы)
      const CONC = 4;
      let idx = 0;
      const worker = async () => {
        while (idx < docs.length) {
          const d = docs[idx++];
          const res = await fetchGoogleDocText(d.doc_type, d.doc_key);
          if (!res.ok) {
            await this.repo.setResult(d.id, { status: res.reason ?? 'error', text: null, hash: null, error: res.detail ?? null });
            continue;
          }
          const text = res.text!;
          const hash = createHash('sha256').update(text).digest('hex').slice(0, 40);
          const title = (text.split('\n').map((s) => s.trim()).find(Boolean) || `Google ${d.doc_type}`).slice(0, 120);
          await this.repo.setResult(d.id, { status: 'indexed', title, text, hash, error: null });
          this.knowledge.enqueue(tenantId, 'gdoc', d.id); // чанкинг+эмбеддинги через очередь
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONC, docs.length) }, () => worker()));
      this.log.log(`gdocs scan tenant=${tenantId} завершён`);
    } catch (e) {
      this.log.error(`gdocs scan tenant=${tenantId} failed: ${(e as Error).message}`);
    }
  }
}
