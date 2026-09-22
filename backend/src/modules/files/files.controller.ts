import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
  Body,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags, ApiConsumes } from '@nestjs/swagger';
import { Response } from 'express';
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
  async download(@CurrentUser() user: AuthUser, @Param('id') id: string, @Res() res: Response) {
    const { file, stream } = await this.files.getForDownload(user.tenantId, id);
    /*
      Показываем в окне браузера только то, что безопасно показать. SVG — это документ
      со скриптами внутри: открытый по нашему адресу, он получил бы и наши cookie.
      Картинки и PDF смотрят как есть, остальное скачивается.
    */
    const inline = (file.content_type.startsWith('image/') && file.content_type !== 'image/svg+xml')
      || file.content_type === 'application/pdf';
    res.setHeader('Content-Type', file.content_type);
    res.setHeader('Content-Length', file.size_bytes);
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
