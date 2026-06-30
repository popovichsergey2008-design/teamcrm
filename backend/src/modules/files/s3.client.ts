import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/** S3-клиент к MinIO. forcePathStyle обязателен для MinIO. */
@Injectable()
export class S3Service implements OnModuleInit {
  private readonly logger = new Logger('S3');
  readonly client: S3Client;
  readonly bucket: string;

  constructor(config: ConfigService) {
    const endpoint = config.get<string>('MINIO_ENDPOINT') ?? 'http://crm-minio:9000';
    this.bucket = config.get<string>('MINIO_BUCKET') ?? 'teamcrm';
    this.client = new S3Client({
      endpoint,
      region: config.get<string>('MINIO_REGION') ?? 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.get<string>('MINIO_ROOT_USER') ?? 'minioadmin',
        secretAccessKey: config.get<string>('MINIO_ROOT_PASSWORD') ?? 'minioadmin',
      },
    });
  }

  async onModuleInit() {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
        this.logger.log(`bucket ${this.bucket} created`);
      } catch (e) {
        this.logger.warn(`bucket ensure failed: ${(e as Error).message}`);
      }
    }
  }
}
