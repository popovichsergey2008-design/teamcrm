import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { EconomicsProducer } from '../economics/economics.producer';
import { RatesRepository } from './rates.repository';

class CreateRateDto {
  @IsString()
  userId!: string;

  @IsNumber()
  @Min(0)
  hourlyRate!: number;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  effectiveFrom?: string; // ISO; по умолчанию now()
}

@ApiTags('rates')
@ApiBearerAuth()
@Controller('rates')
@Roles('owner', 'manager') // ставки — финансовая настройка
export class RatesController {
  constructor(
    private readonly repo: RatesRepository,
    private readonly economics: EconomicsProducer,
  ) {}

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateRateDto) {
    let row;
    try {
      row = await this.repo.create({
        tenantId: user.tenantId,
        userId: dto.userId,
        hourlyRate: dto.hourlyRate,
        currency: dto.currency ?? 'RUB',
        effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date(),
      });
    } catch (e) {
      if ((e as Error).message === 'USER_NOT_IN_TENANT') throw AppException.notFound('User not found');
      throw e;
    }
    // смена ставки → пересчёт всех задач пользователя
    await this.economics.enqueue({
      kind: 'recompute_on_rate_change',
      tenantId: user.tenantId,
      userId: dto.userId,
      reason: 'rate_changed',
      dedupKey: `rate:${dto.userId}`,
    });
    return row;
  }

  @Get('user/:userId')
  list(@CurrentUser() user: AuthUser, @Param('userId') userId: string) {
    return this.repo.list(user.tenantId, userId);
  }
}
