import { IsArray, IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

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

/** E4: включение обратной выгрузки CRM → YouGile на подключении. */
export class PushYougileDto {
  @IsBoolean()
  enabled!: boolean;
}

export class MapUserDto {
  @IsString()
  externalUserId!: string;

  @IsString()
  localUserId!: string;
}
