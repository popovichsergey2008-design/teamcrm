import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Public } from '../../common/auth/decorators';
import { AppException } from '../../common/http/app-exception';
import { LeadsService } from './leads.service';

export const MOVE_FROM = ['bitrix24', 'yougile', 'jira', 'trello', 'other'] as const;
export const TEAM_SIZES = ['1-5', '6-15', '16-50', '50+'] as const;

class LeadDto {
  @IsIn(['quiz', 'exit']) source!: 'quiz' | 'exit';
  @IsOptional() @IsIn(MOVE_FROM as unknown as string[]) from?: string;
  @IsOptional() @IsIn(TEAM_SIZES as unknown as string[]) team?: string;
  @IsString() @MinLength(3) @MaxLength(120) contact!: string;
  @IsOptional() @IsString() @MaxLength(300) page?: string;
  /** Ловушка для ботов: поле спрятано на странице, человек его не заполнит. */
  @IsOptional() @IsString() @MaxLength(200) website?: string;
}

/** Заявки с рекламной страницы — без входа, поэтому с ограничением по адресу. */
@ApiTags('leads')
@Controller('public/leads')
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Public()
  @Post()
  @HttpCode(201)
  async create(@Body() dto: LeadDto, @Ip() ip: string) {
    if (dto.website) return { ok: true };
    if (!this.leads.allow(ip)) throw new AppException('RATE_LIMITED', 'Слишком много заявок, попробуйте позже');
    await this.leads.create({ ...dto, ip });
    return { ok: true };
  }
}
