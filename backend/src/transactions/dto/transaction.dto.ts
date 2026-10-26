/**
 * Request bodies of the staff transaction routes (class-validator; unknown fields are stripped by the global
 * ValidationPipe). A malformed body answers 400 with the list of problems; the sale rules (e-commerce payment, $0
 * receipt, credit amounts…) are checked afterwards by trans-builder and answer 422.
 * Amounts are integer cents, quantities decimal strings (max 3 decimals), codes are Revenu Québec's (PROVEN names).
 */
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PAYMENT_CODES } from '../trans-builder';

export const TAX_CODES = ['FP', 'F', 'P', 'NON'] as const;
export const ACTIVITIES = ['RES', 'BAR', 'NON'] as const;
export const DOCUMENT_KINDS = ['RECEIPT', 'ADDITION', 'ESTIMATE', 'QUOTE'] as const;
export const SERVICE_TYPES = ['CMP', 'LVR', 'LVT', 'TBL'] as const;
export const PRINT_FORMATS = ['PAP', 'ELE', 'PEL', 'NON'] as const;
const QUANTITY = /^\d{1,6}(\.\d{1,3})?$/;
const toText = ({ value }: { value: unknown }) => (value === undefined || value === null ? value : String(value));

export class TransactionItemDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  description!: string;

  /** Decimal string ("1", "0.5"); a number is accepted and converted. Default "1". */
  @IsOptional() @Transform(toText) @Matches(QUANTITY, { message: 'quantity must be a positive decimal (max 3 decimals)' })
  quantity?: string;

  @IsInt({ message: 'unitPriceCents must be an integer (cents)' }) @Min(0)
  unitPriceCents!: number;

  @IsOptional() @IsIn(TAX_CODES, { message: `tax must be one of ${TAX_CODES.join(', ')}` })
  tax?: (typeof TAX_CODES)[number];

  @IsOptional() @IsIn(ACTIVITIES, { message: `activity must be one of ${ACTIVITIES.join(', ')}` })
  activity?: (typeof ACTIVITIES)[number];
}

/** POST /api/transactions */
export class CreateTransactionDto {
  @IsUUID('4', { message: 'deviceId must be a device id' })
  deviceId!: string;

  @IsArray() @ArrayMinSize(1, { message: 'items is required' }) @ArrayMaxSize(500)
  @ValidateNested({ each: true }) @Type(() => TransactionItemDto)
  items!: TransactionItemDto[];

  @IsIn(PAYMENT_CODES, { message: `paymentMode must be one of ${PAYMENT_CODES.join(', ')}` })
  paymentMode!: string;

  @IsOptional() @IsIn(DOCUMENT_KINDS, { message: `documentKind must be one of ${DOCUMENT_KINDS.join(', ')}` })
  documentKind?: (typeof DOCUMENT_KINDS)[number];

  @IsOptional() @IsIn(SERVICE_TYPES, { message: `serviceType must be one of ${SERVICE_TYPES.join(', ')}` })
  serviceType?: (typeof SERVICE_TYPES)[number];

  @IsOptional() @IsIn(PRINT_FORMATS, { message: `printFormat must be one of ${PRINT_FORMATS.join(', ')}` })
  printFormat?: (typeof PRINT_FORMATS)[number];

  /** pourb: only when the restaurant keeps the tip. */
  @IsOptional() @IsInt({ message: 'tipCents must be an integer (cents)' }) @Min(0)
  tipCents?: number | null;

  @IsOptional() @IsString() @MaxLength(10)
  tableNumber?: string;

  @IsOptional() @IsInt() @Min(0) @Max(1000)
  numberOfCovers?: number;

  @IsOptional() @IsBoolean()
  ecommerce?: boolean;

  /** modTrans FOR (training mode). */
  @IsOptional() @IsBoolean()
  training?: boolean;

  /** Free text printed on the receipt (e.g. an order number). */
  @IsOptional() @IsString() @MaxLength(60)
  externalRef?: string;

  /**
   * « Facture corrigée »: a new receipt that references an earlier receipt of this operator which has been credited
   * (fully or partly). The reference (refs: noTrans, datTrans, avantTax) is fixed at signing time.
   */
  @IsOptional() @IsUUID('4')
  relatedTransactionId?: string;
}

/** POST /api/transactions/:id/credit-note */
export class CreditNoteDto {
  @IsOptional() @IsBoolean()
  full?: boolean;

  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID('4', { each: true })
  itemIds?: string[];

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

/** POST /api/transactions/:id/cancel and the post-invoice removal. */
export class ReasonDto {
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

/** POST /api/transactions/:id/reprint */
export class ReprintDto {
  @IsOptional() @IsIn(['RPR', 'DUP'], { message: 'mode must be RPR or DUP' })
  mode?: 'RPR' | 'DUP';
}

/** POST /api/transactions/:id/items (post-invoice addition: a new referenced receipt). */
export class AddItemAfterInvoiceDto extends TransactionItemDto {
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

/** POST /api/transactions/:id/items/:itemId/price (credit note for the old line + new receipt). */
export class ModifyPriceDto {
  @IsInt({ message: 'newUnitPriceCents must be an integer (cents)' }) @Min(0)
  newUnitPriceCents!: number;

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}
