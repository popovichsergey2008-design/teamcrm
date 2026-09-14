import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { RealtimeService } from '../realtime/realtime.service';

export type ManualStatus = 'busy' | 'away' | null;

/**
 * Присутствие людей — то, что Chat Bar пишет под именем.
 *
 * «В сети» — сокет живой (память RealtimeService). «Был 12 минут назад» — время
 * последнего соединения, пишем в базу при входе и выходе: если писать при каждом
 * запросе, база получала бы обновление на каждый чих. «Занят» / «отошёл» — только
 * руками (решение заказчика: автоматики по бездействию не нужно). «На мите» здесь
 * не хранится — это живые созвоны, их знает медиа-модуль.
 */
@Injectable()
export class PresenceService {
  constructor(private readonly db: DbService, private readonly realtime: RealtimeService) {}

  /** Отметка «был здесь» — при входе и при выходе сокета. Ошибки глотаем: это не то, ради чего рвать соединение. */
  async touch(tenantId: string, userId: string): Promise<void> {
    try {
      await this.db.query(`UPDATE users SET last_seen_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, userId]);
    } catch { /* журнал присутствия — не критичный путь */ }
  }

  /** Сводка по компании: кто в сети, кого когда видели, кто что о себе поставил. */
  async snapshot(tenantId: string) {
    const rows = await this.db.many<{ id: string; last_seen_at: Date | null; presence_status: string | null }>(
      `SELECT id, last_seen_at, presence_status FROM users WHERE tenant_id = $1 AND is_active`,
      [tenantId],
    );
    const online = new Set(this.realtime.onlineUsers(tenantId));
    return rows.map((r) => ({
      userId: String(r.id),
      online: online.has(String(r.id)),
      lastSeenAt: r.last_seen_at,
      status: (r.presence_status as ManualStatus) ?? null,
    }));
  }

  /**
   * Свой статус. Знают о нём все в компании сразу: «занят» ставят ровно затем,
   * чтобы к тебе не шли — значит, увидеть это должны раньше, чем напишут.
   */
  async setStatus(tenantId: string, userId: string, status: ManualStatus) {
    if (status !== null && status !== 'busy' && status !== 'away') {
      throw AppException.validation('Статус — «занят», «отошёл» или ничего');
    }
    await this.db.query(
      `UPDATE users SET presence_status = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, userId, status],
    );
    this.realtime.emitToTenant(tenantId, 'user.status.changed', { userId, status });
    return { status };
  }
}
