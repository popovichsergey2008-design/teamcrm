import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { PositionsRepository } from './positions.repository';

class PositionDto {
  @IsString() @MinLength(1) @MaxLength(96) name!: string;
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
      return await this.repo.create(user.tenantId, dto.name.trim());
    } catch (e: any) {
      if (e?.code === '23505') throw AppException.conflict('Должность с таким названием уже есть');
      throw e;
    }
  }

  @Patch(':id')
  @Roles('owner', 'manager')
  async rename(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: PositionDto) {
    const row = await this.repo.rename(user.tenantId, id, dto.name.trim());
    if (!row) throw AppException.notFound('Position not found');
    return row;
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
