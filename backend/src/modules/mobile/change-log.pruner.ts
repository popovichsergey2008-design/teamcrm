import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CHANGE_LOG_RETENTION_DAYS, ChangeLogRepository } from './change-log.repository';

import { runsBackground } from '../../common/process-role';
/**
 * Уборка журнала изменений: записи старше срока хранения — раз в час.
 * Клиент с более старым курсором получит `reset` и перечитает всё.
 */
@Injectable()
export class ChangeLogPruner implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ChangeLogPruner');
  private timer?: NodeJS.Timeout;

  constructor(private readonly changes: ChangeLogRepository) {}

  onModuleInit() {
    if (!runsBackground()) return; // фоновая работа — только в главном процессе (common/process-role)
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), 3600_000);
    this.timer.unref?.();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    try {
      const n = await this.changes.prune();
      if (n) this.log.log(`журнал изменений: убрано ${n} записей старше ${CHANGE_LOG_RETENTION_DAYS} дн.`);
    } catch (e) {
      this.log.warn(`уборка журнала не удалась: ${(e as Error).message}`);
    }
  }
}
