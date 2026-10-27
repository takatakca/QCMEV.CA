/**
 * Runtime check of a transaction before it is sent to MEV-WEB (replaces the `as unknown as TransCore` cast).
 *
 * The transaction part is stored as Prisma JSON (Transaction.requestJson) and rebuilt from it at send time, live or
 * from the offline queue: TypeScript cannot vouch for its shape. A malformed or tampered record is caught here, before
 * it is signed into a batch, instead of being refused by Revenu Québec (or accepted with bad data).
 *
 * The rules mirror mev-web.types.ts (official names) and the public formats (PROVEN: datTrans AAAAMMJJhhmmss, utc,
 * 88-character signatures, typTrans / modTrans / modImpr / formImpr / modPai / typServ values). Lengths and the
 * mandatory/optional matrix are SPEC (SW-73.A). No external dependency on purpose.
 */
import type { TransActu, TransCore } from './mev-web.types';

export class InvalidMevPayloadError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid MEV-WEB transaction: ${problems.join('; ')}`);
    this.name = 'InvalidMevPayloadError';
  }
}

type Obj = Record<string, unknown>;

const AMOUNT = /^-?\d+\.\d{2}$/;
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/;
const FIRST_PRECED = '='.repeat(88);
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const oneOf = (v: unknown, values: readonly string[]): boolean => typeof v === 'string' && values.includes(v);

const TYP_TRANS = ['ADDI', 'ESTM', 'RFER', 'SOUM'] as const;
const MOD_TRANS = ['OPE', 'FOR'] as const;
const MOD_IMPR = ['FAC', 'RPR', 'DUP', 'ANN', 'PSP'] as const;
const FORM_IMPR = ['PAP', 'ELE', 'PEL', 'NON'] as const;
const MOD_PAI = ['ARG', 'CHQ', 'CRE', 'DEB', 'CPR', 'MIX', 'AUT', 'INC', 'AUC'] as const;
const TYP_SERV = ['CMP', 'LVR', 'LVT', 'TBL'] as const;
const TAX = ['FP', 'F', 'P', 'NON'] as const;
const ACTI = ['RES', 'BAR', 'NON'] as const;

function checkCore(t: Obj, p: string[]): void {
  if (!isText(t.noTrans) || (t.noTrans as string).length > 10) p.push('noTrans missing or longer than 10 characters');
  if (typeof t.datTrans !== 'string' || !/^\d{14}$/.test(t.datTrans)) p.push('datTrans must be AAAAMMJJhhmmss');
  if (!oneOf(t.utc, ['-04:00', '-05:00'])) p.push('utc must be -04:00 or -05:00');
  if (!oneOf(t.typTrans, TYP_TRANS)) p.push(`typTrans invalid (${String(t.typTrans)})`);
  if (!oneOf(t.modTrans, MOD_TRANS)) p.push(`modTrans invalid (${String(t.modTrans)})`);
  if (!oneOf(t.modImpr, MOD_IMPR)) p.push(`modImpr invalid (${String(t.modImpr)})`);
  if (!oneOf(t.formImpr, FORM_IMPR)) p.push(`formImpr invalid (${String(t.formImpr)})`);
  if (!oneOf(t.modPai, MOD_PAI)) p.push(`modPai invalid (${String(t.modPai)})`);
  if (!oneOf(t.commerElectr, ['O', 'N'])) p.push('commerElectr must be O or N');
  if (!isText(t.nomUtil)) p.push('nomUtil missing (user not registered with UTL?)');

  const s = t.sectActi;
  if (!isObj(s)) p.push('sectActi missing');
  else {
    if (s.abrvt !== 'RBC') p.push(`sectActi.abrvt must be RBC (got ${String(s.abrvt)})`);
    if (s.typServ !== undefined && !oneOf(s.typServ, TYP_SERV)) p.push(`sectActi.typServ invalid (${String(s.typServ)})`);
    if (s.noTabl !== undefined && typeof s.noTabl !== 'string') p.push('sectActi.noTabl must be a string when present');
    if (s.nbClint !== undefined && (!Number.isInteger(s.nbClint) || (s.nbClint as number) < 0)) p.push('sectActi.nbClint must be a non-negative integer when present');
  }

  if (!Array.isArray(t.items) || !t.items.length) p.push('items must be a non-empty array');
  else {
    t.items.forEach((it, i) => {
      if (!isObj(it)) return void p.push(`items[${i}] is not an object`);
      if (!isText(it.descr)) p.push(`items[${i}].descr missing`);
      if (typeof it.qte !== 'string' || !/^\d{1,6}(\.\d{1,3})?$/.test(it.qte)) p.push(`items[${i}].qte must be a decimal string`);
      for (const k of ['unitr', 'prix'] as const) if (typeof it[k] !== 'string' || !AMOUNT.test(it[k] as string)) p.push(`items[${i}].${k} must be an amount like "12.34"`);
      if (!oneOf(it.tax, TAX)) p.push(`items[${i}].tax invalid (${String(it.tax)})`);
      if (!oneOf(it.acti, ACTI)) p.push(`items[${i}].acti invalid (${String(it.acti)})`);
    });
  }

  const m = t.mont;
  if (!isObj(m)) p.push('mont missing');
  else {
    for (const k of ['avantTax', 'TPS', 'TVQ', 'apresTax'] as const) if (typeof m[k] !== 'string' || !AMOUNT.test(m[k] as string)) p.push(`mont.${k} must be an amount like "12.34"`);
    for (const k of ['pourb', 'ajus', 'mtdu', 'versActu', 'versAnt', 'sold'] as const) {
      if (m[k] !== undefined && (typeof m[k] !== 'string' || !AMOUNT.test(m[k] as string))) p.push(`mont.${k} must be an amount when present`);
    }
  }

  if (t.refs !== undefined) {
    if (!Array.isArray(t.refs)) p.push('refs must be an array when present');
    else t.refs.forEach((r, i) => {
      if (!isObj(r) || !isText(r.noTrans) || typeof r.datTrans !== 'string' || !/^\d{14}$/.test(r.datTrans) || typeof r.avantTax !== 'string' || !AMOUNT.test(r.avantTax)) {
        p.push(`refs[${i}] needs noTrans, datTrans (AAAAMMJJhhmmss) and avantTax`);
      }
    });
  }

  const sg = t.signa;
  if (!isObj(sg)) p.push('signa missing');
  else {
    if (typeof sg.actu !== 'string' || !SIGNATURE.test(sg.actu)) p.push('signa.actu must be an 88-character signature');
    if (typeof sg.preced !== 'string' || !(SIGNATURE.test(sg.preced) || sg.preced === FIRST_PRECED)) p.push('signa.preced must be an 88-character signature (88 "=" for the first one)');
    if (typeof sg.datActu !== 'string' || !/^\d{14}$/.test(sg.datActu)) p.push('signa.datActu must be AAAAMMJJhhmmss');
  }
}

/** The stored transaction part (identity values excluded). Throws InvalidMevPayloadError listing every problem. */
export function assertTransCore(value: unknown): asserts value is TransCore {
  if (!isObj(value)) throw new InvalidMevPayloadError(['the transaction is not an object']);
  const p: string[] = [];
  checkCore(value, p);
  if (p.length) throw new InvalidMevPayloadError(p);
}

/** The transaction as sent (with noDossFO / noTPS / noTVQ). Throws InvalidMevPayloadError listing every problem. */
export function assertTransActu(value: unknown): asserts value is TransActu {
  if (!isObj(value)) throw new InvalidMevPayloadError(['the transaction is not an object']);
  const p: string[] = [];
  checkCore(value, p);
  for (const k of ['noDossFO', 'noTPS', 'noTVQ'] as const) if (!isText(value[k])) p.push(`${k} missing`);
  if (p.length) throw new InvalidMevPayloadError(p);
}
