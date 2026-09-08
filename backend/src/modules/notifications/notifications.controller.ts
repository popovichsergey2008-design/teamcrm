import { Body, Controller, Get, Put, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsString } from 'class-validator';
import type { Response } from 'express';
import { CurrentUser, Public, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { NotificationsRepository } from './notifications.repository';
import {
  EVENT_TITLE, EventKey, FEED_ANNOUNCEMENT_KEY, FEED_ANNOUNCEMENT_TITLE,
  FEED_MENTION_KEY, FEED_MENTION_TITLE, MIRROR_EVENT_KEY, MIRROR_EVENT_TITLE,
  OWN_EVENT_KEY, OWN_EVENT_TITLE,
} from './mail.templates';

/**
 * Виды писем в интерфейсе: три события, переключатель «и о моих действиях»
 * и дубль в мессенджер. Последний живёт в этом же списке, потому что отписка
 * по ссылке из письма обязана выключать все каналы разом — иначе человек нажал
 * «отписаться», а сообщения продолжают приходить.
 */
const EVENT_KEYS = Object.keys(EVENT_TITLE) as EventKey[];
const ALL_KEYS: string[] = [
  ...EVENT_KEYS, FEED_ANNOUNCEMENT_KEY, FEED_MENTION_KEY, OWN_EVENT_KEY, MIRROR_EVENT_KEY,
];
const TITLE: Record<string, string> = {
  ...EVENT_TITLE,
  [FEED_ANNOUNCEMENT_KEY]: FEED_ANNOUNCEMENT_TITLE,
  [FEED_MENTION_KEY]: FEED_MENTION_TITLE,
  [OWN_EVENT_KEY]: OWN_EVENT_TITLE,
  [MIRROR_EVENT_KEY]: MIRROR_EVENT_TITLE,
};

class PrefDto {
  @IsString() @IsIn(ALL_KEYS) eventKey!: string;
  @IsBoolean() enabled!: boolean;
}

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly repo: NotificationsRepository) {}

  /** Настройки писем. Строки в базе может не быть — тогда действует значение по умолчанию. */
  @Get('prefs')
  @ApiBearerAuth()
  @Roles('owner', 'manager', 'member')
  async prefs(@CurrentUser() u: AuthUser) {
    const saved = new Map((await this.repo.listPrefs(u.tenantId, u.userId)).map((p) => [p.event_key, p.enabled]));
    return ALL_KEYS.map((key) => ({
      eventKey: key,
      title: TITLE[key],
      enabled: saved.get(key) ?? true,
    }));
  }

  @Put('prefs')
  @ApiBearerAuth()
  @Roles('owner', 'manager', 'member')
  async setPref(@CurrentUser() u: AuthUser, @Body() dto: PrefDto) {
    await this.repo.setPref(u.tenantId, u.userId, dto.eventKey, dto.enabled);
    return { ok: true };
  }

  /**
   * Отписка по ссылке из письма — без входа в систему: человек может читать почту
   * с телефона, где он не авторизован, и требовать логин ради отписки нельзя.
   * Отвечаем страницей, а не JSON: ссылку открывают в браузере.
   */
  @Get('unsubscribe')
  @Public()
  async unsubscribe(@Query('token') token: string, @Res() res: Response) {
    const ok = token ? await this.repo.unsubscribeByToken(String(token), ALL_KEYS) : false;
    const text = ok
      ? 'Письма отключены. Включить обратно можно в личном кабинете TEAMCRM.'
      : 'Ссылка недействительна. Настройки писем есть в личном кабинете TEAMCRM.';
    res.status(ok ? 200 : 404).type('html').send(
      `<!doctype html><meta charset="utf-8"><title>TEAMCRM</title>`
      + `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:60px auto;font-size:15px;line-height:1.5">`
      + `<p style="font-size:18px;font-weight:600">TEAMCRM</p><p>${text}</p></div>`,
    );
  }
}
