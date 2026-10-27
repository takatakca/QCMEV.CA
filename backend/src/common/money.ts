/**
 * Money helpers. Everything inside QCMEV is integer cents (CAD).
 *
 * Taxes (Québec, 2026): TPS 5 % and TVQ 9.975 %, each computed on its own base and rounded
 * half-up (half away from zero for credit notes) separately. apresTax = avantTax + TPS + TVQ exactly.
 */

export const TPS_RATE_LABEL = '5 %';
export const TVQ_RATE_LABEL = '9,975 %';

export type TaxCode = 'FP' | 'F' | 'P' | 'NON';

/** round(cents * num / den), half away from zero, integer math only. */
function roundRatio(cents: number, num: number, den: number): number {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`cents must be a safe integer, got ${cents}`);
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(cents);
  return sign * Math.floor((abs * num + den / 2) / den);
}

export function tpsOf(baseCents: number): number {
  return roundRatio(baseCents, 5, 100);
}

export function tvqOf(baseCents: number): number {
  return roundRatio(baseCents, 9975, 100000);
}

export interface TaxableLine {
  totalCents: number;
  tax: TaxCode;
}

export interface TaxResult {
  /** avantTax: sum of every line (fees and discount lines included). */
  subtotalCents: number;
  tpsBaseCents: number;
  tvqBaseCents: number;
  tpsCents: number;
  tvqCents: number;
  /** apresTax */
  totalCents: number;
}

export function computeTaxes(lines: TaxableLine[]): TaxResult {
  let subtotal = 0;
  let tpsBase = 0;
  let tvqBase = 0;
  for (const l of lines) {
    subtotal += l.totalCents;
    if (l.tax === 'FP' || l.tax === 'F') tpsBase += l.totalCents;
    if (l.tax === 'FP' || l.tax === 'P') tvqBase += l.totalCents;
  }
  const tps = tpsOf(tpsBase);
  const tvq = tvqOf(tvqBase);
  return { subtotalCents: subtotal, tpsBaseCents: tpsBase, tvqBaseCents: tvqBase, tpsCents: tps, tvqCents: tvq, totalCents: subtotal + tps + tvq };
}

/** "12.34" / "-0.05": the amount format sent to MEV-WEB (SPEC: padding/sign format to confirm in SW-73). */
export function mevAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** "12,34 $": the amount format printed on receipts (French Canada). */
export function receiptAmount(cents: number): string {
  return `${mevAmount(cents).replace('.', ',')} $`;
}

const QTY = /^\d{1,6}(\.\d{1,3})?$/;

export function isValidQuantity(q: string): boolean {
  return QTY.test(q) && Number(q) > 0;
}

/** unit price × quantity in cents, rounded half away from zero (quantities can have 3 decimals). */
export function lineTotal(unitPriceCents: number, quantity: string): number {
  if (!isValidQuantity(quantity)) throw new RangeError(`invalid quantity "${quantity}"`);
  const [i, d = ''] = quantity.split('.');
  const thousandths = Number(i) * 1000 + Number(d.padEnd(3, '0'));
  return roundRatio(unitPriceCents * thousandths, 1, 1000);
}
