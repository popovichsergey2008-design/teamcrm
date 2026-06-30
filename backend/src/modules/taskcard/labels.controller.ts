import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { TaskCardRepository } from './taskcard.repository';

class LabelDto {
  @IsString() @MinLength(1) @MaxLength(48) name!: string;
  @IsOptional() @IsString() @MaxLength(16) color?: string;
}

@ApiTags('labels')
@ApiBearerAuth()
@Controller('labels')
@Roles('owner', 'manager', 'member')
export class LabelsController {
  constructor(private readonly repo: TaskCardRepository) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.repo.listLabels(u.tenantId);
  }

  @Post()
  @Roles('owner', 'manager')
  async create(@CurrentUser() u: AuthUser, @Body() dto: LabelDto) {
    try {
      return await this.repo.createLabel(u.tenantId, dto.name.trim(), dto.color ?? '#5b8cff');
    } catch (e: any) {
      if (e?.code === '23505') throw AppException.conflict('Метка с таким названием уже есть');
      throw e;
    }
  }

  @Delete(':id')
  @Roles('owner', 'manager')
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.repo.deleteLabel(u.tenantId, id);
    return { deleted: true };
  }
}
