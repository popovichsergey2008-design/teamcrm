import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { AppException } from '../../common/http/app-exception';
import { S3Service } from './s3.client';
import { FileRow, FilesRepository } from './files.repository';
import { decodeUploadName, sanitizeFileName, validateUpload } from './files.validation';

@Injectable()
export class FilesService {
  constructor(
    private readonly s3: S3Service,
    private readonly repo: FilesRepository,
  ) {}

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
  async getForDownload(tenantId: string, id: string): Promise<{ file: FileRow; stream: Readable }> {
    const file = await this.repo.findById(tenantId, id);
    if (!file) throw AppException.notFound('File not found');
    const res = await this.s3.client.send(
      new GetObjectCommand({ Bucket: this.s3.bucket, Key: file.object_key }),
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
