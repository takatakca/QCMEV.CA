/**
 * Operator registration and settings bodies (class-validator; unknown fields are stripped by the global ValidationPipe).
 *
 * The identity values typed here (NEQ, TPS / TVQ numbers) are stored in the database only, never logged or returned.
 * The mandatory-billing file number and the authorization code belong to each establishment (device): they are set
 * with POST / PUT /api/devices, encrypted, and never returned.
 */
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { MEV_ENVS } from '../../config/app-config';

/** nomUtil sent with UTL (SPEC: allowed characters and length wait for SW-73). */
export const NOM_UTIL = /^[A-Za-z0-9À-ÿ .'#_-]{2,50}$/;
export const USERNAME = /^[a-z0-9._@-]{3,60}$/i;
const POSTAL_CODE = /^[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d$/;

/** POST /api/operators/register: first-time setup of an operator and its first ADMIN (public route). */
export class RegisterOperatorDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  name!: string;

  /** Numéro d'entreprise du Québec: 10 digits. */
  @Matches(/^\d{10}$/, { message: 'neq must be exactly 10 digits' })
  neq!: string;

  /** TPS (GST) registration number: 9 digits + RT + 4 digits. */
  @Matches(/^\d{9}RT\d{4}$/, { message: 'noTPS must look like 123456789RT0001' })
  noTPS!: string;

  /** TVQ (QST) registration number: 10 digits + TQ + 4 digits. */
  @Matches(/^\d{10}TQ\d{4}$/, { message: 'noTVQ must look like 1234567890TQ0001' })
  noTVQ!: string;

  /** sectActi.abrvt: RBC (restaurant, bar, café) is the only sector built (TRP is not). */
  @IsOptional() @IsIn(['RBC'], { message: 'sector must be RBC (restaurant, bar, café)' })
  sector?: 'RBC';

  /** Must be the server's MEV_ENVIRONMENT when given (an operator is always set up for the server's environment). */
  @IsOptional() @IsIn(MEV_ENVS)
  environment?: string;

  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @Matches(POSTAL_CODE, { message: 'postalCode must be a Canadian postal code' }) postalCode?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(200) email?: string;

  // ── First admin ──────────────────────────────────────────────────────────
  @Matches(USERNAME, { message: 'adminUsername: 3–60 letters, digits, . _ @ -' })
  adminUsername!: string;

  @IsString() @MinLength(12, { message: 'adminPassword must be at least 12 characters' }) @MaxLength(200)
  adminPassword!: string;

  @IsOptional() @IsString() @MaxLength(100) adminFirstName?: string;
  @IsOptional() @IsString() @MaxLength(100) adminLastName?: string;

  /** nomUtil registered with MEV-WEB (UTL). Default: "<first name> <last name>", else the username. */
  @IsOptional() @Matches(NOM_UTIL, { message: 'adminMevUserName: 2–50 characters' })
  adminMevUserName?: string;
}

/** PUT /api/operators/me: the only editable fields. */
export class UpdateOperatorDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(300) address?: string;
  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @Matches(POSTAL_CODE, { message: 'postalCode must be a Canadian postal code' }) postalCode?: string;
  @IsOptional() @IsString() @MaxLength(30) phone?: string;
  @IsOptional() @IsEmail() @MaxLength(200) email?: string;

  /** ADMIN only, and only while no device of the operator holds a certificate (they are in the CSR and every signature). */
  @IsOptional() @Matches(/^\d{9}RT\d{4}$/, { message: 'noTPS must look like 123456789RT0001' }) noTPS?: string;
  @IsOptional() @Matches(/^\d{10}TQ\d{4}$/, { message: 'noTVQ must look like 1234567890TQ0001' }) noTVQ?: string;

  /** ADMIN only, explicit confirmation, and only to the server's environment. */
  @IsOptional() @IsIn(MEV_ENVS) environment?: string;
  @IsOptional() @IsString() @MaxLength(40) confirm?: string;
}
