import { Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { GdocsService } from './gdocs.service';

@ApiTags('integrations/gdocs')
@ApiBearerAuth()
@Controller('integrations/gdocs')
@Roles('owner', 'manager')
export class GdocsController {
  constructor(private readonly gdocs: GdocsService) {}

  /** Сканировать задачи/комментарии на ссылки Google Docs/Sheets и проиндексировать доступные в базу знаний. */
  @Post('scan')
  scan(@CurrentUser() u: AuthUser) {
    return this.gdocs.scan(u.tenantId);
  }

  @Get('status')
  status(@CurrentUser() u: AuthUser) {
    return this.gdocs.getStatus(u.tenantId);
  }
}
