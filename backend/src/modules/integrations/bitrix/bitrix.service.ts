import { Injectable } from '@nestjs/common';
import { AppException } from '../../../common/http/app-exception';
import { IntegrationCryptoService } from '../crypto.service';
import { BitrixClient } from './bitrix.client';
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
      webhookEnc: this.crypto.encrypt(webhookUrl), createdBy: actorId,
    });
    return { id: conn.id, portal, label: conn.label, isActive: true };
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

  async listProjects(tenantId: string, cid: string) {
    const { client } = await this.clientFor(tenantId, cid);
    const groups = await client.groups();
    return groups.map((g: any) => ({ externalId: String(g.ID ?? g.id), name: String(g.NAME ?? g.name ?? 'Проект') }));
  }

  async startImport(tenantId: string, actorId: string, cid: string, projectExternalIds: string[]) {
    if (!projectExternalIds?.length) throw AppException.validation('Выберите хотя бы один проект');
    const { webhookUrl } = await this.clientFor(tenantId, cid);
    const run = await this.repo.createRun(tenantId, cid, { projectExternalIds });
    // запуск в фоне (in-process); статус — через GET /runs/:id
    void this.importer.run({
      tenantId, connectionId: cid, webhookUrl, projectExternalIds: projectExternalIds.map(String), runId: run!.id, actorId,
    });
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
    const users = await client.users();
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

  async importedMessages(tenantId: string, projectId: string) {
    if (!(await this.repo.projectInTenant(tenantId, projectId))) throw AppException.notFound('Проект не найден');
    return this.repo.listMessages(tenantId, projectId);
  }
}
