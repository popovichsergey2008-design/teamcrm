import { rawRequest, request } from './api';

/**
 * Редкие ручки входа: «Забыли пароль?», подтверждение почты, второй фактор.
 * Отдельно от api.ts — их зовут только ленивые экраны, и в первый экран они не попадают.
 */
export const authApi = {
  /** «Забыли пароль?» — ответ одинаковый, есть такой адрес или нет. */
  forgotPassword: (email: string) => rawRequest<{ sent: true }>('POST', '/auth/password/forgot', { email }, false),
  verifyEmail: (token: string) => rawRequest<{ verified: true; email: string }>('POST', '/auth/email/verify', { token }, false),
  resendVerification: () => request<{ sent: boolean; verified: boolean }>('POST', '/auth/email/resend'),
  mfaStatus: () => request<{ enabled: boolean; enabledAt: string | null; recoveryLeft: number; emailVerified: boolean }>('GET', '/auth/mfa'),
  mfaSetup: (password: string) => request<{ secret: string; otpauthUri: string; expiresInSec: number }>('POST', '/auth/mfa/setup', { password }),
  mfaEnable: (code: string) => request<{ enabled: true; recoveryCodes: string[] }>('POST', '/auth/mfa/enable', { code }),
  mfaDisable: (password: string, code: string) => request<{ enabled: false }>('POST', '/auth/mfa/disable', { password, code }),
  mfaRecoveryCodes: (code: string) => request<{ recoveryCodes: string[] }>('POST', '/auth/mfa/recovery-codes', { code }),
};
