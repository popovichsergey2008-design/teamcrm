import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { ChatsService } from '../chats/chats.service';
import { callNote, outcomeOf } from './call-note';

/**
 * Журнал созвонов (#4892, п. 0): любой созвон QEVO попадает в календарь — и встреча,
 * и начатый сразу из чата. Запись открывается с первым сотрудником в комнате и
 * закрывается, когда комната опустела. Ошибки журнала созвон не трогают.
 */
@Injectable()
export class CallLogService {
  private readonly log = new Logger('CallLog');

  constructor(private readonly db: DbService, private readonly chats: ChatsService) {}

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

  /**
   * Комната опустела. #4907: если звонили из чата — запись о звонке туда же, от имени
   * звонившего: «Звонок шёл 5 минут 14 секунд · дата», а не дождались ответа —
   * «Пропущенный звонок» (у вызванного это непрочитанное сообщение: отошёл за кофе,
   * вернулся — видно, что звонили) или «Звонок отклонён».
   */
  async ended(tenantId: string, roomId: string, call?: { chatId: string | null; startedBy: string | null; rang: boolean; declined: boolean }): Promise<void> {
    const row = await this.db.one<{ chat_id: string | null; started_by: string | null; started_at: Date; participants: number }>(
      `UPDATE call_log SET ended_at = now() WHERE tenant_id = $1 AND room_id = $2 AND ended_at IS NULL
        RETURNING chat_id::text, started_by::text, started_at, cardinality(participant_ids) AS participants`,
      [tenantId, roomId.slice(0, 64)]).catch(() => null);
    const chatId = row?.chat_id ?? call?.chatId ?? null;
    const caller = row?.started_by ?? call?.startedBy ?? null;
    if (!row || !chatId || !caller) return;
    const outcome = outcomeOf(Number(row.participants), !!call?.declined);
    // никого не звали и никто не пришёл — это не звонок, а открытая и закрытая комната
    if (outcome !== 'done' && !call?.rang && !call?.declined) return;
    try {
      const u = await this.db.one<{ code: string; tz: string | null }>(
        `SELECT r.code, u.timezone AS tz FROM users u JOIN roles r ON r.id = u.role_id WHERE u.tenant_id = $1 AND u.id = $2`, [tenantId, caller]);
      if (!u) return;
      const sec = (Date.now() - new Date(row.started_at).getTime()) / 1000;
      await this.chats.send(tenantId, chatId, { userId: caller, role: u.code }, callNote(outcome, new Date(row.started_at), sec, u.tz || 'Europe/Moscow'), null);
    } catch (e) {
      this.log.warn(`запись о звонке в чат ${chatId}: ${(e as Error).message}`);
    }
  }
}
