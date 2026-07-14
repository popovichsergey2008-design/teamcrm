import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../../common/auth/decorators';
import { AuthUser } from '../../../common/auth/jwt.types';
import { BitrixService } from './bitrix.service';
import { ApplyUngroupedDto, ConnectBitrixDto, ImportBitrixDto, MapUserDto } from './bitrix.dto';

@ApiTags('integrations/bitrix')
@ApiBearerAuth()
@Controller('integrations/bitrix')
@Roles('owner') // подключение внешних систем — только владелец
export class BitrixController {
  constructor(private readonly bitrix: BitrixService) {}

  @Post('connections')
  connect(@CurrentUser() u: AuthUser, @Body() dto: ConnectBitrixDto) {
    return this.bitrix.connect(u.tenantId, u.userId, dto.webhookUrl, dto.label);
  }

  @Get('connections')
  list(@CurrentUser() u: AuthUser) {
    return this.bitrix.listConnections(u.tenantId);
  }

  @Delete('connections/:cid')
  disconnect(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.bitrix.disconnect(u.tenantId, cid);
  }

  @Get('connections/:cid/projects')
  projects(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.bitrix.listProjects(u.tenantId, cid);
  }

  @Post('connections/:cid/import')
  import(@CurrentUser() u: AuthUser, @Param('cid') cid: string, @Body() dto: ImportBitrixDto) {
    return this.bitrix.startImport(u.tenantId, u.userId, cid, dto.projectExternalIds ?? [], dto.includeGeneralFeed ?? false);
  }

  // ИИ-раскладка внегрупповых задач: предпросмотр → подтверждение
  @Post('connections/:cid/ungrouped/analyze')
  analyzeUngrouped(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.bitrix.analyzeUngrouped(u.tenantId, cid);
  }

  @Post('connections/:cid/ungrouped/apply')
  applyUngrouped(@CurrentUser() u: AuthUser, @Param('cid') cid: string, @Body() dto: ApplyUngroupedDto) {
    return this.bitrix.applyUngrouped(u.tenantId, u.userId, cid, dto.assignments);
  }

  @Get('connections/:cid/unmatched-users')
  unmatched(@CurrentUser() u: AuthUser, @Param('cid') cid: string) {
    return this.bitrix.unmatchedUsers(u.tenantId, cid);
  }

  @Post('connections/:cid/user-map')
  mapUser(@CurrentUser() u: AuthUser, @Param('cid') cid: string, @Body() dto: MapUserDto) {
    return this.bitrix.mapUser(u.tenantId, cid, dto.externalUserId, dto.localUserId);
  }

  @Get('runs/:id')
  run(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.bitrix.getRun(u.tenantId, id);
  }

  // Лента импортированного проекта — доступна и не-владельцам (метод переопределяет @Roles класса)
  @Get('projects/:pid/messages')
  @Roles('owner', 'manager', 'member')
  messages(@CurrentUser() u: AuthUser, @Param('pid') pid: string) {
    return this.bitrix.importedMessages(u.tenantId, pid);
  }
}
