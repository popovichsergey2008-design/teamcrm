import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { LEVELS } from '../org/org-rules';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { PositionsRepository } from './positions.repository';

class PositionDto {
  @IsString() @MinLength(1) @MaxLength(96) name!: string;
  /** #4615: уровень иерархии — по нему подбор понимает, кто руководит. */
  @IsOptional() @IsIn(LEVELS as unknown as string[]) level?: string;
}

class UpdatePositionDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(96) name?: string;
  @IsOptional() @IsIn(LEVELS as unknown as string[]) level?: string;
}

class ReorderDto {
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) ids!: string[];
}

class NewsRightDto {
  @IsBoolean() canPostNews!: boolean;
}

@ApiTags('positions')
@ApiBearerAuth()
@Controller('positions')
@Roles('owner', 'manager', 'member')
export class PositionsController {
  constructor(private readonly repo: PositionsRepository) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.repo.list(user.tenantId);
  }

  @Post()
  @Roles('owner', 'manager')
  async create(@CurrentUser() user: AuthUser, @Body() dto: PositionDto) {
    try {
      return await this.repo.create(user.tenantId, dto.name.trim(), dto.level ?? 'specialist');
    } catch (e: any) {
      if (e?.code === '23505') throw AppException.conflict('Должность с таким названием уже есть');
      throw e;
    }
  }

  /** Порядок списка должностей (перетаскивание или стрелки). */
  @Post('reorder')
  @Roles('owner', 'manager')
  async reorder(@CurrentUser() user: AuthUser, @Body() dto: ReorderDto) {
    await this.repo.reorder(user.tenantId, dto.ids.filter((x) => /^\d+$/.test(String(x))));
    return this.repo.list(user.tenantId);
  }

  @Patch(':id')
  @Roles('owner', 'manager')
  async rename(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdatePositionDto) {
    try {
      const row = await this.repo.update(user.tenantId, id, { name: dto.name?.trim() || undefined, level: dto.level });
      if (!row) throw AppException.notFound('Position not found');
      return row;
    } catch (e: any) {
      if (e?.code === '23505') throw AppException.conflict('Должность с таким названием уже есть');
      throw e;
    }
  }

  /**
   * Кому доверено публиковать новости компании.
   *
   * Раздаёт владелец: лента компании — это издание, а не общая стена, и решать, у кого
   * есть право голоса от имени компании, должен тот, кто за компанию отвечает.
   */
  @Patch(':id/news-right')
  @Roles('owner')
  async newsRight(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: NewsRightDto) {
    const row = await this.repo.setCanPostNews(user.tenantId, id, dto.canPostNews);
    if (!row) throw AppException.notFound('Position not found');
    return row;
  }

  @Delete(':id')
  @Roles('owner', 'manager')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.repo.remove(user.tenantId, id);
    return { deleted: true };
  }
}
