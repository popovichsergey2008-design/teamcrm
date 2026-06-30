import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { PositionsRepository } from './positions.repository';

class PositionDto {
  @IsString() @MinLength(1) @MaxLength(96) name!: string;
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

  @Delete(':id')
  @Roles('owner', 'manager')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.repo.remove(user.tenantId, id);
    return { deleted: true };
  }
}
