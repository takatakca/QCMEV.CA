/**
 * Receipt renderer: the exact 80 mm text, the electronic version, an HTML fragment, the QR (SVG and PNG) and renderHash.
 * Food Hub prints these bytes as received and never builds an invoice itself.
 *
 * Layout (PROVEN: SW-76 2025-06 §4.4.1 and Revenu Québec's « Exemple de facture – restauration » page):
 *   before the first "=" line   name and address, moment of transmission (datTrans), transaction number, the items,
 *                               the subtotal, the TPS and TVQ registration numbers, the payment mode; on a credit note
 *                               « Crédité à : » and « Date de la remise : » with a line to fill by hand;
 *   "=" line, then in this order the TPS, the TVQ, the TOTAL, (if any) the tip, the mention (« PAIEMENT REÇU »…),
 *                               the QR code (on an electronic invoice the link « Consulter la transaction en ligne »
 *                               right under it), the moment MEV-WEB processed it (psiDatTrans), MEV-WEB's transaction
 *                               number (psiNoTrans), the device id (IDAPPRL);
 *   "=" line                    closes the block. The footer (pied de page) carries « REPRODUCTION », and on a merchant
 *                               copy « ***COPIE DU COMMERÇANT*** » + « NE PAS REMETTRE AU CLIENT » (« Modes d'impression »).
 * Offline (PROVEN, « Transmission des renseignements exigés », Problème de communication): the missing processing time and
 * MEV-WEB transaction number are each replaced by « PROBLÈME DE COMMUNICATION ».
 * Corrections (PROVEN, « Utilisation de références »): « Facture corrigée » / « Note de crédit corrigée ».
 * Electronic support (PROVEN, « Modes d'impression »): on PEL, the electronic document carries « Copie électronique ».
 * SPEC: only the invalid-certificate wording and the free-text lines (order number, reference) wait for SW-73.B.
 */
import * as QRCode from 'qrcode';
import { sha256Hex } from '../common/canonical-json';
import { receiptAmount, TPS_RATE_LABEL, TVQ_RATE_LABEL } from '../common/money';
import { displayDatTrans } from '../common/time';

export const RECEIPT_WIDTH = 42;
export const LINK_TEXT = 'Consulter la transaction en ligne';
/** The line where the QR code is printed (the printer or page replaces it with the image). */
export const QR_MARKER = '[CODE QR]';

export const MENTION = {
  PAID: 'PAIEMENT REÇU',
  CREDIT_NOTE: 'NOTE DE CRÉDIT',
  CORRECTED_INVOICE: 'Facture corrigée',
  CORRECTED_CREDIT_NOTE: 'Note de crédit corrigée',
  ORIGINAL: 'FACTURE ORIGINALE',
  REPRODUCTION: 'REPRODUCTION',
  MERCHANT_COPY: '***COPIE DU COMMERÇANT***',
  DO_NOT_GIVE: 'NE PAS REMETTRE AU CLIENT',
  TRAINING: '***DOCUMENT DE FORMATION***',
  PLATFORM: 'COMMANDE PAR UNE PLATEFORME NUMÉRIQUE',
  ELECTRONIC: 'Copie électronique',
  NOT_PAID: 'PAIEMENT NON REÇU',
  COMMUNICATION_PROBLEM: 'PROBLÈME DE COMMUNICATION',
  /** SPEC wording. Never on a new invoice: with an expired certificate no invoice is produced (TransactionsService.issue). */
  INVALID_CERT: '*** CERTIFICAT INVALIDE ***',
  ESTIMATE: 'ESTIMATION DES RENSEIGNEMENTS',
  QUOTE: 'SOUMISSION',
} as const;

/** Mentions printed in the footer, after the closing "=" line. Every other mention goes inside the block. */
const FOOTER_MENTIONS: readonly string[] = [MENTION.REPRODUCTION, MENTION.MERCHANT_COPY, MENTION.DO_NOT_GIVE, MENTION.TRAINING, MENTION.ELECTRONIC];

const PAYMENT_LABEL: Record<string, string> = {
  ARG: 'Argent comptant',
  CHQ: 'Chèque',
  CRE: 'Carte de crédit',
  DEB: 'Carte de débit',
  CPR: 'Certificat-cadeau',
  MIX: 'Paiement mixte',
  AUT: 'Autre',
  INC: 'Inconnu',
  AUC: 'Aucun paiement',
};

export interface ReceiptLine {
  description: string;
  quantity: string;
  unitPriceCents: number;
  totalCents: number;
  tax: string;
  isModifier: boolean;
}

export interface ReceiptInput {
  merchant: { name: string; address?: string | null; city?: string | null; noTPS: string; noTVQ: string };
  documentKind: string;
  typTrans: string;
  modImpr: string;
  formImpr: string;
  modTrans: string;
  typServ?: string | null;
  modPai: string;
  noTrans: string;
  datTrans: string;
  utc: string;
  deviceId: string;
  externalRef?: string | null;
  lines: ReceiptLine[];
  subtotalCents: number;
  tpsCents: number;
  tvqCents: number;
  totalCents: number;
  tipCents?: number | null;
  reference?: { noTrans: string; datTrans: string } | null;
  /** Set when this document corrects an earlier closing receipt (RECEIPT) or credit note (CREDIT_NOTE). */
  corrects?: 'RECEIPT' | 'CREDIT_NOTE' | null;
  /** Credit note: the customer's name, when known (otherwise a line to fill by hand). */
  creditedTo?: string | null;
  mevStatus: string;
  /** MEV-WEB's processing time (psiDatTrans) and transaction number (psiNoTrans). */
  mevProcessedAt?: string | null;
  mevTransactionNumber?: string | null;
  certificateInvalid?: boolean;
  qrContent: string;
}

export interface RenderedDocument {
  mentions: string[];
  /** 42 columns; the QR code goes on the line equal to center(QR_MARKER). */
  lines: string[];
  html: string;
}

export interface RenderedReceipt {
  /** Mentions of the main document (the paper one, or the electronic one when there is no paper). */
  mentions: string[];
  /** The main document: printed exactly as is (the QR on the [CODE QR] line). */
  text80mm: string[];
  /** HTML fragment of the main document, QR in place (and the link under it when the document is electronic). */
  html: string;
  /** The electronic document (formImpr ELE or PEL): « Copie électronique » on PEL, the link under the QR. */
  electronic: RenderedDocument | null;
  qr: { content: string; svg: string; pngDataUrl: string };
  renderHash: string;
}

const isOffline = (r: ReceiptInput) => r.mevStatus === 'OFFLINE_PENDING' || r.mevStatus === 'RETRY_BATCH';

/** The mentions of one document. `electronic` = the version produced on electronic support. */
export function receiptMentions(r: ReceiptInput, electronic = r.formImpr === 'ELE'): string[] {
  const m: string[] = [];
  const notPaid = r.modImpr === 'PSP' || (r.modImpr === 'DUP' && r.modPai === 'AUC' && r.totalCents !== 0);
  if (r.typTrans === 'ADDI') m.push(MENTION.ORIGINAL);
  if (r.typTrans === 'ESTM') m.push(MENTION.ESTIMATE);
  if (r.typTrans === 'SOUM') m.push(MENTION.QUOTE);
  if (r.typTrans === 'RFER') m.push(r.documentKind === 'CREDIT_NOTE' ? MENTION.CREDIT_NOTE : notPaid ? MENTION.NOT_PAID : MENTION.PAID);
  if (r.corrects === 'RECEIPT') m.push(MENTION.CORRECTED_INVOICE);
  if (r.corrects === 'CREDIT_NOTE') m.push(MENTION.CORRECTED_CREDIT_NOTE);
  if (r.typServ === 'LVT') m.push(MENTION.PLATFORM);
  if (r.certificateInvalid) m.push(MENTION.INVALID_CERT);
  if (isOffline(r) || !r.mevTransactionNumber) m.push(MENTION.COMMUNICATION_PROBLEM);
  // Footer
  if (r.modImpr === 'RPR') m.push(MENTION.REPRODUCTION);
  if (r.modImpr === 'DUP') m.push(MENTION.MERCHANT_COPY, MENTION.DO_NOT_GIVE);
  if (r.modTrans === 'FOR') m.push(MENTION.TRAINING, MENTION.DO_NOT_GIVE);
  if (electronic && r.formImpr === 'PEL') m.push(MENTION.ELECTRONIC);
  return [...new Set(m)];
}

export function center(s: string): string {
  if (s.length >= RECEIPT_WIDTH) return s.slice(0, RECEIPT_WIDTH);
  const pad = Math.floor((RECEIPT_WIDTH - s.length) / 2);
  return `${' '.repeat(pad)}${s}`;
}

export function leftRight(left: string, right: string): string {
  const room = RECEIPT_WIDTH - right.length - 1;
  const l = left.length > room ? left.slice(0, room) : left;
  return `${l}${' '.repeat(RECEIPT_WIDTH - l.length - right.length)}${right}`;
}

/**
 * Greedy word wrap over unbreakable tokens, joined by one space; `indent` starts every line after the first. A line is
 * only ever broken between two tokens: the one exception is a single token longer than a whole line, which is cut.
 */
export function wrapTokens(tokens: string[], indent = '', width = RECEIPT_WIDTH): string[] {
  const ind = indent.length < width - 1 ? indent : '';
  const out: string[] = [];
  let cur: string | null = null;
  for (const token of tokens) {
    if (cur !== null && cur.length + 1 + token.length <= width) {
      cur += ` ${token}`;
      continue;
    }
    if (cur !== null) out.push(cur);
    let start = out.length ? ind : '';
    let rest = token;
    while (start.length + rest.length > width) {
      const room = width - start.length;
      out.push(start + rest.slice(0, room));
      rest = rest.slice(room);
      start = ind;
    }
    cur = start + rest;
  }
  if (cur !== null) out.push(cur);
  return out.length ? out : [''];
}

/** Word wrap at the spaces of `s` (never in the middle of a word, a number, a date or a time). */
export function wrap(s: string, indent = '', width = RECEIPT_WIDTH): string[] {
  if (s.length <= width) return [s];
  return wrapTokens(s.split(' ').filter(Boolean), indent, width);
}

/** An item: the amount and tax code on the first line at the right; a long description wraps under itself. */
export function itemLines(prefix: string, description: string, right: string): string[] {
  const room = RECEIPT_WIDTH - right.length - 1 - prefix.length;
  const parts = wrapTokens(description.split(' ').filter(Boolean), '', Math.max(room, 8));
  return parts.map((p, i) => (i === 0 ? leftRight(`${prefix}${p}`, right) : `${' '.repeat(prefix.length)}${p}`));
}

/** The reference to the original transaction; « du <date> <heure> » is kept whole on its own line when it wraps. */
export function referenceLines(ref: { noTrans: string; datTrans: string }): string[] {
  return wrapTokens(['Réf.', ':', 'transaction', ref.noTrans, `du ${displayDatTrans(ref.datTrans)}`]);
}

/** psiDatTrans as printed: AAAAMMJJhhmmss → "AAAA-MM-JJ hh:mm:ss"; any other format as received. */
export function displayProcessedAt(v: string): string {
  return /^\d{14}$/.test(v) ? displayDatTrans(v) : v;
}

export const QR_LINE = center(QR_MARKER);

export function renderText(r: ReceiptInput, mentions: string[], electronic = false): string[] {
  const L: string[] = [];
  const rule = '='.repeat(RECEIPT_WIDTH);
  const dash = '-'.repeat(RECEIPT_WIDTH);
  const creditNote = r.documentKind === 'CREDIT_NOTE';

  // ── Before the first "=" line ──
  // Every free-text line wraps at word boundaries (wrap / wrapTokens): never wider than 42, never a cut word or time.
  L.push(...wrap(r.merchant.name).map(center));
  if (r.merchant.address) L.push(...wrap(r.merchant.address).map(center));
  if (r.merchant.city) L.push(...wrap(r.merchant.city).map(center));
  L.push(dash);
  L.push(...wrap(`Date : ${displayDatTrans(r.datTrans)} (${r.utc})`));
  L.push(...wrap(`Transaction : ${r.noTrans}`));
  if (r.externalRef) L.push(...wrap(`Commande : ${r.externalRef}`));
  if (r.reference) L.push(...referenceLines(r.reference));
  L.push(dash);
  for (const line of r.lines) {
    const qty = line.isModifier ? '  + ' : `${line.quantity} x `;
    L.push(...itemLines(qty, line.description, `${receiptAmount(line.totalCents)} ${line.tax}`));
  }
  L.push(dash);
  L.push(leftRight('Sous-total', receiptAmount(r.subtotalCents)));
  L.push(...wrap(`No TPS : ${r.merchant.noTPS}`));
  L.push(...wrap(`No TVQ : ${r.merchant.noTVQ}`));
  L.push(...wrap(`Paiement : ${PAYMENT_LABEL[r.modPai] ?? r.modPai}`));
  if (creditNote) {
    L.push(...(r.creditedTo ? wrap(`Crédité à : ${r.creditedTo}`, '  ') : [`Crédité à : ${'_'.repeat(RECEIPT_WIDTH - 12)}`]));
    L.push(`Date de la remise : ${'_'.repeat(RECEIPT_WIDTH - 20)}`);
  }

  // ── The block, in Revenu Québec's order ──
  L.push(rule);
  L.push(leftRight(`TPS ${TPS_RATE_LABEL} :`, receiptAmount(r.tpsCents)));
  L.push(leftRight(`TVQ ${TVQ_RATE_LABEL} :`, receiptAmount(r.tvqCents)));
  L.push(leftRight('TOTAL :', receiptAmount(r.totalCents)));
  if (r.tipCents) L.push(leftRight('Pourboire :', receiptAmount(r.tipCents)));
  const inBlock = mentions.filter((m) => !FOOTER_MENTIONS.includes(m) && m !== MENTION.COMMUNICATION_PROBLEM);
  inBlock.forEach((m) => L.push(...wrap(m).map(center)));
  L.push(QR_LINE);
  if (electronic) L.push(center(LINK_TEXT));
  const offline = isOffline(r) || !r.mevTransactionNumber;
  L.push(...wrap(offline || !r.mevProcessedAt ? MENTION.COMMUNICATION_PROBLEM : displayProcessedAt(r.mevProcessedAt)).map(center));
  L.push(...wrap(offline ? MENTION.COMMUNICATION_PROBLEM : (r.mevTransactionNumber as string)).map(center));
  L.push(...wrap(r.deviceId).map(center));
  L.push(rule);

  // ── Footer ──
  mentions.filter((m) => FOOTER_MENTIONS.includes(m)).forEach((m) => L.push(...wrap(m).map(center)));
  return L;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function htmlOf(lines: string[], svg: string, link: string | null): string {
  const at = lines.indexOf(QR_LINE);
  const before = (at >= 0 ? lines.slice(0, at) : lines).map(esc).join('\n');
  let rest = at >= 0 ? lines.slice(at + 1) : [];
  if (link && rest[0]?.trim() === LINK_TEXT) rest = rest.slice(1);
  return [
    '<div class="qcmev-receipt" style="font-family:monospace;white-space:pre;width:42ch">',
    `<pre style="margin:0">${before}</pre>`,
    `<div class="qcmev-qr" style="width:42ch;text-align:center">${svg}</div>`,
    link ? `<p style="margin:0;text-align:center"><a href="${esc(link)}">${esc(LINK_TEXT)}</a></p>` : '',
    `<pre style="margin:0">${rest.map(esc).join('\n')}</pre>`,
    '</div>',
  ].join('');
}

export async function renderReceipt(r: ReceiptInput): Promise<RenderedReceipt> {
  const svg = await QRCode.toString(r.qrContent, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  const pngDataUrl = await QRCode.toDataURL(r.qrContent, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
  const hasElectronic = r.formImpr === 'ELE' || r.formImpr === 'PEL';
  let electronic: RenderedDocument | null = null;
  if (hasElectronic) {
    const mentions = receiptMentions(r, true);
    const lines = renderText(r, mentions, true);
    electronic = { mentions, lines, html: htmlOf(lines, svg, r.qrContent) };
  }
  // Main document: the paper one (PAP, PEL, or NON as a record), the electronic one when there is no paper (ELE).
  const main: RenderedDocument = r.formImpr === 'ELE' && electronic
    ? electronic
    : (() => { const mentions = receiptMentions(r, false); const lines = renderText(r, mentions, false); return { mentions, lines, html: htmlOf(lines, svg, null) }; })();
  return {
    mentions: main.mentions,
    text80mm: main.lines,
    html: main.html,
    electronic,
    qr: { content: r.qrContent, svg, pngDataUrl },
    renderHash: sha256Hex(main.lines.join('\n')),
  };
}

/**
 * QR content: <MEV_QR_BASE_URL>?f=<data encrypted with MEV-WEB's certificate> (SW-76 §4.2.1; scheme SPEC, see
 * crypto/qr-crypto.ts). The data: {a: IDAPPRL, n: noTrans, d: datTrans, m: apresTax, s: start of the signature} (SPEC).
 */
export function qrPayload(f: { idApprl: string; noTrans: string; datTrans: string; apresTax: string; signature: string }): string {
  return JSON.stringify({ a: f.idApprl, n: f.noTrans, d: f.datTrans, m: f.apresTax, s: f.signature.slice(0, 12) });
}

export function qrContent(baseUrl: string, encryptedPayload: string): string {
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}f=${encodeURIComponent(encryptedPayload)}`;
}
