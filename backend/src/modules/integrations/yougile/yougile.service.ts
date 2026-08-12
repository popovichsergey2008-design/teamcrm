import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { AppException } from '../../../common/http/app-exception';
import { IntegrationCryptoService } from '../crypto.service';
import { YougileRepository, ConnectionRow } from './yougile.repository';
import { YougileImportService } from './yougile.import.service';
import { YougileClient } from './yougile.client';

const LIVE_EVENTS = ['task-created', 'task-moved', 'task-updated', 'task-deleted', 'task-restored'];

/** YouGile: подключение по API-ключу, импорт, живая синхронизация (вебхуки). */
@Injectable()
export class YougileService {
  private readonly log = new Logger('Yougile');

  constructor(
    private readonly repo: YougileRepository,
    private readonly crypto: IntegrationCryptoService,
    private readonly importer: YougileImportService,
    private readonly config: ConfigService,
  ) {}

  private publicBase(): string {
    const explicit = this.config.get<string>('PUBLIC_BASE_URL');
    if (explicit) return explicit.replace(/\/$/, '');
    const cors = (this.config.get<string>('CORS_ORIGIN') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return (cors.find((c) => c.startsWith('https')) ?? cors[0] ?? 'http://localhost:3000').replace(/\/$/, '');
  }
  private eventUrl(conn: ConnectionRow): string {
    return `${this.publicBase()}/api/integrations/yougile/events/${conn.event_token}`;
  }

  /** Приём события вебхука YouGile: маршрутизация по token, инкрементальная синхронизация задач. */
  async handleEvent(token: string, body: unknown) {
    const conn = await this.repo.connectionByEventToken(token);
    if (!conn) return { received: false };
    await this.repo.touchEvent(conn.id).catch(() => undefined);
    const apiKey = this.crypto.decrypt(conn.webhook_enc);
    for (const ev of this.extractTaskEvents(body)) {
      void this.importer.syncOne({ tenantId: conn.tenant_id, connectionId: conn.id, apiKey, taskExternalId: ev.taskId, event: ev.event, actorId: conn.created_by });
    }
    return { received: true };
  }

  /** Достаёт события по задачам из тела вебхука (форма payload не документирована — парсим защитно). */
  private extractTaskEvents(body: unknown): { event: string; taskId: string }[] {
    const arr = Array.isArray(body) ? body : [body];
    const out: { event: string; taskId: string }[] = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const o = it as Record<string, any>;
      const event = String(o.event ?? o.type ?? '');
      if (event && !event.toLowerCase().includes('task')) continue; // не по задаче — игнор
      const id = o.id ?? o.taskId ?? o.payload?.id ?? o.data?.id ?? o.object?.id ?? o.payload?.taskId;
      if (id) out.push({ event, taskId: String(id) });
    }
    return out;
  }

  /** Включить живую синхронизацию: регистрируем вебхуки YouGile на наш публичный URL (недостающие). */
  async enableLive(tenantId: string, cid: string) {
    const conn = await this.repo.getConnection(tenantId, cid);
    if (!conn) throw AppException.notFound('Подключение не найдено');
    const url = this.eventUrl(conn);
    const client = new YougileClient(this.crypto.decrypt(conn.webhook_enc));
    let existing: { url: string; event: string; deleted?: boolean }[] = [];
    try { existing = await client.listWebhooks(); } catch { /* нет — создадим все */ }
    const have = new Set(existing.filter((w) => !w.deleted).map((w) => `${w.url}|${w.event}`));
    const created: string[] = [];
    for (const event of LIVE_EVENTS) {
      if (have.has(`${url}|${event}`)) continue;
      try { await client.createWebhook(url, event); created.push(event); }
      catch (e) { this.log.warn(`webhook ${event} failed: ${(e as Error).message}`); }
    }
    return { url, events: LIVE_EVENTS, created };
  }

  async connect(tenantId: string, actorId: string, apiKey: string, label?: string) {
    const key = apiKey.trim();
    if (!key) throw AppException.validation('Укажите API-ключ YouGile');
    try {
      await new YougileClient(key).validate();
    } catch {
      throw AppException.validation('Ключ YouGile недействителен или нет доступа. Создайте ключ в YouGile → Настройки → API.');
    }
    const conn = await this.repo.createConnection({
      tenantId, label: label?.trim() || null, portal: null,
      webhookEnc: this.crypto.encrypt(key), createdBy: actorId, eventToken: randomBytes(24).toString('hex'),
    });
    return { id: conn.id, label: conn.label };
  }

  listConnections(tenantId: string) {
    return this.repo.listConnections(tenantId);
  }

  async disconnect(tenantId: string, cid: string) {
    const conn = await this.repo.getConnection(tenantId, cid);
    if (!conn) throw AppException.notFound('Подключение не найдено');
    await this.repo.deleteConnection(tenantId, cid);
    return { disconnected: true };
  }

  private async keyFor(tenantId: string, cid: string): Promise<string> {
    const conn = await this.repo.getConnection(tenantId, cid);
    if (!conn) throw AppException.notFound('Подключение не найдено');
    return this.crypto.decrypt(conn.webhook_enc);
  }

  /** Доски YouGile (кандидаты на импорт) с названием их проекта. */
  async listBoards(tenantId: string, cid: string) {
    const key = await this.keyFor(tenantId, cid);
    const client = new YougileClient(key);
    const [projects, boards] = await Promise.all([client.listProjects(), client.listBoards()]);
    const projTitle = new Map(projects.map((p) => [String(p.id), p.title]));
    return boards
      .filter((b) => !b.deleted)
      .map((b) => ({ externalId: b.id, title: b.title, projectTitle: projTitle.get(String(b.projectId)) ?? null }));
  }

  async startImport(tenantId: string, actorId: string, cid: string, boardExternalIds: string[]) {
    const key = await this.keyFor(tenantId, cid);
    const ids = (boardExternalIds ?? []).map(String).filter(Boolean);
    if (!ids.length) throw AppException.validation('Выберите доски для импорта');
    const run = await this.repo.createRun(tenantId, cid, { boardExternalIds: ids });
    void this.importer.run({ tenantId, connectionId: cid, apiKey: key, boardExternalIds: ids, runId: run!.id, actorId });
    return { runId: run!.id };
  }

  async getRun(tenantId: string, id: string) {
    const r = await this.repo.getRun(tenantId, id);
    if (!r) throw AppException.notFound('Запуск не найден');
    return r;
  }

  /** Пользователи YouGile без сопоставления (нет ни авто-мэтча по e-mail, ни ручной привязки). */
  async unmatchedUsers(tenantId: string, cid: string) {
    const key = await this.keyFor(tenantId, cid);
    const [ygUsers, emailMap, manual] = await Promise.all([
      new YougileClient(key).listUsers(), this.repo.userEmailMap(tenantId), this.repo.userRefs(cid),
    ]);
    const items = ygUsers
      .filter((u) => !manual.get(String(u.id)) && !(u.email && emailMap.get(u.email.toLowerCase())))
      .map((u) => ({ externalId: String(u.id), name: u.realName ?? '—', email: u.email ?? '' }));
    return { total: items.length, items: items.slice(0, 200) };
  }

  /** Ручная привязка пользователя YouGile к локальному (external_refs). Применится при следующем импорте. */
  async mapUser(tenantId: string, cid: string, externalUserId: string, localUserId: string) {
    const conn = await this.repo.getConnection(tenantId, cid);
    if (!conn) throw AppException.notFound('Подключение не найдено');
    if (!(await this.repo.userExists(tenantId, localUserId))) throw AppException.validation('Пользователь не найден');
    await this.repo.putRef({ tenantId, connectionId: cid, entityType: 'user', externalId: String(externalUserId), localId: localUserId });
    return { mapped: true };
  }
}
