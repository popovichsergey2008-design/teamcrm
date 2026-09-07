import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { GdocsService } from './gdocs.service';

class AddLinksDto {
  /** Хоть список ссылок, хоть кусок переписки — вытащим адреса сами. */
  @IsString()
  @MaxLength(20000)
  text!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  projectId?: string;
}

/**
 * Google-документы — слой 4 «переезда в один клик».
 *
 * Работает без OAuth: читаются документы, открытые «по ссылке», через публичный
 * экспорт Google. Это сознательная граница — OAuth-приложение требует проверки со
 * стороны Google и согласия администратора домена, а переезд нужен сегодня.
 */
@ApiTags('integrations/gdocs')
@ApiBearerAuth()
@Controller('integrations/gdocs')
@Roles('owner', 'manager')
export class GdocsController {
  constructor(private readonly gdocs: GdocsService) {}

  /** Найти ссылки на Google-доки в задачах, комментариях и переписке — и прочитать их. */
  @Post('scan')
  scan(@CurrentUser() u: AuthUser) {
    return this.gdocs.scan(u.tenantId);
  }

  /** Принести документы ссылками: сканер видит только то, на что уже сослались. */
  @Post('links')
  addLinks(@CurrentUser() u: AuthUser, @Body() dto: AddLinksDto) {
    return this.gdocs.addLinks(u.tenantId, dto.text, dto.projectId);
  }

  @Get('status')
  status(@CurrentUser() u: AuthUser) {
    return this.gdocs.getStatus(u.tenantId);
  }

  /** Список документов с причинами: непрочитанные идут первыми — с ними и надо работать. */
  @Get('list')
  list(@CurrentUser() u: AuthUser) {
    return this.gdocs.list(u.tenantId);
  }
}
