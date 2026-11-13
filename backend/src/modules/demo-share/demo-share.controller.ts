import { Body, Controller, Get, HttpCode, Ip, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Allow, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import { Public } from '../../common/auth/decorators';
import { demoPage, notFoundPage } from './demo-share.rules';
import { DemoShareService } from './demo-share.service';

class ShareDto {
  @IsString() @MaxLength(2000) message!: string;
  /** Карточка из демо: название, проект, исполнитель, срок, чек-лист, приоритет. Чистит сервис. */
  @Allow() task!: unknown;
  /** Ловушка для ботов. */
  @IsOptional() @IsString() @MaxLength(200) website?: string;
}

/**
 * «Отправить коллеге» с главной qevo.one (#4863). Страница и картинка открываются на
 * qevo.one/demo/<код> — nginx проксирует сюда. Закрыты от индексации.
 */
@ApiTags('demo-share')
@Controller('public/demo-shares')
export class DemoShareController {
  constructor(private readonly svc: DemoShareService) {}

  @Public()
  @Post()
  @HttpCode(201)
  create(@Body() dto: ShareDto, @Ip() ip: string) {
    if (dto.website) return { code: '', url: '' };
    return this.svc.create(dto, ip);
  }

  @Public()
  @Get(':code/page')
  async page(@Param('code') code: string, @Res() res: Response) {
    const d = await this.svc.get(code);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.status(d ? 200 : 404).send(d ? demoPage(d) : notFoundPage());
  }

  @Public()
  @Get(':code/og.png')
  async og(@Param('code') code: string, @Res() res: Response) {
    const png = await this.svc.og(code);
    if (!png) { res.status(404).end(); return; }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(png);
  }
}
