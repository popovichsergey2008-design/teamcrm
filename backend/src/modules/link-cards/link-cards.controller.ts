import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { LinkCardsService } from './link-cards.service';

class ResolveLinksDto {
  /** Ссылки из видимых сообщений ленты; порядок ответа — тот же. */
  @IsArray() @ArrayMaxSize(60) @IsString({ each: true }) @MaxLength(2048, { each: true })
  urls!: string[];
}

/**
 * Живые карточки ссылок в чатах (#4902, п. 3). POST, а не GET: ссылок в ленте
 * десятки, и в строку запроса они не помещаются. Клиентскому порталу не нужно —
 * карточки рисует переписка сотрудников.
 */
@ApiTags('chats')
@ApiBearerAuth()
@Controller('link-cards')
@Roles('owner', 'manager', 'member')
export class LinkCardsController {
  constructor(private readonly svc: LinkCardsService) {}

  @Post()
  @HttpCode(200)
  resolve(@CurrentUser() u: AuthUser, @Body() dto: ResolveLinksDto) {
    return this.svc.resolve(u.tenantId, { userId: u.userId, role: u.role }, dto.urls);
  }
}
