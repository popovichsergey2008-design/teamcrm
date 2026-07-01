import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Шифрование секретов интеграций (вебхук-URL Битрикса) для хранения в БД.
 * AES-256-GCM; ключ — из INTEGRATION_ENC_KEY, иначе производный от JWT_ACCESS_SECRET
 * (чтобы не требовать нового секрета в CI/деве). Формат: base64(iv|tag|ciphertext).
 */
@Injectable()
export class IntegrationCryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const secret =
      config.get<string>('INTEGRATION_ENC_KEY') || config.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.key = createHash('sha256').update(secret).digest(); // ровно 32 байта
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  decrypt(payload: string): string {
    const raw = Buffer.from(payload, 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  }
}
