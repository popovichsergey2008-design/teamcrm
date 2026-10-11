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
class MemoryDto {
  @IsString() @MinLength(2) @MaxLength(500) q!: string;
  @IsOptional() @IsString() types?: string;
  @IsOptional() @IsString() projectId?: string;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsString() authorId?: string;
  @IsOptional() @IsString() k?: string;
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
    return this.knowledge.search(u.tenantId, dto.q.trim(), k, dto.projectId || undefined, undefined, { userId: u.userId, role: u.role });
  }

  /** «Вторая память» (ТЗ-21): по смыслу и словам, фильтры типа, проекта, периода и автора. */
  @Get('knowledge/memory')
  memory(@CurrentUser() u: AuthUser, @Query() dto: MemoryDto) {
    const date = (v?: string) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v) : null);
    return this.knowledge.memory(u.tenantId, dto.q.trim(), { userId: u.userId, role: u.role }, {
      types: dto.types ? dto.types.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12) : undefined,
      projectId: dto.projectId || null, from: date(dto.from), to: date(dto.to), authorId: dto.authorId || null,
    }, Math.min(Math.max(Number(dto.k) || 10, 1), 30));
  }

  @Get('knowledge/stats')
  stats(@CurrentUser() u: AuthUser) {
    return this.knowledge.stats(u.tenantId);
  }

  // ── просмотр содержимого базы ──
  @Get('knowledge/sources')
  sources(
    @CurrentUser() u: AuthUser,
    @Query('projectId') projectId?: string,
    @Query('type') type?: string,
    @Query('q') q?: string,
    @Query('offset') offset?: string,
  ) {
    return this.knowledge.listSources(u.tenantId, {
      projectId: projectId || undefined, type: type || undefined, q: q?.trim() || undefined, offset: Number(offset) || 0,
      viewer: { userId: u.userId, role: u.role },
    });
  }

  @Get('knowledge/sources/:type/:id')
  async sourceContent(@CurrentUser() u: AuthUser, @Param('type') type: string, @Param('id') id: string) {
    if (!(await this.knowledge.canOpenSource(u.tenantId, type, id, { userId: u.userId, role: u.role }))) throw AppException.notFound('Источник не найден');
    const r = await this.knowledge.sourceContent(u.tenantId, type, id);
    if (!r) throw AppException.notFound('Источник не найден');
    return r;
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
