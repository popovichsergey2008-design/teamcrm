import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

/**
 * Журнал созвонов (#4892, п. 0): любой созвон QEVO попадает в календарь — и встреча,
 * и начатый сразу из чата. Запись открывается с первым сотрудником в комнате и
 * закрывается, когда комната опустела. Ошибки журнала созвон не трогают.
 */
@Injectable()
export class CallLogService {
  constructor(private readonly db: DbService) {}

  async joined(tenantId: string, roomId: string, chatId: string | null, userId: string): Promise<void> {
    await this.db.query(
      `WITH upd AS (
         UPDATE call_log SET participant_ids = (SELECT array_agg(DISTINCT x) FROM unnest(participant_ids || ARRAY[$4::bigint]) x)
          WHERE tenant_id = $1 AND room_id = $2 AND ended_at IS NULL RETURNING id)
       INSERT INTO call_log (tenant_id, room_id, chat_id, started_by, participant_ids)
       SELECT $1, $2, $3, $4, ARRAY[$4::bigint] WHERE NOT EXISTS (SELECT 1 FROM upd)`,
      [tenantId, roomId.slice(0, 64), chatId, userId],
    ).catch(() => undefined);
  }

  async ended(tenantId: string, roomId: string): Promise<void> {
    await this.db.query(`UPDATE call_log SET ended_at = now() WHERE tenant_id = $1 AND room_id = $2 AND ended_at IS NULL`, [tenantId, roomId.slice(0, 64)])
      .catch(() => undefined);
  }
}
