/**
 * Pure builder: domain sale → WEB-SRM transaction (TransCore) + the string covered by its signature.
 * No database, no clock, no key here, so it is fully unit-tested.
 */
import { computeTaxes, mevAmount, TaxCode } from '../common/money';
import { transactionSignedString } from '../crypto/ecdsa';
import type { MevItem, TransCore } from '../mev-web/mev-web.types';

export type DocumentKindCode = 'RECEIPT' | 'CREDIT_NOTE' | 'ADDITION' | 'ESTIMATE' | 'QUOTE';
export type TypTrans = TransCore['typTrans'];
export type ModImpr = TransCore['modImpr'];
export type FormImpr = TransCore['formImpr'];
export type ModTrans = TransCore['modTrans'];
export type TypServ = NonNullable<TransCore['sectActi']['typServ']>;
export type PaymentCode = 'ARG' | 'CHQ' | 'CRE' | 'DEB' | 'CPR' | 'MIX' | 'AUT' | 'INC' | 'AUC';
export const PAYMENT_CODES: PaymentCode[] = ['ARG', 'CHQ', 'CRE', 'DEB', 'CPR', 'MIX', 'AUT', 'INC', 'AUC'];

export interface SaleLine {
  ref?: string;
  description: string;
  /** decimal string */
  quantity: string;
  unitPriceCents: number;
  totalCents: number;
  tax: TaxCode;
  activity: 'RES' | 'BAR' | 'NON';
  isModifier?: boolean;
}

export interface SaleDraft {
  documentKind: DocumentKindCode;
  typTrans: TypTrans;
  modImpr: ModImpr;
  formImpr: FormImpr;
  modTrans: ModTrans;
  typServ?: TypServ;
  noTabl?: string;
  nbClint?: number;
  ecommerce: boolean;
  modPai: PaymentCode;
  lines: SaleLine[];
  /** Taxes as charged to the customer (e.g. by a platform). When absent they are computed from the lines. */
  taxOverride?: { tpsCents: number; tvqCents: number };
  /** pourb: only when the restaurant keeps the tip. Never part of apresTax. */
  tipCents?: number | null;
}

export interface SaleTotals {
  subtotalCents: number;
  tpsCents: number;
  tvqCents: number;
  totalCents: number;
  computedTpsCents: number;
  computedTvqCents: number;
  /** true when the taxes charged differ from the computed ones by more than 1 cent. */
  taxGap: boolean;
}

export function saleTotals(d: Pick<SaleDraft, 'lines' | 'taxOverride'>): SaleTotals {
  const t = computeTaxes(d.lines);
  const tps = d.taxOverride ? d.taxOverride.tpsCents : t.tpsCents;
  const tvq = d.taxOverride ? d.taxOverride.tvqCents : t.tvqCents;
  return {
    subtotalCents: t.subtotalCents,
    tpsCents: tps,
    tvqCents: tvq,
    totalCents: t.subtotalCents + tps + tvq,
    computedTpsCents: t.tpsCents,
    computedTvqCents: t.tvqCents,
    taxGap: Math.abs(tps - t.tpsCents) > 1 || Math.abs(tvq - t.tvqCents) > 1,
  };
}

export interface ChainContext {
  noTrans: string;
  datTrans: string;
  utc: string;
  /** signa.datActu: moment of signing, AAAAMMJJhhmmss */
  datActu: string;
  nomUtil: string;
  preced: string;
  ref?: { noTrans: string; datTrans: string; subtotalCents: number };
}

export interface Identity {
  noTPS: string;
  noTVQ: string;
}

export function toMevItems(lines: SaleLine[]): MevItem[] {
  return lines.map((l) => ({
    qte: l.quantity,
    // SPEC: modifiers are sent as their own lines prefixed with "+" until SW-73 confirms the "précisions" structure.
    descr: (l.isModifier ? `+ ${l.description}` : l.description).slice(0, 100),
    unitr: mevAmount(l.unitPriceCents),
    prix: mevAmount(l.totalCents),
    tax: l.tax,
    acti: l.activity,
  }));
}

/** Builds the transaction without its signature, and the string to sign. */
export function buildTransCore(draft: SaleDraft, chain: ChainContext, identity: Identity): { core: Omit<TransCore, 'signa'>; totals: SaleTotals; signedString: string } {
  const totals = saleTotals(draft);
  const mont: TransCore['mont'] = {
    avantTax: mevAmount(totals.subtotalCents),
    TPS: mevAmount(totals.tpsCents),
    TVQ: mevAmount(totals.tvqCents),
    apresTax: mevAmount(totals.totalCents),
  };
  if (draft.tipCents) mont.pourb = mevAmount(draft.tipCents);
  const core: Omit<TransCore, 'signa'> = {
    noTrans: chain.noTrans,
    datTrans: chain.datTrans,
    utc: chain.utc,
    typTrans: draft.typTrans,
    modTrans: draft.modTrans,
    modImpr: draft.modImpr,
    formImpr: draft.formImpr,
    modPai: draft.modPai,
    sectActi: {
      abrvt: 'RBC',
      ...(draft.typServ ? { typServ: draft.typServ } : {}),
      ...(draft.noTabl ? { noTabl: draft.noTabl } : {}),
      ...(draft.nbClint ? { nbClint: draft.nbClint } : {}),
    },
    commerElectr: draft.ecommerce ? 'O' : 'N',
    nomUtil: chain.nomUtil,
    items: toMevItems(draft.lines),
    mont,
    ...(chain.ref ? { refs: [{ noTrans: chain.ref.noTrans, datTrans: chain.ref.datTrans, avantTax: mevAmount(chain.ref.subtotalCents) }] } : {}),
  };
  const signedString = transactionSignedString({
    noTrans: core.noTrans,
    datTrans: core.datTrans,
    TPS: mont.TPS,
    TVQ: mont.TVQ,
    apresTax: mont.apresTax,
    noTPS: identity.noTPS,
    noTVQ: identity.noTVQ,
    modImpr: core.modImpr,
    modTrans: core.modTrans,
    preced: chain.preced,
  });
  return { core, totals, signedString };
}

export class SaleRuleError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
  }
}

/** Rules Revenu Québec states publicly (PROVEN) plus the contract's own rules. Throws SaleRuleError. */
export function assertSaleRules(draft: SaleDraft, totals: SaleTotals): void {
  if (!draft.lines.length) throw new SaleRuleError('lines', 'a transaction needs at least one line');
  if (draft.ecommerce && (draft.modPai === 'ARG' || draft.modPai === 'CHQ')) {
    throw new SaleRuleError('payment.mode', 'cash and cheque are not allowed for an e-commerce sale (commerElectr=O)');
  }
  if (draft.modPai === 'INC' && !draft.lines.some((l) => l.activity === 'BAR')) {
    throw new SaleRuleError('payment.mode', 'payment mode "inconnu" is only allowed for a drink served without food (bar permit)');
  }
  if (draft.documentKind === 'RECEIPT' && totals.totalCents === 0 && draft.modPai !== 'AUC') {
    throw new SaleRuleError('payment.mode', 'a $0 receipt must use payment mode AUC (aucun paiement)');
  }
  if (draft.documentKind === 'CREDIT_NOTE' && totals.totalCents > 0) {
    throw new SaleRuleError('amounts', 'a credit note must have negative amounts');
  }
  if (draft.documentKind === 'RECEIPT' && totals.subtotalCents < 0) {
    throw new SaleRuleError('amounts', 'a receipt cannot have a negative subtotal; use a credit note');
  }
  if (draft.tipCents && draft.typServ === 'LVT') {
    throw new SaleRuleError('amounts.tipCents', 'a platform courier tip is not the restaurant\'s supply and is never transmitted');
  }
  for (const [i, l] of draft.lines.entries()) {
    if (!l.description.trim()) throw new SaleRuleError(`lines[${i}].description`, 'description is required');
  }
}
