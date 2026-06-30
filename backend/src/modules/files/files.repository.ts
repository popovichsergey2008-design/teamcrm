import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface FileRow {
  id: string;
  tenant_id: string;
  object_key: string;
  file_name: string;
  content_type: string;
  size_bytes: string;
  owner_kind: string;
  owner_id: string | null;
  uploaded_by: string;
  created_at: Date;
}

@Injectable()
export class FilesRepository {
  constructor(private readonly db: DbService) {}

  create(input: {
    tenantId: string;
    objectKey: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    ownerKind: string;
    ownerId: string | null;
    uploadedBy: string;
  }): Promise<FileRow> {
    return this.db.one<FileRow>(
      `INSERT INTO files (tenant_id, object_key, file_name, content_type, size_bytes, owner_kind, owner_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        input.tenantId,
        input.objectKey,
        input.fileName,
        input.contentType,
        input.sizeBytes,
        input.ownerKind,
        input.ownerId,
        input.uploadedBy,
      ],
    ) as Promise<FileRow>;
  }

  findById(tenantId: string, id: string): Promise<FileRow | null> {
    return this.db.one<FileRow>(`SELECT * FROM files WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }

  async delete(tenantId: string, id: string): Promise<void> {
    await this.db.query(`DELETE FROM files WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
  }
}
