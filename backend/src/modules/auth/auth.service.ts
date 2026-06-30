import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHash, randomUUID } from 'crypto';

import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import {
  AccessTokenPayload,
  RoleCode,
} from '../../common/auth/jwt.types';
import { TenantsRepository } from '../tenants/tenants.repository';
import { UsersRepository, UserRow } from '../users/users.repository';
import { PublicUser, toPublicUser } from '../users/users.service';
import { RefreshTokenRepository } from './refresh-token.repository';
import { LoginDto, RegisterDto } from './auth.dto';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SessionMeta {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly tenants: TenantsRepository,
    private readonly users: UsersRepository,
    private readonly refreshTokens: RefreshTokenRepository,
  ) {}

  /** Регистрация: создаёт tenant + owner-пользователя в одной транзакции. */
  async register(dto: RegisterDto, meta?: SessionMeta): Promise<{ user: PublicUser } & TokenPair> {
    const passwordHash = await argon2.hash(dto.password);
    const region = dto.dataRegion ?? 'eu';

    const user = await this.db.withTransaction(async (client) => {
      const tenant = await this.tenants.create(dto.tenantName, region, client);
      const exists = await client.query(
        'SELECT 1 FROM users WHERE tenant_id = $1 AND email = $2',
        [tenant.id, dto.email],
      );
      if (exists.rowCount) throw AppException.conflict('Email already registered');
      const res = await client.query<UserRow>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role_id)
         SELECT $1, $2, $3, $4, r.id FROM roles r WHERE r.code = 'owner'
         RETURNING *, (SELECT code FROM roles WHERE code='owner') AS role_code`,
        [tenant.id, dto.email, passwordHash, dto.fullName],
      );
      return res.rows[0];
    });

    const tokens = await this.issueTokens(user, meta);
    return { user: toPublicUser(user), ...tokens };
  }

  async login(dto: LoginDto, meta?: SessionMeta): Promise<{ user: PublicUser } & TokenPair> {
    const user = dto.tenantId
      ? await this.users.findByEmail(dto.tenantId, dto.email)
      : await this.users.findByEmailGlobal(dto.email);
    if (!user || !user.is_active) throw AppException.unauthorized('Invalid credentials');

    const ok = await argon2.verify(user.password_hash, dto.password);
    if (!ok) throw AppException.unauthorized('Invalid credentials');

    const tokens = await this.issueTokens(user, meta);
    return { user: toPublicUser(user), ...tokens };
  }

  /** Ротация: проверяет refresh, отзывает старый, выдаёт новую пару. */
  async refresh(refreshToken: string, meta?: SessionMeta): Promise<TokenPair> {
    let payload: { sub: string; tenantId: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw AppException.unauthorized('Invalid refresh token');
    }

    const hash = this.sha256(refreshToken);
    const row = await this.refreshTokens.findActiveByHash(hash);
    if (!row) throw AppException.unauthorized('Refresh token revoked or expired');

    const user = await this.users.findById(payload.tenantId, payload.sub);
    if (!user || !user.is_active) throw AppException.unauthorized('User inactive');

    await this.refreshTokens.revoke(row.id);
    return this.issueTokens(user, meta);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.refreshTokens.revokeByHash(this.sha256(refreshToken));
  }

  private async issueTokens(user: UserRow, meta?: SessionMeta): Promise<TokenPair> {
    const accessTtl = Number(this.config.get('JWT_ACCESS_TTL') ?? 900);
    const refreshTtl = Number(this.config.get('JWT_REFRESH_TTL') ?? 2_592_000);

    // refresh-токен и его строку создаём ПЕРВЫМИ — id строки кладём в access как sid
    const jti = randomUUID();
    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, tenantId: user.tenant_id, jti },
      { secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'), expiresIn: refreshTtl },
    );
    const expiresAt = new Date(Date.now() + refreshTtl * 1000);
    const row = await this.refreshTokens.create(user.id, this.sha256(refreshToken), expiresAt, meta);

    const accessPayload: AccessTokenPayload = {
      sub: user.id,
      tenantId: user.tenant_id,
      role: user.role_code as RoleCode,
      email: user.email,
      sid: row.id,
    };
    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      expiresIn: accessTtl,
    });

    return { accessToken, refreshToken, expiresIn: accessTtl };
  }

  private sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
