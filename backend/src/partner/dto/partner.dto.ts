import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { DeviceType, PaymentMode, PrintMode, TransactionType } from '@prisma/client';
import { TransactionItemDto } from '../../transactions/dto/transaction.dto';

/** Partner ids: Clover ids, order numbers… (no spaces, no slashes — they travel in URLs) */
const REF = /^[A-Za-z0-9._:\-]{1,120}$/;
const REF_MSG = 'must be 1–120 characters: letters, digits, . _ : -';

export class PartnerDeviceDto {
  @Matches(REF, { message: `device.externalId ${REF_MSG}` })
  externalId!: string;

  @IsOptional() @IsString() @MaxLength(100) name?: string;
  @IsOptional() @IsString() @MaxLength(100) model?: string;
  @IsOptional() @IsEnum(DeviceType) deviceType?: DeviceType;
}

export class PartnerEmployeeDto {
  @Matches(REF, { message: `employee.externalId ${REF_MSG}` })
  externalId!: string;

  @IsString() @IsNotEmpty() @MaxLength(100) firstName!: string;
  @IsOptional() @IsString() @MaxLength(100) lastName?: string;
}

/** POST /api/partner/v1/sales */
export class PartnerSaleDto {
  /** The partner's id for this sale (e.g. the Clover order id). Sending it again returns the same sale. */
  @Matches(REF, { message: `externalRef ${REF_MSG}` })
  externalRef!: string;

  /** Who sends it: CLOVER, FOODHUB… (upper-case letters, digits, _) */
  @Matches(/^[A-Z0-9_]{2,30}$/, { message: 'source must be 2–30 characters: A-Z 0-9 _' })
  source!: string;

  @ValidateNested() @Type(() => PartnerDeviceDto)
  device!: PartnerDeviceDto;

  /** Employee who took the sale; registered with MEV-WEB (UTL) the first time. Default: the key's user. */
  @IsOptional() @ValidateNested() @Type(() => PartnerEmployeeDto)
  employee?: PartnerEmployeeDto;

  @IsOptional() @IsEnum(TransactionType)
  transactionType?: TransactionType;

  @ValidateNested({ each: true }) @Type(() => TransactionItemDto) @ArrayMinSize(1)
  lines!: TransactionItemDto[];

  @IsEnum(PaymentMode)
  paymentMode!: PaymentMode;

  @IsOptional() @IsEnum(PrintMode) printMode?: PrintMode;
  @IsOptional() @IsString() @MaxLength(20) tableNumber?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) numberOfCovers?: number;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) tipsAmount?: number;
  @IsOptional() @IsBoolean() isTraining?: boolean;
}

/** POST /api/partner/v1/sales/:externalRef/void — cancels the whole sale (ANN) */
export class PartnerVoidDto {
  /** The partner's id for the cancellation record (default: <sale ref>:void) */
  @IsOptional() @Matches(REF, { message: `externalRef ${REF_MSG}` })
  externalRef?: string;

  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @ValidateNested() @Type(() => PartnerEmployeeDto) employee?: PartnerEmployeeDto;
}

/** POST /api/partner/v1/sales/:externalRef/refund — credit note (NDC) for some or all lines */
export class PartnerRefundDto {
  /** The partner's id for this refund (e.g. the Clover refund id) — idempotency key */
  @Matches(REF, { message: `externalRef ${REF_MSG}` })
  externalRef!: string;

  /** Refunded lines, positive amounts (they are recorded as credits) */
  @ValidateNested({ each: true }) @Type(() => TransactionItemDto) @ArrayMinSize(1)
  lines!: TransactionItemDto[];

  @IsOptional() @IsEnum(PaymentMode) paymentMode?: PaymentMode;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
  @IsOptional() @ValidateNested() @Type(() => PartnerEmployeeDto) employee?: PartnerEmployeeDto;
}

/** POST /api/partner/keys (JWT, ADMIN) */
export class CreateApiKeyDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  label!: string;

  /** SEV user that signs sales sent without an employee (default: the admin creating the key) */
  @IsOptional() @IsUUID()
  userId?: string;
}
