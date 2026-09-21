import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface MobileDeviceRow {
  id: string;
  user_id: string;
  tenant_id: string;
  device_uuid: string;
  platform: string;
  model: string | null;
  os_version: string | null;
  native_version: string | null;
  web_bundle_version: string | null;
  push_token: string | null;
  voip_token: string | null;
  last_seen_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}

export interface DeviceInput {
  deviceUuid: string;
  platform: string;
  model?: string | null;
  osVersion?: string | null;
  nativeVersion?: string | null;
  webBundleVersion?: string | null;
  pushToken?: string | null;
}

@Injectable()
export class MobileDevicesRepository {
  constructor(private readonly db: DbService) {}

  /** Одно устройство — одна строка: повторная регистрация обновляет версии и снимает отзыв. */
  upsert(tenantId: string, userId: string, d: DeviceInput): Promise<MobileDeviceRow | null> {
    return this.db.one<MobileDeviceRow>(
      `INSERT INTO mobile_devices
         (user_id, tenant_id, device_uuid, platform, model, os_version, native_version, web_bundle_version, push_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (user_id, device_uuid) DO UPDATE SET
         platform = EXCLUDED.platform,
         model = COALESCE(EXCLUDED.model, mobile_devices.model),
         os_version = COALESCE(EXCLUDED.os_version, mobile_devices.os_version),
         native_version = COALESCE(EXCLUDED.native_version, mobile_devices.native_version),
         web_bundle_version = COALESCE(EXCLUDED.web_bundle_version, mobile_devices.web_bundle_version),
         push_token = COALESCE(EXCLUDED.push_token, mobile_devices.push_token),
         last_seen_at = now(), revoked_at = NULL
       RETURNING *`,
      [
        userId, tenantId, d.deviceUuid, d.platform, d.model ?? null, d.osVersion ?? null,
        d.nativeVersion ?? null, d.webBundleVersion ?? null, d.pushToken ?? null,
      ],
    );
  }

  bindSession(deviceId: string, sessionId: string) {
    return this.db.query(`UPDATE refresh_tokens SET device_id=$1 WHERE id=$2`, [deviceId, sessionId]);
  }

  byIdOwned(userId: string, id: string) {
    return this.db.one<MobileDeviceRow>(
      `SELECT * FROM mobile_devices WHERE id=$1 AND user_id=$2`, [id, userId],
    );
  }

  listMine(userId: string) {
    return this.db.many<MobileDeviceRow>(
      `SELECT * FROM mobile_devices WHERE user_id=$1 AND revoked_at IS NULL ORDER BY last_seen_at DESC`,
      [userId],
    );
  }

  /** Отозвать устройство: оно больше не будится push'ем; его сессии отзываются отдельно. */
  revoke(id: string) {
    return this.db.query(`UPDATE mobile_devices SET revoked_at=now(), push_token=NULL WHERE id=$1`, [id]);
  }

  /** Сессии этого устройства — чтобы отозвать их вместе с ним. */
  sessionIdsOf(deviceId: string) {
    return this.db.many<{ id: string }>(
      `SELECT id::text FROM refresh_tokens WHERE device_id=$1 AND revoked_at IS NULL`, [deviceId],
    );
  }
}