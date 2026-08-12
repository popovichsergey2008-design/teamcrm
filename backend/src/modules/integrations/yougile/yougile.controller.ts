import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../../common/auth/decorators';
import { AuthUser } from '../../../common/auth/jwt.types';
import { YougileService } from './yougile.service';
import { ConnectYougileDto, ImportYougileDto } from './yougile.dto';

/** Интеграция с YouGile (E1): подключение по ключу + импорт досок/колонок/задач. Только владелец. */
@ApiTags('integrations/yougile')
@ApiBearerAuth()
@Controller('integrations/yougile')
@Roles('owner')
export class YougileController {
  constructor(private readonly yougile: YougileService) {}

  @Post('connections')
  connect(@CurrentUser() u: AuthUser, @Body() dto: ConnectYougileDto) {
    return this.yougile.connect(u.tenantId, u.userId, dto.apiKey, dto.label);
  }

  @Get('connections')
  list(@CurrentUser() u: AuthUser) {
    return this.yougile.listConnections(u.tenantId);
  }

  @Delete('connections/:cid')
  disconnect(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.yougile.disconnect(u.tenantId, cid);
  }

  @Get('connections/:cid/boards')
  boards(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.yougile.listBoards(u.tenantId, cid);
  }

  @Post('connections/:cid/import')
  import(@CurrentUser() u: AuthUser, @Param('cid') cid: string, @Body() dto: ImportYougileDto) {
    return this.yougile.startImport(u.tenantId, u.userId, cid, dto.boardExternalIds ?? []);
  }

  @Get('runs/:id')
  run(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.yougile.getRun(u.tenantId, id);
  }
}
