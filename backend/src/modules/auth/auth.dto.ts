import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsString({ message: 'Укажите название организации' })
  @MinLength(2, { message: 'Название организации слишком короткое' })
  @MaxLength(160, { message: 'Название организации слишком длинное (максимум 160 символов)' })
  tenantName!: string;

  @IsOptional()
  @IsIn(['ru', 'eu'], { message: 'Регион данных должен быть ru или eu' })
  dataRegion?: 'ru' | 'eu';

  @IsEmail({}, { message: 'Введите корректный e-mail' })
  @MaxLength(255, { message: 'E-mail слишком длинный' })
  email!: string;

  @IsString({ message: 'Укажите пароль' })
  @MinLength(8, { message: 'Пароль должен содержать не менее 8 символов' })
  @MaxLength(128, { message: 'Пароль слишком длинный (максимум 128 символов)' })
  password!: string;

  @IsString({ message: 'Укажите ваше имя' })
  @MinLength(1, { message: 'Укажите ваше имя' })
  @MaxLength(160, { message: 'Имя слишком длинное (максимум 160 символов)' })
  fullName!: string;
}

export class LoginDto {
  @IsEmail({}, { message: 'Введите корректный e-mail' })
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
