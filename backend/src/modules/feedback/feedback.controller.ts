import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { FeedbackService } from './feedback.service';

class NpsDto {
  @Type(() => Number) @IsInt() @Min(0) @Max(10) score!: number;
  @IsOptional() @IsString() @MaxLength(2000) improve?: string;
  @IsOptional() @IsString() @MaxLength(3000) review?: string;
  @IsOptional() @IsBoolean() consent?: boolean;
}
class ReviewDto {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(120) position?: string;
  @IsOptional() @IsString() @MaxLength(160) company?: string;
  @IsString() @MaxLength(3000) text!: string;
  @IsOptional() @Matches(/^\d{1,18}$/) photoFileId?: string | null;
  @IsBoolean() consent!: boolean;
}

/** Оценка «Порекомендовали бы QEVO коллеге?» и отзывы для сайта (ТЗ 10.11). */
@ApiTags('feedback')
@ApiBearerAuth()
@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /** Пора ли спросить оценку; «да» — отметка ставится сразу (не чаще раза в 60 дней). */
  @Get('nps')
  due(@CurrentUser() u: AuthUser) { return this.feedback.due(u); }

  @Post('nps')
  answer(@CurrentUser() u: AuthUser, @Body() dto: NpsDto) { return this.feedback.answer(u, dto); }

  @Post('review')
  review(@CurrentUser() u: AuthUser, @Body() dto: ReviewDto) { return this.feedback.review(u, dto); }
}
