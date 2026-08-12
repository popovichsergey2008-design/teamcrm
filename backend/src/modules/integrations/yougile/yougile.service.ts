import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AppException } from '../../../common/http/app-exception';
import { IntegrationCryptoService } from '../crypto.service';
import { YougileRepository } from './yougile.repository';
import { YougileImportService } from './yougile.import.service';
import { YougileClient } from './yougile.client';

/** YouGile: подключение по API-ключу, список досок для импорта, запуск импорта, прогресс. */
@Injectable()
export class YougileService {
  constructor(
    private readonly repo: YougileRepository,
    private readonly crypto: IntegrationCryptoService,
    private readonly importer: YougileImportService,
  ) {}

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
}
