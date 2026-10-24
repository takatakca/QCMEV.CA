/**
 * WEB-SRM (MEV-WEB) message types, with Revenu Québec's public field names.
 *
 * Tags used in comments:
 *   PROVEN = shown in a public Revenu Québec document;
 *   S1     = only in Revenu Québec's 2022 sample code;
 *   SPEC   = must be confirmed against SW-73 / SW-73.A / SW-73.B / SW-73.D (exact nesting, field order,
 *            mandatory/optional matrix, version header values) before certification.
 * The JSON nesting below as a whole is SPEC.
 */

export type MevRequestKind = 'CRT' | 'UTL' | 'TRX' | 'DOC';

/** HTTP headers (PROVEN names). */
export interface MevHeaders {
  ENVIRN: 'DEV' | 'ESSAI' | 'PROD';
  CASESSAI?: string;
  /** SEV = the request comes from the SEV itself (QCMEV's mode, SW-76 §4.1.2); SRV would be a forwarding server. */
  APPRLINIT: 'SEV';
  IDAPPRL?: string;
  IDSEV: string;
  IDVERSI: string;
  CODCERTIF: string;
  IDPARTN: string;
  VERSI: string;
  VERSIPARN: string;
  /** CRT only (S1). */
  CODAUTORI?: string;
  NOTPS?: string;
  NOTVQ?: string;
  /** Signature of the raw body with the SEV key, 88 characters (S1). */
  SIGNATRANSM?: string;
  /** SHA-1 thumbprint of the SEV certificate (S1). */
  EMPRCERTIFTRANSM?: string;
}

export type Modif = 'AJO' | 'SUP' | 'VAL' | 'REM';

export interface ReqCertif {
  reqCertif: { modif: Modif; csr: string; noSerie?: string };
}

export interface ReqUtil {
  reqUtil: { modif: Modif; nomUtil: string; noTax: string };
}

export interface MevItem {
  qte: string;
  descr: string;
  unitr: string;
  prix: string;
  tax: 'FP' | 'F' | 'P' | 'NON';
  acti: 'RES' | 'BAR' | 'NON';
}

export interface MevAmounts {
  avantTax: string;
  TPS: string;
  TVQ: string;
  apresTax: string;
  ajus?: string;
  mtdu?: string;
  pourb?: string;
  versActu?: string;
  versAnt?: string;
  sold?: string;
}

export interface MevReference {
  noTrans: string;
  datTrans: string;
  avantTax: string;
}

/** One transaction, without identity values (noDossFO / noTPS / noTVQ are added at send time). */
export interface TransCore {
  noTrans: string;
  datTrans: string;
  utc: string;
  typTrans: 'ADDI' | 'ESTM' | 'RFER' | 'SOUM';
  modTrans: 'OPE' | 'FOR';
  modImpr: 'FAC' | 'RPR' | 'DUP' | 'ANN' | 'PSP';
  formImpr: 'PAP' | 'ELE' | 'PEL' | 'NON';
  modPai: string;
  sectActi: { abrvt: 'RBC' | 'TRP'; typServ?: 'CMP' | 'LVR' | 'LVT' | 'TBL'; noTabl?: string; nbClint?: number };
  commerElectr: 'O' | 'N';
  nomUtil: string;
  items: MevItem[];
  mont: MevAmounts;
  refs?: MevReference[];
  signa: { actu: string; preced: string; datActu: string };
}

export interface TransActu extends TransCore {
  noDossFO: string;
  noTPS: string;
  noTVQ: string;
}

export interface ReqTrans {
  reqTrans: { transActu?: TransActu; transLot?: TransActu[] };
}

/**
 * Sales summary of the user report. The CONTENT is PROVEN (« Production du rapport de l'utilisateur »: the year, the
 * total number of transactions, the number of payment transactions, the amount before taxes, the TPS and TVQ, the
 * amount after taxes, the adjusted amount, the total amount due); every field NAME is SPEC (SW-73.D): avantTax / TPS /
 * TVQ / apresTax / ajus / mtdu reuse the transaction's names (S1), nbTrans / nbTransPai are QCMEV placeholders.
 */
export interface SommVentes {
  nbTrans: number;
  nbTransPai: number;
  avantTax: string;
  TPS: string;
  TVQ: string;
  apresTax: string;
  ajus: string;
  mtdu: string;
}

export interface ReqDoc {
  reqDoc: {
    typDoc: 'RUT';
    noDossFO: string;
    noTPS: string;
    noTVQ: string;
    annee: number;
    datDoc: string;
    sommVentes: SommVentes;
    sommVentesAnt?: SommVentes;
  };
}

/** Error item (PROVEN shape {id, mess, codRetour}). */
export interface MevError {
  id: string;
  mess: string;
  codRetour: string;
}

export interface RetourCertif {
  retourCertif: { idApprl?: string; certif?: string; certifPSI?: string; casEssai?: string; listErr?: MevError[] };
}

export interface RetourUtil {
  retourUtil: { listErr?: MevError[] };
}

export interface RetourTransItem {
  noTrans?: string;
  psiNoTrans?: string;
  psiDatTrans?: string;
  listErr?: MevError[];
}

export interface RetourTrans {
  retourTrans: { retourTransActu?: RetourTransItem; retourTransLot?: RetourTransItem[]; listErr?: MevError[] };
}

export interface RetourDoc {
  retourDoc: { noDoc?: string; listErr?: MevError[] };
}

export type MevOutcome = 'accepted' | 'retry_batch' | 'rejected';

/**
 * Error classes (design R7, PROVEN): a codRetour ending in 0, 1 or 5 means "not sent": resend it in a batch with
 * the next transaction. Any other code is a rejection that needs a human, including the "HTTP" error QCMEV puts in a
 * 4xx answer that carries no listErr (mev-web.service.ts). An empty list is "accepted" only because MevWebService never
 * hands over a 4xx without errors, nor a 2xx that is not a MEV-WEB answer.
 */
export function classifyErrors(errors: MevError[] | undefined): MevOutcome {
  if (!errors || errors.length === 0) return 'accepted';
  const notSent = errors.every((e) => /[015]$/.test(String(e.codRetour ?? '')));
  return notSent ? 'retry_batch' : 'rejected';
}
