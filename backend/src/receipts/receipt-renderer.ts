/**
 * Receipt renderer: the exact 80 mm text, an HTML fragment, the QR (SVG and PNG) and renderHash.
 * Food Hub prints these bytes as received and never builds an invoice itself.
 *
 * Mentions (PROVEN, Revenu Québec public pages): « PAIEMENT REÇU », « NOTE DE CRÉDIT », « FACTURE ORIGINALE »,
 * « REPRODUCTION », « ***COPIE DU COMMERÇANT*** » + « NE PAS REMETTRE AU CLIENT », « ***DOCUMENT DE FORMATION*** »,
 * « COMMANDE PAR UNE PLATEFORME NUMÉRIQUE », « Copie électronique », « PAIEMENT NON REÇU ».
 * SPEC: the exact layout, line order and the offline / invalid-certificate wording wait for SW-73.B.
 */
import * as QRCode from 'qrcode';
import { sha256Hex } from '../common/canonical-json';
import { receiptAmount, TPS_RATE_LABEL, TVQ_RATE_LABEL } from '../common/money';
import { displayDatTrans } from '../common/time';

export const RECEIPT_WIDTH = 42;
export const LINK_TEXT = 'Consulter la transaction en ligne';

export const MENTION = {
  PAID: 'PAIEMENT REÇU',
  CREDIT_NOTE: 'NOTE DE CRÉDIT',
  ORIGINAL: 'FACTURE ORIGINALE',
  REPRODUCTION: 'REPRODUCTION',
  MERCHANT_COPY: '***COPIE DU COMMERÇANT***',
  DO_NOT_GIVE: 'NE PAS REMETTRE AU CLIENT',
  TRAINING: '***DOCUMENT DE FORMATION***',
  PLATFORM: 'COMMANDE PAR UNE PLATEFORME NUMÉRIQUE',
  ELECTRONIC: 'Copie électronique',
  NOT_PAID: 'PAIEMENT NON REÇU',
  OFFLINE: 'TRANSACTION EN MODE HORS LIGNE', // SPEC
  INVALID_CERT: '*** CERTIFICAT INVALIDE ***', // SPEC
  ESTIMATE: 'ESTIMATION DES RENSEIGNEMENTS',
  QUOTE: 'SOUMISSION',
} as const;

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
  mevStatus: string;
  mevTransactionNumber?: string | null;
  certificateInvalid?: boolean;
  qrContent: string;
}

export interface RenderedReceipt {
  mentions: string[];
  text80mm: string[];
  html: string;
  qr: { content: string; svg: string; pngDataUrl: string };
  renderHash: string;
}

export function receiptMentions(r: ReceiptInput): string[] {
  const m: string[] = [];
  if (r.modTrans === 'FOR') m.push(MENTION.TRAINING, MENTION.DO_NOT_GIVE);
  if (r.modImpr === 'DUP') {
    m.push(MENTION.MERCHANT_COPY, MENTION.DO_NOT_GIVE);
    if (r.modPai === 'AUC' && r.totalCents !== 0) m.push(MENTION.NOT_PAID);
  }
  if (r.modImpr === 'RPR') m.push(MENTION.REPRODUCTION);
  if (r.typTrans === 'ADDI') m.push(MENTION.ORIGINAL);
  if (r.typTrans === 'ESTM') m.push(MENTION.ESTIMATE);
  if (r.typTrans === 'SOUM') m.push(MENTION.QUOTE);
  if (r.typTrans === 'RFER') m.push(r.documentKind === 'CREDIT_NOTE' ? MENTION.CREDIT_NOTE : MENTION.PAID);
  if (r.typServ === 'LVT') m.push(MENTION.PLATFORM);
  if (r.formImpr === 'ELE' || r.formImpr === 'PEL') m.push(MENTION.ELECTRONIC);
  if (r.mevStatus === 'OFFLINE_PENDING' || r.mevStatus === 'RETRY_BATCH') m.push(MENTION.OFFLINE);
  if (r.certificateInvalid) m.push(MENTION.INVALID_CERT);
  return [...new Set(m)];
}

function center(s: string): string {
  if (s.length >= RECEIPT_WIDTH) return s.slice(0, RECEIPT_WIDTH);
  const pad = Math.floor((RECEIPT_WIDTH - s.length) / 2);
  return `${' '.repeat(pad)}${s}`;
}

function leftRight(left: string, right: string): string {
  const room = RECEIPT_WIDTH - right.length - 1;
  const l = left.length > room ? left.slice(0, room) : left;
  return `${l}${' '.repeat(RECEIPT_WIDTH - l.length - right.length)}${right}`;
}

function wrap(s: string, indent = ''): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > RECEIPT_WIDTH) {
    out.push(rest.slice(0, RECEIPT_WIDTH));
    rest = indent + rest.slice(RECEIPT_WIDTH);
  }
  out.push(rest);
  return out;
}

export function renderText(r: ReceiptInput, mentions: string[]): string[] {
  const L: string[] = [];
  const rule = '='.repeat(RECEIPT_WIDTH);
  const dash = '-'.repeat(RECEIPT_WIDTH);
  const headerSet: string[] = [MENTION.TRAINING, MENTION.MERCHANT_COPY, MENTION.DO_NOT_GIVE, MENTION.INVALID_CERT];
  const header = mentions.filter((m) => headerSet.includes(m));
  if (header.length) {
    L.push(rule);
    header.forEach((m) => L.push(center(m)));
    L.push(rule);
  }
  L.push(...wrap(r.merchant.name).map(center));
  if (r.merchant.address) L.push(...wrap(r.merchant.address).map(center));
  if (r.merchant.city) L.push(center(r.merchant.city));
  L.push(`TPS : ${r.merchant.noTPS}`);
  L.push(`TVQ : ${r.merchant.noTVQ}`);
  L.push(dash);
  L.push(`Date : ${displayDatTrans(r.datTrans)} (${r.utc})`);
  L.push(leftRight(`Transaction : ${r.noTrans}`, `App. ${r.deviceId}`));
  if (r.externalRef) L.push(...wrap(`Commande : ${r.externalRef}`));
  if (r.reference) L.push(...wrap(`Réf. : transaction ${r.reference.noTrans} du ${displayDatTrans(r.reference.datTrans)}`));
  L.push(dash);
  for (const line of r.lines) {
    const qty = line.isModifier ? '  + ' : `${line.quantity} x `;
    L.push(leftRight(`${qty}${line.description}`, `${receiptAmount(line.totalCents)} ${line.tax}`));
  }
  L.push(dash);
  L.push(leftRight('Sous-total', receiptAmount(r.subtotalCents)));
  L.push(leftRight(`TPS ${TPS_RATE_LABEL}`, receiptAmount(r.tpsCents)));
  L.push(leftRight(`TVQ ${TVQ_RATE_LABEL}`, receiptAmount(r.tvqCents)));
  L.push(leftRight('TOTAL', receiptAmount(r.totalCents)));
  if (r.tipCents) L.push(leftRight('Pourboire', receiptAmount(r.tipCents)));
  L.push(`Paiement : ${PAYMENT_LABEL[r.modPai] ?? r.modPai}`);
  const footer = mentions.filter((m) => !headerSet.includes(m));
  if (footer.length) {
    L.push(rule);
    footer.forEach((m) => L.push(...wrap(m).map(center)));
  }
  L.push(rule);
  L.push(center('[CODE QR]'));
  L.push(center(LINK_TEXT));
  if (r.mevTransactionNumber) L.push(center(`No MEV : ${r.mevTransactionNumber}`));
  L.push(rule);
  return L;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function renderReceipt(r: ReceiptInput): Promise<RenderedReceipt> {
  const mentions = receiptMentions(r);
  const text80mm = renderText(r, mentions);
  const svg = await QRCode.toString(r.qrContent, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  const pngDataUrl = await QRCode.toDataURL(r.qrContent, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
  const qrIndex = text80mm.indexOf(center('[CODE QR]'));
  const before = text80mm.slice(0, qrIndex).map(esc).join('\n');
  const after = text80mm.slice(qrIndex + 2).map(esc).join('\n');
  const html = [
    '<div class="qcmev-receipt" style="font-family:monospace;white-space:pre;width:42ch">',
    `<pre style="margin:0">${before}</pre>`,
    `<div class="qcmev-qr" style="width:42ch;text-align:center">${svg}</div>`,
    `<p style="margin:0;text-align:center"><a href="${esc(r.qrContent)}">${esc(LINK_TEXT)}</a></p>`,
    `<pre style="margin:0">${after}</pre>`,
    '</div>',
  ].join('');
  return { mentions, text80mm, html, qr: { content: r.qrContent, svg, pngDataUrl }, renderHash: sha256Hex(text80mm.join('\n')) };
}

/**
 * QR content. SPEC: the official content (2022 sample: a qr.mev-web.ca link with an "f" parameter) waits for SW-73.
 * Here: <MEV_QR_BASE_URL>?f=<base64url of {a: IDAPPRL, n: noTrans, d: datTrans, m: apresTax, s: start of signature}>.
 */
export function qrContent(baseUrl: string, f: { idApprl: string; noTrans: string; datTrans: string; apresTax: string; signature: string }): string {
  const payload = Buffer.from(JSON.stringify({ a: f.idApprl, n: f.noTrans, d: f.datTrans, m: f.apresTax, s: f.signature.slice(0, 12) })).toString('base64url');
  return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}f=${payload}`;
}
