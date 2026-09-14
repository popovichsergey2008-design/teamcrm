import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, MaxLength, MinLength, Min } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  clientId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  budget?: number;
}

export class ColumnDto {
  @IsString({ message: 'Название колонки обязательно' })
  @MinLength(1, { message: 'Название колонки не может быть пустым' })
  @MaxLength(64, { message: 'Название колонки не длиннее 64 символов' })
  name!: string;
}

export class MoveColumnDto {
  @IsIn(['left', 'right'], { message: 'direction должен быть left или right' })
  direction!: 'left' | 'right';
}

export class ReorderColumnsDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'Передайте порядок колонок' })
  @IsString({ each: true })
  orderedIds!: string[];
}

/** Новый порядок досок: список идёт как есть, номера расставляет сервер. */
export class ProjectOrderDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) ids!: string[];
}

/** Основная доска компании — такие всегда первыми в списке. */
export class ProjectDefaultDto {
  @IsBoolean() isDefault!: boolean;
}

export class ProjectOwnerDto {
  @IsOptional() @IsString() userId?: string | null;
}
