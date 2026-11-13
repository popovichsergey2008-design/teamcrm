import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { EMAIL_HINT } from '../../common/http/validation-ru';

export class RegisterDto {
  /**
   * #4779: на первом шаге — только почта, пароль и согласия; имя и название
   * пространства спрашиваем после входа. Старые клиенты (приложение) шлют их сразу.
   */
  @IsOptional()
  @IsString({ message: 'Укажите название пространства' })
  @MinLength(2, { message: 'Название пространства слишком короткое' })
  @MaxLength(160, { message: 'Название пространства слишком длинное (максимум 160 символов)' })
  tenantName?: string;

  @IsOptional()
  @IsIn(['ru', 'eu'], { message: 'Регион данных должен быть ru или eu' })
  dataRegion?: 'ru' | 'eu';

  @IsEmail({}, { message: EMAIL_HINT })
  @MaxLength(255, { message: 'Email слишком длинный' })
  email!: string;

  @IsString({ message: 'Укажите пароль' })
  @MinLength(8, { message: 'Пароль должен содержать не менее 8 символов' })
  @MaxLength(128, { message: 'Пароль слишком длинный (максимум 128 символов)' })
  password!: string;

  @IsOptional()
  @IsString({ message: 'Укажите ваше имя' })
  @MinLength(1, { message: 'Укажите ваше имя' })
  @MaxLength(160, { message: 'Имя слишком длинное (максимум 160 символов)' })
  fullName?: string;

  /** #4779: UTM-метки с кнопки сайта — откуда пришло пространство. Чистит сервис. */
  @IsOptional()
  @IsObject({ message: 'Метки перехода — объект' })
  utm?: Record<string, unknown>;

  /** #4804: домен, с которого пришли на сайт (только домен). Чистит сервис. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  referrerHost?: string;

  /** #4863: код приглашения из ссылки сайта qevo.one/?ref=<код>. Чистит сервис. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  referralCode?: string;

  /**
   * #4675: галочка «Я принимаю Политику конфиденциальности». Необязательна для
   * валидатора, чтобы отказ был понятным текстом из сервиса, а не «must be a boolean».
   */
  @IsOptional()
  @IsBoolean({ message: 'Примите Политику конфиденциальности, чтобы зарегистрироваться' })
  acceptPrivacy?: boolean;

  /** Поле-ловушка для ботов: в форме скрыто, человек его не заполняет. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}

export class MfaLoginDto {
  @IsString() @MaxLength(2048) mfaToken!: string;
  @IsString() @MaxLength(32) code!: string;
}

export class ForgotPasswordDto {
  @IsEmail({}, { message: EMAIL_HINT })
  @MaxLength(255)
  email!: string;
}

/** #4779, п. 8: своя почта вместо служебной tg…@users.qevo.one. */
export class SetEmailDto {
  @IsEmail({}, { message: EMAIL_HINT })
  @MaxLength(255, { message: 'Email слишком длинный' })
  email!: string;
}

export class TokenDto {
  @IsString() @MaxLength(128) token!: string;
}

export class MfaPasswordDto {
  @IsString() @MaxLength(128) password!: string;
}

export class MfaCodeDto {
  @IsString() @MaxLength(32) code!: string;
}

export class MfaDisableDto {
  @IsString() @MaxLength(128) password!: string;
  @IsString() @MaxLength(32) code!: string;
}

export class LoginDto {
  @IsEmail({}, { message: EMAIL_HINT })
  email!: string;

  @IsString({ message: 'Укажите пароль' })
  password!: string;

  @IsOptional()
  @IsString()
  tenantId?: string;
}

export class RefreshDto {
  @IsString()
  refreshToken!: string;
}

export class LogoutDto {
  @IsString()
  refreshToken!: string;
}
