import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MevEnvironment, SectorType } from '@prisma/client';

/**
 * POST /api/operators/register — public, initial setup of an operator account.
 * Creates the Operator and its first ADMIN user in one DB transaction.
 */
export class RegisterOperatorDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  name!: string;

  /** Numéro d'entreprise du Québec — 10 digits */
  @Matches(/^\d{10}$/, { message: 'neq must be exactly 10 digits' })
  neq!: string;

  @IsEnum(SectorType, { message: `sector must be one of: ${Object.values(SectorType).join(', ')}` })
  sector!: SectorType;

  /** Issued by Revenu Québec — can be added later via PUT /api/operators/me */
  @IsOptional() @IsString() @MaxLength(100)
  authorizationCode?: string;

  @IsOptional() @IsEnum(MevEnvironment)
  environment?: MevEnvironment;

  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @Matches(/^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/, { message: 'postalCode must be a Canadian postal code' })
  postalCode?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsEmail() email?: string;

  // ── First admin user ────────────────────────────────────────────────────
  @IsString() @MinLength(3) @MaxLength(50)
  adminUsername!: string;

  @IsString() @MinLength(8, { message: 'adminPassword must be at least 8 characters' }) @MaxLength(200)
  adminPassword!: string;

  @IsOptional() @IsString() @MaxLength(100) adminFirstName?: string;
  @IsOptional() @IsString() @MaxLength(100) adminLastName?: string;
}

/** PUT /api/operators/me — only these fields are editable by the operator */
export class UpdateOperatorDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(100) authorizationCode?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @Matches(/^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/) postalCode?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(20) tpsNumber?: string;
  @IsOptional() @IsString() @MaxLength(20) tvqNumber?: string;
  @IsOptional() @IsEnum(MevEnvironment) environment?: MevEnvironment;
}
