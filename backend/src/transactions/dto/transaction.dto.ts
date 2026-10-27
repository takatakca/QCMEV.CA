import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaymentMode, PrintMode, TransactionType } from '@prisma/client';

/** '' = non taxable (MEV-WEB codeTaxe accepts an empty string) */
const TAX_CODES = ['FP', 'F', 'P', ''];

export class TransactionItemDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  description!: string;

  @IsNumber({ maxDecimalPlaces: 3 }) @IsPositive()
  quantity!: number;

  /** May be negative (credit lines, cancellations) */
  @IsNumber({ maxDecimalPlaces: 2 })
  unitPrice!: number;

  @IsOptional() @IsIn(TAX_CODES, { message: `taxCode must be one of: ${TAX_CODES.map(c => c || "''").join(', ')}` })
  taxCode?: string;
}

/** POST /api/transactions */
export class CreateTransactionBodyDto {
  @IsUUID()
  deviceId!: string;

  @IsOptional() @IsEnum(TransactionType)
  transactionType?: TransactionType;

  @ValidateNested({ each: true }) @Type(() => TransactionItemDto) @ArrayMinSize(1)
  items!: TransactionItemDto[];

  @IsOptional() @IsEnum(PaymentMode)
  paymentMode?: PaymentMode;

  @IsOptional() @IsEnum(PrintMode)
  printMode?: PrintMode;

  @IsOptional() @IsString() @MaxLength(20)
  tableNumber?: string;

  @IsOptional() @IsInt() @Min(0) @Max(1000)
  numberOfCovers?: number;

  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0)
  tipsAmount?: number;

  /** ANN / COR / NDC — the transaction being cancelled / corrected / credited */
  @IsOptional() @IsUUID()
  relatedTransactionId?: string;

  /** Alias of relatedTransactionId (older clients) */
  @IsOptional() @IsUUID()
  originalTransactionId?: string;

  @IsOptional() @IsBoolean()
  isTraining?: boolean;
}

/** POST /api/transactions/:id/cancel */
export class CancelTransactionDto {
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

/** POST /api/transactions/:id/items (SW-76 §4.6) */
export class AddItemAfterInvoiceDto extends TransactionItemDto {
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

/** POST /api/transactions/:id/items/:itemId/remove (SW-76 §4.6) */
export class RemoveItemAfterInvoiceDto {
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

/** POST /api/transactions/:id/items/:itemId/price (SW-76 §4.6) */
export class ModifyPriceAfterInvoiceDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  newUnitPrice!: number;

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}
