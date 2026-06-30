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
import { AccountsRepository } from './accounts.repository';
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

export interface OrgRef {
  tenantId: string;
  name: string;
  role: string;
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
    private readonly accounts: AccountsRepository,
  ) {}

  private orgRefs(rows: any[]): OrgRef[] {
    return rows.map((m) => ({ tenantId: m.tenant_id, name: m.tenant_name, role: m.role_code }));
  }

  /**
   * Регистрация: создаёт ГЛОБАЛЬНЫЙ аккаунт + первую организацию + owner-членство.
   * E-mail уникален глобально (одна личность = один аккаунт).
   */
  async register(dto: RegisterDto, meta?: SessionMeta): Promise<{ user: PublicUser; organizations: OrgRef[] } & TokenPair> {
    if (await this.accounts.findByEmail(dto.email)) {
      throw AppException.conflict('Пользователь с таким e-mail уже зарегистрирован — войдите и создайте организацию в кабинете');
    }
    const passwordHash = await argon2.hash(dto.password);
    const region = dto.dataRegion ?? 'eu';

    const user = await this.db.withTransaction(async (client) => {
      const account = await this.accounts.create(dto.email, passwordHash, dto.fullName, client);
      const tenant = await this.tenants.create(dto.tenantName, region, client);
      const res = await client.query<UserRow>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role_id, account_id)
         SELECT $1, $2, $3, $4, r.id, $5 FROM roles r WHERE r.code = 'owner'
         RETURNING *, (SELECT code FROM roles WHERE code='owner') AS role_code`,
        [tenant.id, dto.email, passwordHash, dto.fullName, account.id],
      );
      return res.rows[0];
    });

    const tokens = await this.issueTokens(user, meta);
    const orgs = this.orgRefs(await this.users.membershipsByAccount(user.account_id as string));
    return { user: toPublicUser(user), organizations: orgs, ...tokens };
  }

  /** Вход по ГЛОБАЛЬНОМУ аккаунту; активная организация — выбранная или первая. */
  async login(dto: LoginDto, meta?: SessionMeta): Promise<{ user: PublicUser; organizations: OrgRef[] } & TokenPair> {
    const account = await this.accounts.findByEmail(dto.email);
    if (!account) throw AppException.unauthorized('Неверный e-mail или пароль');
    if (!(await argon2.verify(account.password_hash, dto.password))) {
      throw AppException.unauthorized('Неверный e-mail или пароль');
    }

    const memberships = await this.users.membershipsByAccount(account.id);
    if (memberships.length === 0) throw AppException.unauthorized('У аккаунта нет активных организаций');

    const target = (dto.tenantId && memberships.find((m: any) => String(m.tenant_id) === String(dto.tenantId)))
      ? dto.tenantId
      : (memberships[0] as any).tenant_id;
    const user = await this.users.findActiveByAccountAndTenant(account.id, target);
    if (!user) throw AppException.unauthorized('Нет доступа к организации');

    const tokens = await this.issueTokens(user, meta);
    return { user: toPublicUser(user), organizations: this.orgRefs(memberships), ...tokens };
  }

  /** Список организаций аккаунта текущего пользователя. */
  async organizations(tenantId: string, userId: string): Promise<OrgRef[]> {
    const acc = await this.users.accountIdOf(tenantId, userId);
    if (!acc?.account_id) return [];
    return this.orgRefs(await this.users.membershipsByAccount(acc.account_id));
  }

  /** Переключение активной организации — новый токен для другого членства. */
  async switchOrg(tenantId: string, userId: string, targetTenantId: string, meta?: SessionMeta) {
    const acc = await this.users.accountIdOf(tenantId, userId);
    if (!acc?.account_id) throw AppException.forbidden('Нет аккаунта');
    const member = await this.users.findActiveByAccountAndTenant(acc.account_id, targetTenantId);
    if (!member) throw AppException.forbidden('Вы не состоите в этой организации');
    const tokens = await this.issueTokens(member, meta);
    return { user: toPublicUser(member), ...tokens };
  }

  /** Создать новую организацию для текущего аккаунта (owner). */
  async createOrg(tenantId: string, userId: string, name: string, meta?: SessionMeta) {
    const acc = await this.users.accountIdOf(tenantId, userId);
    if (!acc?.account_id) throw AppException.forbidden('Нет аккаунта');
    const account = await this.accounts.findById(acc.account_id);
    if (!account) throw AppException.forbidden('Аккаунт не найден');

    const member = await this.db.withTransaction(async (client) => {
      const tenant = await this.tenants.create(name, 'eu', client);
      const res = await client.query<UserRow>(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role_id, account_id)
         SELECT $1, $2, $3, $4, r.id, $5 FROM roles r WHERE r.code = 'owner'
         RETURNING *, (SELECT code FROM roles WHERE code='owner') AS role_code`,
        [tenant.id, account.email, account.password_hash, account.full_name, account.id],
      );
      return res.rows[0];
    });
    const tokens = await this.issueTokens(member, meta);
    return { user: toPublicUser(member), ...tokens };
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
