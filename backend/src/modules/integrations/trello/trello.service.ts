import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../../common/http/app-exception';
import { IntegrationCryptoService } from '../crypto.service';
import { TrelloRepository } from './trello.repository';
import { TrelloImportService } from './trello.import.service';
import { TrelloClient } from './trello.client';

/**
 * Trello: подключение по паре «ключ + токен», выбор досок, импорт.
 *
 * Почему не OAuth-приложение: для переезда нужен доступ ОДНОГО человека к СВОИМ
 * доскам, и он получает ключ с токеном за минуту, не дожидаясь администратора
 * рабочего пространства. Приложение понадобится, когда появится двусторонняя
 * синхронизация — тогда и заведём.
 */
@Injectable()
export class TrelloService {
  private readonly log = new Logger('Trello');

  constructor(
    private readonly repo: TrelloRepository,
    private readonly crypto: IntegrationCryptoService,
    private readonly importer: TrelloImportService,
  ) {}

  /** Секрет хранится одной строкой «ключ:токен» — двух полей в таблице для этого не нужно. */
  private pack(key: string, token: string): string {
    return `${key}:${token}`;
  }
  private unpack(secret: string): { key: string; token: string } {
    const at = secret.indexOf(':');
    return at < 0 ? { key: secret, token: '' } : { key: secret.slice(0, at), token: secret.slice(at + 1) };
  }

  private async credsFor(tenantId: string, cid: string) {
    const conn = await this.repo.getConnection(tenantId, cid);
    if (!conn) throw AppException.notFound('Подключение не найдено');
    return { conn, ...this.unpack(this.crypto.decrypt(conn.webhook_enc)) };
  }

  /**
   * Подключение. Ключ проверяем СРАЗУ запросом «кто я»: сохранить нерабочую пару и
   * узнать об этом на импорте — потерять время человека дважды.
   */
  async connect(tenantId: string, userId: string, key: string, token: string, label?: string) {
    const me = await new TrelloClient(key, token).me().catch((e) => {
      throw AppException.validation((e as Error).message);
    });
    const conn = await this.repo.createConnection({
      tenantId,
      label: (label ?? '').trim() || `Trello · ${me.fullName || me.username}`,
      portal: me.username ? `@${me.username}` : null,
      secretEnc: this.crypto.encrypt(this.pack(key, token)),
      createdBy: userId,
    });
    return { id: conn.id, label: conn.label, portal: conn.portal, account: me.fullName };
  }

  listConnections(tenantId: string) {
    return this.repo.listConnections(tenantId);
  }

  async disconnect(tenantId: string, cid: string) {
    await this.repo.deleteConnection(tenantId, cid);
    return { disconnected: true };
  }

  /** Доски аккаунта. Архивные помечаем, но показываем: в них тоже бывает работа. */
  async listBoards(tenantId: string, cid: string) {
    const { key, token } = await this.credsFor(tenantId, cid);
    const boards = await new TrelloClient(key, token).boards();
    return boards.map((b) => ({ id: String(b.id), name: b.name, closed: !!b.closed, url: b.url ?? null }));
  }

  /** Запуск импорта: отвечаем сразу, работа идёт в фоне и видна в журнале прогона. */
  async startImport(tenantId: string, userId: string, cid: string, boardIds: string[]) {
    if (!boardIds.length) throw AppException.validation('Выберите хотя бы одну доску');
    const { conn, key, token } = await this.credsFor(tenantId, cid);
    const run = await this.repo.createRun(tenantId, cid, { boardIds });
    void this.importer.run({
      tenantId, connectionId: conn.id, key, token, boardIds,
      runId: run!.id, actorId: userId,
    });
    return { runId: run!.id };
  }

  async runStatus(tenantId: string, runId: string) {
    const run = await this.repo.getRun(tenantId, runId);
    if (!run) throw AppException.notFound('Прогон не найден');
    return run;
  }

  /**
   * Кого из участников досок мы не опознали.
   *
   * Считаем на лету, а не храним: список меняется от каждой правки в команде, и
   * хранимая копия успевала бы устареть между двумя нажатиями.
   */
  async unmatchedUsers(tenantId: string, cid: string) {
    const { key, token } = await this.credsFor(tenantId, cid);
    const client = new TrelloClient(key, token);
    const boards = await client.boards();
    const seen = new Map<string, string>();
    // по всем доскам сразу: человек привязывает людей один раз, а не на каждую доску
    for (const b of boards.slice(0, 30)) {
      try {
        for (const m of await client.members(String(b.id))) seen.set(String(m.id), m.fullName || m.username);
      } catch { /* доска недоступна — не повод рушить весь список */ }
    }
    const [manual, byEmail, byName] = await Promise.all([
      this.repo.userRefs(cid), this.repo.userEmailMap(tenantId), this.repo.userNameMap(tenantId),
    ]);
    const items: { externalId: string; name: string }[] = [];
    for (const [id, name] of seen) {
      if (manual.get(id)) continue;
      const key2 = name.toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
      if (byName.get(key2)) continue;
      if (byEmail.get(name.toLowerCase())) continue;
      items.push({ externalId: id, name });
    }
    return { total: items.length, items: items.slice(0, 200) };
  }

  /**
   * Ручная привязка человека Trello к нашему сотруднику.
   *
   * Хеши задач сбрасываем: они считаются по данным Trello, а привязка живёт у нас, и
   * без сброса исполнитель доехал бы только до новых карточек.
   */
  async mapUser(tenantId: string, cid: string, externalUserId: string, localUserId: string) {
    const conn = await this.repo.getConnection(tenantId, cid);
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
