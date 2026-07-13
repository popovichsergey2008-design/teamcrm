import { Body, Controller, Post } from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { PromptsService } from './prompts.service';

class FeedbackDto {
  @IsString() promptVersionId!: string;
  @IsIn([1, -1]) rating!: number;          // 👍 = 1, 👎 = -1
  @IsOptional() @IsBoolean() reworked?: boolean;
}

/**
 * Аудит качества промптов (PromptOps P2): 👍/👎 под ответом ИИ.
 * Доступно всем внутренним ролям — оценивают пользователи Brain, не только админы.
 */
@ApiTags('prompts')
@ApiBearerAuth()
@Controller('prompt-feedback')
@Roles('owner', 'manager', 'member')
export class PromptFeedbackController {
  constructor(private readonly prompts: PromptsService) {}

  @Post()
  submit(@CurrentUser() u: AuthUser, @Body() dto: FeedbackDto) {
    return this.prompts.submitFeedback(u.tenantId, u.userId, dto);
  }
}
