import { Body, Controller, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { STARTER_SPHERES, StarterSphere } from './starter-plan';
import { StarterService } from './starter.service';

class AnswerDto {
  @IsIn(['sphere', 'team']) step!: 'sphere' | 'team';
  @IsString() @MaxLength(500) text!: string;
}

class StarterDto {
  @IsIn(STARTER_SPHERES) sphere!: StarterSphere;
  /** Что человек сказал или написал вместо кнопки — в описание проекта. */
  @IsOptional() @IsString() @MaxLength(500) sphereText?: string;
  @IsString() @MaxLength(120) name!: string;
  @IsBoolean() team!: boolean;
}

/**
 * Qevo-бот при первом входе (#4620): создаёт первый проект по трём ответам.
 *
 * Сотруднику тоже: проект в QEVO может завести любой сотрудник (см. POST /projects),
 * а первый вход у него такой же, как у владельца. Заказчику (client) — нет.
 */
@ApiTags('onboarding')
@ApiBearerAuth()
@Controller('onboarding/starter')
@Roles('owner', 'manager', 'member')
export class StarterController {
  constructor(private readonly starter: StarterService) {}

  /** Ответ словами (голос или текст) вместо кнопки — какая сфера, один или с командой. */
  @Post('answer')
  answer(@Body() dto: AnswerDto) {
    return this.starter.understand(dto.step, dto.text);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: StarterDto) {
    return this.starter.create({ tenantId: u.tenantId, userId: u.userId }, dto);
  }
}
