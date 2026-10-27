/**
 * Contract "foodhub.sale.v1" (Food Hub → QCMEV). See CONTRACT.md next to this file.
 * Pure code: validation and mapping to a SaleDraft. All money is integer cents (CAD).
 * Food Hub never sends identity values (NEQ, GST/QST numbers, file number, authorization code).
 */
import { canonicalJson, sha256Hex } from '../../common/canonical-json';
import { isValidQuantity, lineTotal, TaxCode } from '../../common/money';
import { PAYMENT_CODES, PaymentCode, SaleDraft, SaleLine, TypServ } from '../../transactions/trans-builder';

export const SALE_SCHEMA = 'foodhub.sale.v1';
export const CREDIT_SCHEMA = 'foodhub.credit.v1';
export const PRINT_SCHEMA = 'foodhub.print.v1';

export const CHANNELS = ['uber_eats', 'doordash', 'skip', 'tgtg', 'relay', 'website', 'phone', 'storefront', 'clover_online', 'clover_pos', 'manual'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface FoodHubModifier {
  description: string;
  quantity: string;
  unitPriceCents: number;
  totalCents: number;
}

export interface FoodHubLine {
  ref?: string;
  description: string;
  quantity: string;
  unitPriceCents: number;
  totalCents: number;
  taxCode: TaxCode;
  activity: 'RES' | 'BAR' | 'NON';
  modifiers?: FoodHubModifier[];
}

export interface FoodHubSaleV1 {
  schema: typeof SALE_SCHEMA;
  tenantId: string;
  locationId: string;
  saleKey: string;
  occurredAt: string;
  /** model `pos`: a sale rung up on the restaurant's Clover register (channel `clover_pos`), relayed by Food Hub. */
  source: { model: 'stored' | 'direct' | 'pos'; channel: Channel; orderId: string; externalOrderId?: string; displayId?: string; posOrderId?: string; brand?: string };
  serviceType: TypServ;
  ecommerce: boolean;
  user?: { id?: string; name?: string };
  lines: FoodHubLine[];
  fees?: { deliveryCents?: number; serviceFeeCents?: number };
  discountCents?: number;
  amounts: { subtotalCents: number; gstCents: number; qstCents: number; totalCents: number; tipCents?: number };
  payment: { mode: PaymentCode; collectedBy: 'platform' | 'paylink' | 'clover_tender' | 'cash'; reference?: string };
  receipt?: { format?: 'PAP' | 'ELE' | 'PEL' | 'NON'; deliver?: 'print' | 'sms' | 'email' | 'none' };
  testMode?: boolean;
  /** Optional: a new receipt that replaces / completes an earlier sale (e.g. after a price adjustment) references it. */
  referenceSaleKey?: string;
  payloadHash?: string;
}

export interface FoodHubCreditV1 {
  schema: typeof CREDIT_SCHEMA;
  tenantId: string;
  creditKey: string;
  reason: 'cancelled' | 'adjusted' | 'missing_items' | 'refund';
  full: boolean;
  lines?: FoodHubLine[];
  amounts?: { subtotalCents: number; gstCents?: number; qstCents?: number; totalCents?: number };
  occurredAt?: string;
  user?: { id?: string; name?: string };
  payloadHash?: string;
}

export interface FoodHubPrintV1 {
  schema: typeof PRINT_SCHEMA;
  tenantId: string;
  printKey: string;
  mode: 'RPR' | 'DUP';
  user?: { id?: string; name?: string };
  payloadHash?: string;
}

export interface FieldError {
  field: string;
  message: string;
}

export class ContractError extends Error {
  constructor(public readonly errors: FieldError[]) {
    super(errors.map((e) => `${e.field}: ${e.message}`).join('; '));
  }
}

/** sha256 of the canonical JSON of the body without its payloadHash field. */
export function payloadHashOf(body: Record<string, unknown>): string {
  const { payloadHash: _ignored, ...rest } = body;
  return sha256Hex(canonicalJson(rest));
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,39}$/;
const KEY_PART = /^[A-Za-z0-9._:#-]{1,160}$/;
const isInt = (v: unknown) => Number.isSafeInteger(v);
const isNonNegInt = (v: unknown) => isInt(v) && (v as number) >= 0;

class Checker {
  readonly errors: FieldError[] = [];
  need(cond: unknown, field: string, message: string): boolean {
    if (!cond) this.errors.push({ field, message });
    return !!cond;
  }
  done(): void {
    if (this.errors.length) throw new ContractError(this.errors);
  }
}

function checkLines(c: Checker, lines: unknown, path: string, allowEmpty = false): void {
  if (!c.need(Array.isArray(lines) && (allowEmpty || lines.length > 0), path, 'must be a non-empty array')) return;
  (lines as FoodHubLine[]).forEach((l, i) => {
    const p = `${path}[${i}]`;
    c.need(typeof l?.description === 'string' && l.description.trim().length > 0, `${p}.description`, 'is required');
    c.need(typeof l?.quantity === 'string' && isValidQuantity(l.quantity), `${p}.quantity`, 'must be a positive decimal string (max 3 decimals)');
    c.need(isNonNegInt(l?.unitPriceCents), `${p}.unitPriceCents`, 'must be a non-negative integer');
    c.need(isNonNegInt(l?.totalCents), `${p}.totalCents`, 'must be a non-negative integer');
    c.need(['FP', 'F', 'P', 'NON'].includes(l?.taxCode), `${p}.taxCode`, 'must be FP, F, P or NON');
    c.need(['RES', 'BAR', 'NON'].includes(l?.activity), `${p}.activity`, 'must be RES, BAR or NON');
    if (typeof l?.quantity === 'string' && isValidQuantity(l.quantity) && isNonNegInt(l?.unitPriceCents) && isNonNegInt(l?.totalCents)) {
      c.need(Math.abs(lineTotal(l.unitPriceCents, l.quantity) - l.totalCents) <= 1, `${p}.totalCents`, 'must equal quantity × unitPriceCents (±1 cent)');
    }
    if (l?.modifiers !== undefined) {
      if (!c.need(Array.isArray(l.modifiers), `${p}.modifiers`, 'must be an array')) return;
      l.modifiers.forEach((m, j) => {
        const q = `${p}.modifiers[${j}]`;
        c.need(typeof m?.description === 'string' && m.description.trim().length > 0, `${q}.description`, 'is required');
        c.need(typeof m?.quantity === 'string' && isValidQuantity(m.quantity), `${q}.quantity`, 'must be a positive decimal string');
        c.need(isNonNegInt(m?.unitPriceCents), `${q}.unitPriceCents`, 'must be a non-negative integer');
        c.need(isNonNegInt(m?.totalCents), `${q}.totalCents`, 'must be a non-negative integer');
      });
    }
  });
}

export function validateSale(b: FoodHubSaleV1, headerTenant: string): void {
  const c = new Checker();
  c.need(b && typeof b === 'object', 'body', 'must be a JSON object');
  if (!b || typeof b !== 'object') return c.done();
  c.need(b.schema === SALE_SCHEMA, 'schema', `must be "${SALE_SCHEMA}"`);
  c.need(typeof b.tenantId === 'string' && SLUG.test(b.tenantId), 'tenantId', 'must be a tenant slug');
  c.need(b.tenantId === headerTenant, 'tenantId', 'must equal the X-Tenant-Id header');
  c.need(typeof b.locationId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(b.locationId), 'locationId', 'is required (letters, digits, _ and -)');
  c.need(typeof b.saleKey === 'string' && b.saleKey.startsWith(`fh:${b.tenantId}:`) && KEY_PART.test(b.saleKey), 'saleKey', 'must be fh:{tenant}:{model}:{channel}:{order id}');
  c.need(typeof b.occurredAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/.test(b.occurredAt), 'occurredAt', 'must be ISO-8601 with an offset');
  c.need(b.source && ['stored', 'direct', 'pos'].includes(b.source.model), 'source.model', 'must be stored, direct or pos');
  c.need(!b.source || (b.source.model === 'pos') === (b.source.channel === 'clover_pos'), 'source.channel', 'clover_pos goes with model pos, and only with it');
  c.need(b.source && (CHANNELS as readonly string[]).includes(b.source.channel), 'source.channel', `must be one of ${CHANNELS.join(', ')}`);
  c.need(b.source && typeof b.source.orderId === 'string' && b.source.orderId.length > 0, 'source.orderId', 'is required');
  c.need(['LVT', 'LVR', 'CMP', 'TBL'].includes(b.serviceType), 'serviceType', 'must be LVT, LVR, CMP or TBL');
  c.need(typeof b.ecommerce === 'boolean', 'ecommerce', 'must be a boolean');
  checkLines(c, b.lines, 'lines');
  if (b.fees !== undefined) {
    c.need(b.fees.deliveryCents === undefined || isNonNegInt(b.fees.deliveryCents), 'fees.deliveryCents', 'must be a non-negative integer');
    c.need(b.fees.serviceFeeCents === undefined || isNonNegInt(b.fees.serviceFeeCents), 'fees.serviceFeeCents', 'must be a non-negative integer');
  }
  c.need(b.discountCents === undefined || isNonNegInt(b.discountCents), 'discountCents', 'must be a non-negative integer');
  const a = b.amounts;
  c.need(a && isInt(a.subtotalCents), 'amounts.subtotalCents', 'must be an integer');
  c.need(a && isNonNegInt(a.gstCents), 'amounts.gstCents', 'must be a non-negative integer');
  c.need(a && isNonNegInt(a.qstCents), 'amounts.qstCents', 'must be a non-negative integer');
  c.need(a && isInt(a.totalCents), 'amounts.totalCents', 'must be an integer');
  c.need(!a || a.tipCents === undefined || isNonNegInt(a.tipCents), 'amounts.tipCents', 'must be a non-negative integer');
  if (a && isInt(a.subtotalCents) && isInt(a.gstCents) && isInt(a.qstCents) && isInt(a.totalCents)) {
    c.need(a.totalCents === a.subtotalCents + a.gstCents + a.qstCents, 'amounts.totalCents', 'must equal subtotalCents + gstCents + qstCents exactly (tip excluded)');
  }
  c.need(b.payment && (PAYMENT_CODES as string[]).includes(b.payment.mode), 'payment.mode', `must be one of ${PAYMENT_CODES.join(', ')}`);
  c.need(b.payment && ['platform', 'paylink', 'clover_tender', 'cash'].includes(b.payment.collectedBy), 'payment.collectedBy', 'must be platform, paylink, clover_tender or cash');
  c.need(!b.receipt?.format || ['PAP', 'ELE', 'PEL', 'NON'].includes(b.receipt.format), 'receipt.format', 'must be PAP, ELE, PEL or NON');
  c.need(b.testMode === undefined || typeof b.testMode === 'boolean', 'testMode', 'must be a boolean');
  c.need(
    b.referenceSaleKey === undefined || (typeof b.referenceSaleKey === 'string' && b.referenceSaleKey.startsWith(`fh:${b.tenantId}:`) &&b.referenceSaleKey !== b.saleKey),
    'referenceSaleKey',
    'must be another saleKey of the same tenant',
  );
  c.done();
}

export function validateCredit(b: FoodHubCreditV1, headerTenant: string, saleKey: string): void {
  const c = new Checker();
  c.need(b && typeof b === 'object', 'body', 'must be a JSON object');
  if (!b || typeof b !== 'object') return c.done();
  c.need(b.schema === CREDIT_SCHEMA, 'schema', `must be "${CREDIT_SCHEMA}"`);
  c.need(b.tenantId === headerTenant, 'tenantId', 'must equal the X-Tenant-Id header');
  c.need(typeof b.creditKey === 'string' && b.creditKey.startsWith(`${saleKey}:cn:`) && KEY_PART.test(b.creditKey), 'creditKey', 'must be {saleKey}:cn:{seq}');
  c.need(['cancelled', 'adjusted', 'missing_items', 'refund'].includes(b.reason), 'reason', 'must be cancelled, adjusted, missing_items or refund');
  c.need(typeof b.full === 'boolean', 'full', 'must be a boolean');
  if (b.full === false) checkLines(c, b.lines, 'lines');
  if (b.amounts !== undefined) c.need(isNonNegInt(b.amounts.subtotalCents), 'amounts.subtotalCents', 'must be a non-negative integer (magnitude of the credit)');
  c.done();
}

export function validatePrint(b: FoodHubPrintV1, headerTenant: string, saleKey: string): void {
  const c = new Checker();
  c.need(b && typeof b === 'object', 'body', 'must be a JSON object');
  if (!b || typeof b !== 'object') return c.done();
  c.need(b.schema === PRINT_SCHEMA, 'schema', `must be "${PRINT_SCHEMA}"`);
  c.need(b.tenantId === headerTenant, 'tenantId', 'must equal the X-Tenant-Id header');
  c.need(typeof b.printKey === 'string' && b.printKey.startsWith(`${saleKey}:pr:`) && KEY_PART.test(b.printKey), 'printKey', 'must be {saleKey}:pr:{seq}');
  c.need(['RPR', 'DUP'].includes(b.mode), 'mode', 'must be RPR or DUP');
  c.done();
}

/** Food Hub lines (with modifiers) → sale lines. Modifiers share the parent's tax code and activity. */
export function toSaleLines(lines: FoodHubLine[]): SaleLine[] {
  const out: SaleLine[] = [];
  for (const l of lines) {
    out.push({ ref: l.ref, description: l.description.trim().slice(0, 100), quantity: l.quantity, unitPriceCents: l.unitPriceCents, totalCents: l.totalCents, tax: l.taxCode, activity: l.activity });
    for (const m of l.modifiers ?? []) {
      out.push({ description: m.description.trim().slice(0, 100), quantity: m.quantity, unitPriceCents: m.unitPriceCents, totalCents: m.totalCents, tax: l.taxCode, activity: l.activity, isModifier: true });
    }
  }
  return out;
}

export interface MappedSale {
  draft: SaleDraft;
  warnings: string[];
  externalRef: string;
}

/**
 * Mapping rules (contract §5):
 *  - typServ from serviceType; « COMMANDE PAR UNE PLATEFORME NUMÉRIQUE » follows from LVT;
 *  - avantTax = lines + modifiers + delivery fee (LVR only) + service fee − restaurant-funded discount (negative line, SPEC);
 *  - TPS / TVQ: as charged (gstCents / qstCents); taxGap flagged when they differ from the computed ones by > 1 cent;
 *  - pourb only when the restaurant keeps the tip (never for LVT), never inside apresTax;
 *  - $0 → AUC; testMode → modTrans FOR; ecommerce → commerElectr O (ARG / CHQ refused).
 */
export function mapSale(b: FoodHubSaleV1): MappedSale {
  const warnings: string[] = [];
  const lines = toSaleLines(b.lines);
  const delivery = b.fees?.deliveryCents ?? 0;
  if (delivery > 0) {
    if (b.serviceType === 'LVR') lines.push({ description: 'Frais de livraison', quantity: '1', unitPriceCents: delivery, totalCents: delivery, tax: 'FP', activity: 'RES' });
    else warnings.push('deliveryFeeExcluded');
  }
  const service = b.fees?.serviceFeeCents ?? 0;
  if (service > 0) lines.push({ description: 'Frais de service', quantity: '1', unitPriceCents: service, totalCents: service, tax: 'FP', activity: 'RES' });
  const discount = b.discountCents ?? 0;
  if (discount > 0) lines.push({ description: 'Rabais', quantity: '1', unitPriceCents: -discount, totalCents: -discount, tax: 'FP', activity: 'RES' });

  const subtotal = lines.reduce((s, l) => s + l.totalCents, 0);
  if (subtotal !== b.amounts.subtotalCents) {
    throw new ContractError([{ field: 'amounts.subtotalCents', message: `must equal lines + modifiers + restaurant fees − discount = ${subtotal}` }]);
  }

  let tip = b.amounts.tipCents ?? 0;
  if (tip > 0 && b.serviceType === 'LVT') {
    warnings.push('tipExcluded');
    tip = 0;
  }
  let modPai = b.payment.mode;
  if (b.amounts.totalCents === 0 && modPai !== 'AUC') {
    warnings.push('paymentModeAUC');
    modPai = 'AUC';
  }
  const brand = b.source.brand ? `${b.source.brand} ` : '';
  const display = b.source.displayId ?? b.source.externalOrderId ?? b.source.orderId;
  return {
    draft: {
      documentKind: 'RECEIPT',
      typTrans: 'RFER',
      modImpr: 'FAC',
      formImpr: b.receipt?.format ?? 'PAP',
      modTrans: b.testMode ? 'FOR' : 'OPE',
      typServ: b.serviceType,
      ecommerce: b.ecommerce,
      modPai,
      lines,
      taxOverride: { tpsCents: b.amounts.gstCents, tvqCents: b.amounts.qstCents },
      tipCents: tip || null,
    },
    warnings,
    externalRef: `${brand}#${display}`.slice(0, 60),
  };
}
