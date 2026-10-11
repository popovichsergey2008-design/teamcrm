import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags, ApiConsumes } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { CurrentUser, Roles } from '../../common/auth/decorators';
import { AuthUser } from '../../common/auth/jwt.types';
import { AppException } from '../../common/http/app-exception';
import { FilesService } from './files.service';

@ApiTags('files')
@ApiBearerAuth()
@Controller('files')
@Roles('owner', 'manager', 'member') // внутренние роли; client-доступ — на этапе портала
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: { ownerKind?: string; ownerId?: string },
  ) {
    if (!file) throw AppException.validation('file is required (multipart field "file")');
    const row = await this.files.upload({
      tenantId: user.tenantId,
      userId: user.userId,
      buffer: file.buffer,
      fileName: file.originalname,
      contentType: file.mimetype,
      ownerKind: body?.ownerKind,
      ownerId: body?.ownerId ?? null,
    });
    return {
      id: row.id,
      fileName: row.file_name,
      contentType: row.content_type,
      sizeBytes: Number(row.size_bytes),
    };
  }

  @Get(':id')
  async download(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    // файл закрытого проекта, чужой переписки или записи чужого созвона — «не найден» (ТЗ-21, этап 0)
    if (!(await this.files.canDownload(user.tenantId, id, { userId: user.userId, role: user.role }))) {
      throw AppException.notFound('File not found');
    }
    /*
      Докачка и перемотка (ТЗ-21): запись встречи на час — десятки мегабайт, и проигрыватель
      просит кусок с нужной секунды, а не весь файл. Один диапазон `bytes=a-b` — 206.
    */
    const meta = await this.files.meta(user.tenantId, id);
    const size = Number(meta?.size_bytes ?? 0);
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
    const { file, stream } = await this.files.getForDownload(user.tenantId, id, range);
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    }
    /*
      Показываем в окне браузера только то, что безопасно показать. SVG — это документ
      со скриптами внутри: открытый по нашему адресу, он получил бы и наши cookie.
      Картинки и PDF смотрят как есть, остальное скачивается.
    */
    const inline = (file.content_type.startsWith('image/') && file.content_type !== 'image/svg+xml')
      || file.content_type === 'application/pdf';
    res.setHeader('Content-Type', file.content_type);
    res.setHeader('Content-Length', range ? range.end - range.start + 1 : file.size_bytes);
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(file.file_name)}"`,
    );
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.files.delete(user.tenantId, id, { userId: user.userId, role: user.role });
    return { deleted: true };
  }
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n` → границы; несколько диапазонов не поддерживаем — отдаём целиком. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header || !size) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  let start: number;
  let end: number;
  if (m[1] === '' && m[2] === '') return null;
  if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}
