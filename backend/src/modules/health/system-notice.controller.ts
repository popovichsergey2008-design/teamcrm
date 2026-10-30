import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/decorators';
import { DbService } from '../../database/db.service';

/**
 * Объявление для всех пользователей (техработы, обновление): плашка сверху у всех компаний.
 * Открыто без входа — его показывают и на экране входа. Ставит техотдел (platform/notice).
 */
@ApiTags('system')
@Controller('system')
export class SystemNoticeController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Get('notice')
  async notice() {
    return this.db.one<{ id: string; text: string; level: string; ends_at: Date }>(
      `SELECT id::text, text, level, ends_at FROM system_notices
        WHERE starts_at <= now() AND ends_at > now() ORDER BY id DESC LIMIT 1`,
    );
  }
}
