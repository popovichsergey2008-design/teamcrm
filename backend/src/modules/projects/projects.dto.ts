import { ArrayNotEmpty, IsArray, IsIn, IsNumber, IsOptional, IsString, MaxLength, MinLength, Min } from 'class-validator';

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
