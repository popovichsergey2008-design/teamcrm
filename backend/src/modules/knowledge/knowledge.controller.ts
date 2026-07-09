import { Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { KnowledgeService } from './knowledge.service';
import { RegulationsService } from './regulations.service';

class RegulationDto {
  @IsString() @MinLength(1) @MaxLength(255) title!: string;
  @IsString() @MinLength(1) body!: string;
}
class SearchDto {
  @IsString() @MinLength(2) q!: string;
  @IsOptional() @IsString() k?: string;
  @IsOptional() @IsString() projectId?: string;
}

@ApiTags('knowledge')
@ApiBearerAuth()
@Controller()
@Roles('owner', 'manager', 'member') // база знаний — внутренняя; client не имеет доступа
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly regulations: RegulationsService,
  ) {}

  @Get('knowledge/search')
  search(@CurrentUser() u: AuthUser, @Query() dto: SearchDto) {
    if (!dto.q || dto.q.trim().length < 2) throw AppException.validation('Слишком короткий запрос');
    const k = Math.min(Math.max(Number(dto.k) || 8, 1), 20);
    return this.knowledge.search(u.tenantId, dto.q.trim(), k, dto.projectId || undefined);
  }

  @Get('knowledge/stats')
  stats(@CurrentUser() u: AuthUser) {
    return this.knowledge.stats(u.tenantId);
  }

  @Post('knowledge/reindex')
  @Roles('owner', 'manager')
  reindex(@CurrentUser() u: AuthUser) {
    return this.knowledge.backfill(u.tenantId);
  }

  // ── регламенты ──
  @Get('regulations')
  listRegs(@CurrentUser() u: AuthUser) {
    return this.regulations.list(u.tenantId);
  }

  @Get('regulations/:id')
  getReg(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.regulations.get(u.tenantId, id);
  }

  @Post('regulations')
  @Roles('owner', 'manager')
  createReg(@CurrentUser() u: AuthUser, @Body() dto: RegulationDto) {
    return this.regulations.create(u.tenantId, u.userId, dto.title, dto.body);
  }

  @Put('regulations/:id')
  @Roles('owner', 'manager')
  updateReg(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: RegulationDto) {
    return this.regulations.update(u.tenantId, id, dto.title, dto.body);
  }

  @Delete('regulations/:id')
  @Roles('owner', 'manager')
  deleteReg(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.regulations.remove(u.tenantId, id);
  }
}
