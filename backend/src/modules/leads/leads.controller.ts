import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Allow, IsBoolean, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Public } from '../../common/auth/decorators';
import { AppException } from '../../common/http/app-exception';
import { LeadsService, siteExtra } from './leads.service';

export const MOVE_FROM = ['bitrix24', 'yougile', 'jira', 'trello', 'other'] as const;
export const TEAM_SIZES = ['1-5', '6-15', '16-50', '50+'] as const;
/** Что прислать (#4648): видео работы приложения или план переезда. */
export const WANTS = ['video', 'plan'] as const;

class LeadDto {
  /*
    #4863: сайт на WordPress шлёт заявки своим форматом (форма, квиз, отзыв, Qevo-бот):
    source — quiz | exit | support | review | chatbot_support | chatbot_signup_request | …,
    «откуда» и «команда» — свободным текстом. Принимаем всё это, а лишнее не пускаем.
  */
  @IsString() @Matches(/^[a-z_]{2,40}$/) source!: string;
  @IsOptional() @IsString() @MaxLength(200) from?: string;
  @IsOptional() @IsString() @MaxLength(100) team?: string;
  @IsOptional() @IsIn(WANTS as unknown as string[]) want?: 'video' | 'plan';
  @IsOptional() @IsString() @MaxLength(180) contact?: string;
  @IsOptional() @IsString() @MaxLength(400) page?: string;
  /** Вопрос из «Проверьте нас за 30 секунд» (#4616) — уходит дежурным сразу. */
  @IsOptional() @IsString() @MaxLength(4000) message?: string;
  /** Ловушка для ботов: поле спрятано на странице, человек его не заполнит. */
  @IsOptional() @IsString() @MaxLength(200) website?: string;
  // поля формы сайта и Qevo-бота
  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(200) topic?: string;
  @IsOptional() @IsString() @MaxLength(30) team_bucket?: string;
  @IsOptional() @IsString() @MaxLength(180) email?: string;
  @IsOptional() @IsString() @MaxLength(120) workspace?: string;
  @IsOptional() @IsString() @MaxLength(60) team_size?: string;
  @IsOptional() @IsString() @MaxLength(120) current_tool?: string;
  @IsOptional() @IsString() @MaxLength(120) role?: string;
  @IsOptional() @IsString() @MaxLength(120) volume?: string;
  @IsOptional() @IsBoolean() consent_terms?: boolean;
  @IsOptional() @IsBoolean() consent_pd?: boolean;
  @IsOptional() @IsString() @MaxLength(40) consented_at?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
  @IsOptional() @IsBoolean() publication_consent?: boolean;
  @IsOptional() @IsString() @MaxLength(40) time?: string;
  @IsOptional() @IsString() @MaxLength(60) timezone?: string;
  @IsOptional() @IsString() @MaxLength(40) client_time?: string;
  /** Переписка с Qevo-ботом, метки, калькулятор — что прислал сайт; в текст берём коротко. */
  @IsOptional() @Allow() conversation?: unknown;
  @IsOptional() @Allow() attribution?: unknown;
  @IsOptional() @Allow() calc?: unknown;
  @IsOptional() @Allow() context?: unknown;
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
    const contact = (dto.contact ?? '').trim() || (dto.email ?? '').trim();
    if (contact.length < 3) throw AppException.validation('Укажите ник Telegram, номер WhatsApp или почту');
    await this.leads.create({ ...siteLead(dto), contact, ip });
    return { ok: true };
  }
}

/** Поля сайта → заявка: известные «откуда»/«команда» как есть, остальное — строками в текст. */
function siteLead(d: LeadDto) {
  const from = d.from && (MOVE_FROM as readonly string[]).includes(d.from) ? d.from : d.from || d.current_tool || undefined;
  const team = d.team || d.team_size || d.team_bucket || undefined;
  return {
    source: d.source, from, team, want: d.want, page: d.page,
    message: d.message,
    extra: siteExtra({
      name: d.name, topic: d.topic, email: d.email, workspace: d.workspace, role: d.role, volume: d.volume,
      rating: d.rating, publicationConsent: d.publication_consent, conversation: d.conversation,
    }),
  };
}

/**
 * Заявки сайта на WordPress (#4863): сайт шлёт на `<api_base>leads` и смотрит только на
 * код ответа 2xx. api_base сайта — https://app.qevo.one/api/public/site/.
 */
@ApiTags('leads')
@Controller('public/site/leads')
export class SiteLeadsController extends LeadsController {}
