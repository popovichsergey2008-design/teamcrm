import { ProjectViewer } from '../../common/access/project-visibility';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { AppException } from '../../common/http/app-exception';
import { S3Service } from './s3.client';
import { FileRow, FilesRepository } from './files.repository';
import { decodeUploadName, sanitizeFileName, validateUpload } from './files.validation';

@Injectable()
export class FilesService {
  private readonly playSecret: string;

  constructor(
    private readonly s3: S3Service,
    private readonly repo: FilesRepository,
    config: ConfigService,
  ) {
    // свой ключ подписи, выведенный из секрета токенов: ссылка проигрывания — не токен входа
    this.playSecret = createHmac('sha256', config.get<string>('JWT_ACCESS_SECRET') ?? 'dev').update('file-play').digest('hex');
  }

  /**
   * Короткоживущая ссылка на проигрывание (ТЗ-25, §29–31): плееру браузера нужен адрес,
   * по которому он сам перемотает и подкачает кусок, — заголовок с токеном он не пошлёт.
   * Права проверяет вызывающий ДО выдачи; ссылка живёт минуты и ведёт к одному файлу.
   */
  signPlay(tenantId: string, fileId: string, ttlSec = 600): { url: string; expiresAt: string } {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const sig = this.playSig(tenantId, fileId, exp);
    return { url: `/api/files/play/${fileId}?t=${tenantId}&e=${exp}&s=${sig}`, expiresAt: new Date(exp * 1000).toISOString() };
  }

  verifyPlay(tenantId: string, fileId: string, exp: number, sig: string): boolean {
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
    const want = Buffer.from(this.playSig(tenantId, fileId, exp));
    const got = Buffer.from(String(sig ?? ''));
    return want.length === got.length && timingSafeEqual(want, got);
  }

  private playSig(tenantId: string, fileId: string, exp: number): string {
    return createHmac('sha256', this.playSecret).update(`${tenantId}.${fileId}.${exp}`).digest('base64url');
  }

  /** Убрать файл без проверки прав человека: служебная уборка (отозванный фрагмент задачи). */
  async removeInternal(tenantId: string, id: string): Promise<void> {
    const file = await this.repo.findById(tenantId, id);
    if (!file) return;
    await this.s3.client.send(new DeleteObjectCommand({ Bucket: this.s3.bucket, Key: file.object_key })).catch(() => undefined);
    await this.repo.delete(tenantId, id);
  }

  async upload(input: {
    tenantId: string;
    userId: string;
    buffer: Buffer;
    fileName: string;
    contentType: string;
    ownerKind?: string;
    ownerId?: string | null;
    /** Записи встреч заметно тяжелее обычных вложений — лимит задаётся вызывающим. */
    maxBytes?: number;
  }): Promise<FileRow> {
    const v = validateUpload(input.contentType, input.buffer.length, input.maxBytes, input.fileName);
    if (!v.ok) throw AppException.validation(v.reason);

    const safeName = sanitizeFileName(decodeUploadName(input.fileName));
    const objectKey = `${input.tenantId}/${randomUUID()}/${safeName}`;

    await this.s3.client.send(
      new PutObjectCommand({
        Bucket: this.s3.bucket,
        Key: objectKey,
        Body: input.buffer,
        ContentType: input.contentType,
        ContentLength: input.buffer.length,
      }),
    );

    return this.repo.create({
      tenantId: input.tenantId,
      objectKey,
      fileName: safeName,
      contentType: input.contentType,
      sizeBytes: input.buffer.length,
      ownerKind: input.ownerKind ?? 'generic',
      ownerId: input.ownerId ?? null,
      uploadedBy: input.userId,
    });
  }

  /** Метаданные + поток объекта (access-control по tenant — в контроллере/здесь). */
  /** Проверка доступа к файлу по его владельцу — см. FilesRepository.canDownload. */
  canDownload(tenantId: string, id: string, viewer: ProjectViewer): Promise<boolean> {
    return this.repo.canDownload(tenantId, id, viewer);
  }

  async getForDownload(tenantId: string, id: string, range?: { start: number; end: number } | null): Promise<{ file: FileRow; stream: Readable }> {
    const file = await this.repo.findById(tenantId, id);
    if (!file) throw AppException.notFound('File not found');
    const res = await this.s3.client.send(
      new GetObjectCommand({ Bucket: this.s3.bucket, Key: file.object_key, ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}) }),
    );
    return { file, stream: res.Body as Readable };
  }

  async delete(tenantId: string, id: string, user: { userId: string; role: string }): Promise<void> {
    const file = await this.repo.findById(tenantId, id);
    if (!file) throw AppException.notFound('File not found');
    const canDelete = file.uploaded_by === user.userId || user.role === 'owner' || user.role === 'manager';
    if (!canDelete) throw AppException.forbidden('Not allowed to delete this file');
    await this.s3.client.send(new DeleteObjectCommand({ Bucket: this.s3.bucket, Key: file.object_key }));
    await this.repo.delete(tenantId, id);
  }

  meta(tenantId: string, id: string) {
    return this.repo.findById(tenantId, id);
  }
}
