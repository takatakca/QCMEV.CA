/**
 * Runtime validation for MEV-WEB TRX payloads.
 *
 * Payloads stored in the offline queue are Prisma JSON — TypeScript cannot
 * guarantee their shape. Every payload is validated here BEFORE it is signed
 * and sent, so a malformed or tampered queue entry is caught locally instead
 * of being rejected by Revenu Québec (or worse, accepted with bad data).
 *
 * No external dependency on purpose: the rules mirror mev-web.dto.ts exactly.
 */

import {
  MevRequestTypeCode,
  PaymentModeCode,
  PrintModeCode,
  SectorCode,
  TaxCode,
  TransactionRequestPayload,
  TransactionTypeCode,
} from './dto/mev-web.dto';

export class InvalidMevPayloadError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid MEV-WEB TRX payload: ${problems.join('; ')}`);
    this.name = 'InvalidMevPayloadError';
  }
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isOneOf = <T extends string>(values: Record<string, T>, v: unknown): v is T =>
  typeof v === 'string' && (Object.values(values) as string[]).includes(v);

/**
 * Throws InvalidMevPayloadError listing every problem found.
 * On success, narrows `value` to TransactionRequestPayload.
 */
export function assertTransactionPayload(value: unknown): asserts value is TransactionRequestPayload {
  const p: string[] = [];

  if (!isObj(value)) throw new InvalidMevPayloadError(['payload is not an object']);

  // ── entete ──────────────────────────────────────────────────────────────
  const e = value.entete;
  if (!isObj(e)) {
    p.push('entete missing');
  } else {
    if (e.typeRequete !== MevRequestTypeCode.TRX) p.push(`entete.typeRequete must be TRX (got ${String(e.typeRequete)})`);
    if (!isNonEmptyString(e.codeSEV)) p.push('entete.codeSEV missing');
    if (!isNonEmptyString(e.versionSEV)) p.push('entete.versionSEV missing');
    if (!isNonEmptyString(e.typeAppareil)) p.push('entete.typeAppareil missing');
    if (!isNonEmptyString(e.numeroAppareil)) p.push('entete.numeroAppareil missing');
    if (typeof e.dateCivile !== 'string' || !/^\d{8}$/.test(e.dateCivile)) p.push('entete.dateCivile must be YYYYMMDD');
    if (typeof e.heureDebut !== 'string' || !/^\d{6}$/.test(e.heureDebut)) p.push('entete.heureDebut must be HHMMSS');
    if (typeof e.signature !== 'string') p.push('entete.signature must be a string');
  }

  // ── corps ───────────────────────────────────────────────────────────────
  const c = value.corps;
  if (!isObj(c)) {
    p.push('corps missing');
    throw new InvalidMevPayloadError(p);
  }
  if (!isNonEmptyString(c.neq)) p.push('corps.neq missing');
  if (typeof c.codeAutorisation !== 'string') p.push('corps.codeAutorisation must be a string');
  if (!isOneOf(SectorCode, c.secteur)) p.push(`corps.secteur invalid (${String(c.secteur)})`);

  // ── corps.transaction ───────────────────────────────────────────────────
  const t = c.transaction;
  if (!isObj(t)) {
    p.push('corps.transaction missing');
    throw new InvalidMevPayloadError(p);
  }

  if (!Number.isInteger(t.numeroTransaction) || (t.numeroTransaction as number) < 1) {
    p.push('transaction.numeroTransaction must be a positive integer');
  }
  if (!isOneOf(TransactionTypeCode, t.typeTransaction)) p.push(`transaction.typeTransaction invalid (${String(t.typeTransaction)})`);
  for (const k of ['montantSousTotal', 'montantTPS', 'montantTVQ', 'montantTotal'] as const) {
    if (!isFiniteNumber(t[k])) p.push(`transaction.${k} must be a number`);
  }
  for (const k of ['montantPourboire', 'montantRemise'] as const) {
    if (t[k] !== undefined && t[k] !== null && !isFiniteNumber(t[k])) p.push(`transaction.${k} must be a number when present`);
  }
  if (!isOneOf(PaymentModeCode, t.modePaiement)) p.push(`transaction.modePaiement invalid (${String(t.modePaiement)})`);
  if (!isOneOf(PrintModeCode, t.modeImpression)) p.push(`transaction.modeImpression invalid (${String(t.modeImpression)})`);
  if (t.numeroTable !== undefined && t.numeroTable !== null && typeof t.numeroTable !== 'string') {
    p.push('transaction.numeroTable must be a string when present');
  }
  if (t.nombreCouverts !== undefined && t.nombreCouverts !== null &&
      (!Number.isInteger(t.nombreCouverts) || (t.nombreCouverts as number) < 0)) {
    p.push('transaction.nombreCouverts must be a non-negative integer when present');
  }
  if (typeof t.hashChaine !== 'string' || !/^[a-f0-9]{64}$/.test(t.hashChaine)) {
    p.push('transaction.hashChaine must be a 64-char lowercase hex SHA-256');
  }
  if (!isNonEmptyString(t.identifiantUtilisateur)) {
    p.push('transaction.identifiantUtilisateur missing (user not registered with MEV-WEB?)');
  }

  if (!Array.isArray(t.fournitures)) {
    p.push('transaction.fournitures must be an array');
  } else {
    t.fournitures.forEach((f, i) => {
      if (!isObj(f)) { p.push(`fournitures[${i}] is not an object`); return; }
      if (!isNonEmptyString(f.description)) p.push(`fournitures[${i}].description missing`);
      for (const k of ['quantite', 'prixUnitaire', 'montantTotal', 'montantTPS', 'montantTVQ'] as const) {
        if (!isFiniteNumber(f[k])) p.push(`fournitures[${i}].${k} must be a number`);
      }
      if (f.codeTaxe !== '' && !isOneOf(TaxCode, f.codeTaxe)) p.push(`fournitures[${i}].codeTaxe invalid (${String(f.codeTaxe)})`);
    });
  }

  if (p.length) throw new InvalidMevPayloadError(p);
}
