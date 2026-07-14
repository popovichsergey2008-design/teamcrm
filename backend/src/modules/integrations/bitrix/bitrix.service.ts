import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AppException } from '../../../common/http/app-exception';
import { IntegrationCryptoService } from '../crypto.service';
import { BitrixClient, BitrixError } from './bitrix.client';
import { BitrixRepository } from './bitrix.repository';
import { BitrixImportService } from './bitrix.import.service';

const PROVIDER = 'bitrix';

@Injectable()
export class BitrixService {
  constructor(
    private readonly repo: BitrixRepository,
    private readonly crypto: IntegrationCryptoService,
    private readonly importer: BitrixImportService,
  ) {}

  private validateUrl(url: string) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw AppException.validation('Некорректный URL вебхука');
    }
    const isLocal = ['localhost', '127.0.0.1'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal)) {
      throw AppException.validation('URL вебхука должен быть https');
    }
    if (!/\/rest\//.test(u.pathname)) throw AppException.validation('Это не похоже на URL входящего вебхука Битрикса (нет /rest/)');
  }

  async connect(tenantId: string, actorId: string, webhookUrl: string, label?: string) {
    this.validateUrl(webhookUrl);
    const client = new BitrixClient(webhookUrl);
    try {
      await client.profile(); // проверка связи
    } catch {
      throw AppException.validation('Не удалось подключиться к Битриксу по этому вебхуку (проверьте URL и права)');
    }
    const portal = client.portal;
    if (await this.repo.connectionByPortal(tenantId, PROVIDER, portal)) {
      throw AppException.conflict(`Портал ${portal} уже подключён`);
    }
    const conn = await this.repo.createConnection({
      tenantId, provider: PROVIDER, label: label?.trim() || portal, portal,
      webhookEnc: this.crypto.encrypt(webhookUrl), createdBy: actorId, eventToken: randomBytes(24).toString('hex'),
    });
    return { id: conn.id, portal, label: conn.label, isActive: true, eventToken: conn.event_token };
  }

  /** Обработка исходящего события Битрикса (публичный маршрут, роутинг по event_token). */
  async handleEvent(token: string, body: any) {
    const conn = await this.repo.connectionByEventToken(token);
    if (!conn) return { received: false };
    await this.repo.touchEvent(conn.id);

    const event = String(body?.event ?? '').toUpperCase();
    const data = body?.data ?? {};
    const fields = data.FIELDS_AFTER ?? data.FIELDS_BEFORE ?? data.fields_after ?? data.fields_before ?? {};
    const isComment = event.includes('COMMENT');
    const webhookUrl = this.crypto.decrypt(conn.webhook_enc);

    if (event.includes('DELETE') && !isComment) {
      const delId = String(fields.ID ?? fields.id ?? '');
      if (delId) void this.importer.deleteTaskByExternal(conn.tenant_id, conn.id, delId);
    } else {
      const taskId = String((isComment ? (fields.TASK_ID ?? fields.taskId) : (fields.ID ?? fields.id)) ?? '');
      if (taskId) {
        void this.importer.syncTaskById({
          tenantId: conn.tenant_id, connectionId: conn.id, webhookUrl, actorId: conn.created_by, taskId,
        });
      }
    }
    return { received: true };
  }

  listConnections(tenantId: string) {
    return this.repo.listConnections(tenantId, PROVIDER);
  }

  async disconnect(tenantId: string, cid: string) {
    const conn = await this.repo.getConnection(tenantId, cid);
    if (!conn) throw AppException.notFound('Подключение не найдено');
    await this.repo.deleteConnection(tenantId, cid);
    return { deleted: true };
  }

  private async clientFor(tenantId: string, cid: string): Promise<{ client: BitrixClient; webhookUrl: string }> {
    const conn = await this.repo.getConnection(tenantId, cid);
    if (!conn) throw AppException.notFound('Подключение не найдено');
    const webhookUrl = this.crypto.decrypt(conn.webhook_enc);
    return { client: new BitrixClient(webhookUrl), webhookUrl };
  }

  /** Переводит ошибку Битрикса в понятное сообщение (иначе — 500). */
  private translate(e: unknown): never {
    if (e instanceof BitrixError) {
      if (/privileg|insufficient|scope|access denied|higher privileges/i.test(e.message)) {
        throw AppException.validation(
          'У вебхука недостаточно прав. В настройках входящего вебхука Битрикса включите права: task, user, sonet_group (и для вложений/ленты — disk, log), затем пересоздайте подключение.',
        );
      }
      throw AppException.validation(`Битрикс: ${e.message}`);
    }
    throw e as Error;
  }

  async listProjects(tenantId: string, cid: string) {
    const { client } = await this.clientFor(tenantId, cid);
    try {
      const groups = await client.groups();
      return groups.map((g: any) => ({ externalId: String(g.ID ?? g.id), name: String(g.NAME ?? g.name ?? 'Проект') }));
    } catch (e) {
      this.translate(e);
    }
  }

  async startImport(tenantId: string, actorId: string, cid: string, projectExternalIds: string[], includeGeneralFeed = false) {
    const ids = (projectExternalIds ?? []).map(String);
    if (!ids.length && !includeGeneralFeed) throw AppException.validation('Выберите хотя бы один проект или общую ленту');
    const { webhookUrl } = await this.clientFor(tenantId, cid);
    const run = await this.repo.createRun(tenantId, cid, { projectExternalIds: ids, includeGeneralFeed });
    // запуск в фоне (in-process); статус — через GET /runs/:id
    void this.importer.run({
      tenantId, connectionId: cid, webhookUrl, projectExternalIds: ids, runId: run!.id, actorId, includeGeneralFeed,
    });
    return { runId: run!.id, status: 'queued' };
  }

  /** Предпросмотр ИИ-раскладки внегрупповых задач по импортированным проектам (ничего не пишет). */
  async analyzeUngrouped(tenantId: string, cid: string) {
    const { client } = await this.clientFor(tenantId, cid);
    const projects = await this.repo.importedProjects(tenantId, cid);
    let raw: any[];
    try {
      raw = await client.ungroupedTasks();
    } catch (e) {
      this.translate(e);
    }
    const tasks = raw.map((t: any) => ({
      externalId: String(t.id ?? t.ID),
      title: String(t.title ?? t.TITLE ?? 'Без названия'),
      description: String(t.description ?? t.DESCRIPTION ?? ''),
    }));
    const routing = await this.importer.classifyUngrouped(
      tenantId, tasks, projects.map((p) => ({ id: p.id, name: p.name })),
    );
    return {
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
      tasks: tasks.map((t) => {
        const r = routing.get(t.externalId);
        return {
          externalId: t.externalId,
          title: t.title,
          suggestedProjectId: r?.projectId ?? null,
          confidence: r?.confidence ?? 0,
        };
      }),
    };
  }

  /** Применяет подтверждённую раскладку внегрупповых задач (фоновый run, прогресс через GET /runs/:id). */
  async applyUngrouped(tenantId: string, actorId: string, cid: string, assignments: { externalId: string; projectId?: string | null }[]) {
    if (!assignments?.length) throw AppException.validation('Нет задач для раскладки');
    const { webhookUrl } = await this.clientFor(tenantId, cid);
    const run = await this.repo.createRun(tenantId, cid, { ungrouped: assignments.length });
    void this.importer.applyUngrouped({ tenantId, connectionId: cid, webhookUrl, runId: run!.id, actorId, assignments });
    return { runId: run!.id, status: 'queued' };
  }

  async getRun(tenantId: string, runId: string) {
    const run = await this.repo.getRun(tenantId, runId);
    if (!run) throw AppException.notFound('Запуск импорта не найден');
    return run;
  }

  async unmatchedUsers(tenantId: string, cid: string) {
    const { client } = await this.clientFor(tenantId, cid);
    const emailMap = await this.repo.userEmailMap(tenantId);
    const mapped = await this.repo.userRefs(cid);
    let users: any[];
    try {
      users = await client.users();
    } catch (e) {
      this.translate(e);
    }
    return users
      .filter((u: any) => {
        const extId = String(u.ID ?? u.id);
        const email = String(u.EMAIL ?? u.email ?? '').toLowerCase();
        return !mapped.has(extId) && (!email || !emailMap.has(email));
      })
      .map((u: any) => ({
        externalId: String(u.ID ?? u.id),
        name: [u.NAME ?? u.name, u.LAST_NAME ?? u.lastName].filter(Boolean).join(' ').trim() || String(u.ID ?? u.id),
        email: String(u.EMAIL ?? u.email ?? ''),
      }));
  }

  async mapUser(tenantId: string, cid: string, externalUserId: string, localUserId: string) {
    const conn = await this.repo.getConnection(tenantId, cid);
    if (!conn) throw AppException.notFound('Подключение не найдено');
    if (!(await this.repo.userExists(tenantId, localUserId))) throw AppException.validation('Пользователь не найден в организации');
    await this.repo.putRef({ tenantId, connectionId: cid, entityType: 'user', externalId: String(externalUserId), localId: localUserId });
    return { mapped: true };
  }

  /** Диагностика подключения: права вебхука + что реально отдаёт портал (для разбора «пусто»). */
  async diagnostics(tenantId: string, cid: string) {
    const { client } = await this.clientFor(tenantId, cid);
    const errMsg = (e: unknown) => (e instanceof BitrixError ? e.message : (e as Error).message || 'ошибка');
    const out: {
      scopes: string[]; scopesError: string | null;
      ungrouped: { count: number | null; error: string | null };
      feed: { count: number | null; error: string | null };
      groups: { count: number | null; error: string | null };
    } = {
      scopes: [], scopesError: null,
      ungrouped: { count: null, error: null },
      feed: { count: null, error: null },
      groups: { count: null, error: null },
    };

    try { out.scopes = await client.scope(); } catch (e) { out.scopesError = errMsg(e); }
    try { out.ungrouped.count = (await client.ungroupedTasks()).length; } catch (e) { out.ungrouped.error = errMsg(e); }
    try {
      const r = await client.call<any>('log.blogpost.get', {});
      out.feed.count = Array.isArray(r) ? r.length : Object.values(r ?? {}).length;
    } catch (e) { out.feed.error = errMsg(e); }
    try { out.groups.count = (await client.groups()).length; } catch (e) { out.groups.error = errMsg(e); }

    return out;
  }

  async importedMessages(tenantId: string, projectId: string) {
    if (!(await this.repo.projectInTenant(tenantId, projectId))) throw AppException.notFound('Проект не найден');
    return this.repo.listMessages(tenantId, projectId);
  }
}
