import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { join } from 'path';
import { Public } from '../../common/auth/decorators';
import { AppException } from '../../common/http/app-exception';

/**
 * Скриншоты справочника (#4879): QEVO Bot вставляет их в ответ строкой
 * `![подпись](/api/help/img/06-board.webp)`, окно бота показывает картинку.
 *
 * Открыты без входа: это снимки демо-пространства, те же, что в справке на сайте.
 * Имя — только из букв, цифр и дефиса: никаких путей наружу из папки.
 */
@ApiTags('knowledge')
@Controller('help/img')
export class HelpImageController {
  /** Та же глубина, что у справочника: `dist|src/modules/knowledge` → `handbook/img`. */
  private readonly dir = join(__dirname, '..', '..', '..', 'handbook', 'img');

  @Public()
  @Get(':name')
  async image(@Param('name') name: string, @Res() res: Response) {
    if (!/^[a-z0-9-]{1,80}\.webp$/.test(name)) throw AppException.notFound('Картинки нет');
    const path = join(this.dir, name);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) throw AppException.notFound('Картинки нет');
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Content-Length', String(st.size));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    createReadStream(path).pipe(res);
  }
}
