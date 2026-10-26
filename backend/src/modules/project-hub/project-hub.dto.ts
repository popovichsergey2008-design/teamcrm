import { Type } from 'class-transformer';
import {
  IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { KINDS, SECTIONS } from './hub-rules';

/** Паспорт: миссия, аудитория, описание (то же поле, что в настройках проекта). */
export class PassportDto {
  @IsOptional() @IsString() @MaxLength(300) mission?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) audience?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  /** Выключатель библиотекаря проекта — руководство и ответственный. */
  @IsOptional() @IsBoolean() hubLibrarian?: boolean;
}

export class ContactDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(100) role?: string;
  @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsOptional() @IsString() @MaxLength(120) email?: string;
  @IsOptional() @IsString() @MaxLength(60) telegram?: string;
}

export class CreateItemDto {
  @IsIn(SECTIONS) section!: 'passport' | 'team' | 'knowledge';
  @IsIn(KINDS) kind!: 'link' | 'file' | 'contact' | 'note';
  @IsOptional() @IsString() @MaxLength(16) category?: string | null;
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(2000) url?: string | null;
  @IsOptional() @IsString() fileId?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) body?: string | null;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => ContactDto) contact?: ContactDto | null;
}

export class UpdateItemDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(16) category?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) url?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) body?: string | null;
  @IsOptional() @IsObject() @ValidateNested() @Type(() => ContactDto) contact?: ContactDto | null;
  @IsOptional() @IsBoolean() pinned?: boolean;
  @IsOptional() @IsIn(SECTIONS) section?: 'passport' | 'team' | 'knowledge';
}

export class MemberDto {
  @IsOptional() @IsString() @MaxLength(60) roleTitle?: string | null;
  @IsOptional() @IsString() @MaxLength(300) responsibility?: string | null;
}

export class DecisionsQuery {
  @IsOptional() @IsString() before?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class AskDto {
  @IsString() @MinLength(2) @MaxLength(500) q!: string;
}
