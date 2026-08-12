import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class ConnectYougileDto {
  @IsString()
  @MaxLength(300)
  apiKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;
}

export class ImportYougileDto {
  @IsArray()
  @IsString({ each: true })
  boardExternalIds!: string[];
}

export class MapUserDto {
  @IsString()
  externalUserId!: string;

  @IsString()
  localUserId!: string;
}
