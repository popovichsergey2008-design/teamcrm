import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../../common/http/app-exception';
import { IntegrationCryptoService } from '../crypto.service';
import { ImportRepository } from '../common/import.repository';
import { NotionImportService } from './notion.import.service';
import { NotionClient } from './notion.client';
import { databaseName, pickStatusProperty } from './notion.map';

/** Имя источника в общих таблицах интеграций. */
const PROVIDER = 'notion';

/**
 * Notion: подключение по токену внутренней интеграции, выбор баз, импорт.
 *
 * Главная тонкость всего Notion — доступ. Токен сам по себе не даёт видеть НИЧЕГО:
 * интеграции нужно отдельно дать доступ к каждой базе через «Connections». Поэтому
 * пустой список баз — не ошибка, а самое частое состояние, и говорить о нём надо
 * человеческим языком, иначе человек решит, что сломан импорт.
 */
@Injectable()
export class NotionService {
  private readonly log = new Logger('Notion');

  constructor(
    private readonly repo: ImportRepository,
    private readonly crypto: IntegrationCryptoService,
    private readonly importer: NotionImportService,
  ) {}

  private async tokenFor(tenantId: string, cid: string) {
    const conn = await this.repo.getConnection(tenantId, cid, PROVIDER);
    if (!conn) throw AppException.notFound('Подключение не найдено');
    return { conn, token: this.crypto.decrypt(conn.webhook_enc) };
  }

  /** Токен проверяем сразу: сохранить нерабочий и узнать об этом на импорте — потерять время дважды. */
  async connect(tenantId: string, userId: string, token: string, label?: string) {
    const me = await new NotionClient(token).me().catch((e) => {
      throw AppException.validation((e as Error).message);
    });
    const workspace = me.bot?.workspace_name ?? '';
    const conn = await this.repo.createConnection({
      provider: PROVIDER,
      tenantId,
      label: (label ?? '').trim() || `Notion${workspace ? ` · ${workspace}` : ''}`,
      portal: workspace || null,
      secretEnc: this.crypto.encrypt(token),
      createdBy: userId,
    });
    return { id: conn.id, label: conn.label, portal: conn.portal };
  }

  listConnections(tenantId: string) {
    return this.repo.listConnections(tenantId, PROVIDER);
  }

  async disconnect(tenantId: string, cid: string) {
    await this.repo.deleteConnection(tenantId, cid);
    return { disconnected: true };
  }

  /**
   * Базы, доступные интеграции. Пустой список — это почти всегда «не дали доступ»,
   * и подсказка об этом уезжает вместе с ответом.
   */
  async listDatabases(tenantId: string, cid: string) {
    const { token } = await this.tokenFor(tenantId, cid);
    const dbs = await new NotionClient(token).databases();
    return {
      items: dbs.map((d) => ({
        id: String(d.id),
        name: databaseName(d),
        // сразу показываем, по какому свойству получатся колонки: это главный вопрос
        statusProperty: pickStatusProperty(d),
        url: d.url ?? null,
      })),
      hint: dbs.length === 0
        ? 'Notion не показал ни одной базы. Откройте нужную базу в Notion → «…» → Connections → добавьте свою интеграцию.'
        : null,
    };
  }

  async startImport(tenantId: string, userId: string, cid: string, databaseIds: string[]) {
    if (!databaseIds.length) throw AppException.validation('Выберите хотя бы одну базу');
    const { conn, token } = await this.tokenFor(tenantId, cid);
    const run = await this.repo.createRun(tenantId, cid, { databaseIds });
    void this.importer.run({
      tenantId, connectionId: conn.id, token, databaseIds, runId: run!.id, actorId: userId,
    });
    return { runId: run!.id };
  }

  async runStatus(tenantId: string, runId: string) {
    const run = await this.repo.getRun(tenantId, runId);
    if (!run) throw AppException.notFound('Прогон не найден');
    return run;
  }

  /** Кого из людей Notion мы не опознали — их привязывают руками. */
  async unmatchedUsers(tenantId: string, cid: string) {
    const { token } = await this.tokenFor(tenantId, cid);
    const [users, manual, byEmail, byName] = await Promise.all([
      new NotionClient(token).users(),
      this.repo.userRefs(cid),
      this.repo.userEmailMap(tenantId),
      this.repo.userNameMap(tenantId),
    ]);
    const items = users
      .filter((u) => {
        if (manual.get(String(u.id))) return false;
        const email = (u.person?.email ?? '').toLowerCase();
        if (email && byEmail.get(email)) return false;
        const key = String(u.name ?? '').toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
        return !(key && byName.get(key));
      })
      .map((u) => ({ externalId: String(u.id), name: u.name ?? '—', email: u.person?.email ?? '' }));
    return { total: items.length, items: items.slice(0, 200) };
  }

  /** Ручная привязка. Хеши задач сбрасываем — иначе исполнитель доедет только до новых страниц. */
  async mapUser(tenantId: string, cid: string, externalUserId: string, localUserId: string) {
    const conn = await this.repo.getConnection(tenantId, cid, PROVIDER);
    if (!conn) throw AppException.notFound('Подключение не найдено');
    if (!(await this.repo.userExists(tenantId, localUserId))) throw AppException.notFound('Сотрудник не найден');
    await this.repo.putRef({
      tenantId, connectionId: cid, entityType: 'user',
      externalId: String(externalUserId), localId: localUserId,
    });
    const reset = await this.repo.resetTaskHashes(cid);
    return { mapped: true, tasksToRefresh: reset };
  }
}
