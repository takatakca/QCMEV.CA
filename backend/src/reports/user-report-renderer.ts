/**
 * The user report as displayed or printed (« rapport de l'utilisateur »).
 *
 * Contents (PROVEN: Revenu Québec, « Production du rapport de l'utilisateur », and SW-76 §4.4.3):
 *   the business name, the TPS and TVQ registration numbers, the user's first and last name, the establishment address
 *   (number, street, city, postal code, in that order, separated by commas), the last document produced on the device
 *   (SEV transaction number, total with taxes, support, masked recipient of an electronic document, moment produced,
 *   moment MEV-WEB processed it, MEV-WEB's transaction number), the device id, the SEV id, the SEV version, the moment
 *   the user logged in, the moment the report was produced, and a QR code with the report's information.
 * The sales summary is NOT displayed: it is only transmitted (DOC), as the same page says.
 * SPEC (SPEC_GAPS #11, #31, #32): the exact layout and labels (SW-73.B), the content and encoding of the QR code, and
 * the masked recipient (QCMEV does not keep the e-mail address or phone number an electronic invoice went to).
 */
import * as QRCode from 'qrcode';
import { mevAmount, receiptAmount } from '../common/money';
import { displayDatTrans } from '../common/time';
import { center, displayProcessedAt, htmlOf, MENTION, QR_LINE, RECEIPT_WIDTH, wrap } from '../receipts/receipt-renderer';

export const USER_REPORT_TITLE = "RAPPORT DE L'UTILISATEUR";

const SUPPORT_LABEL: Record<string, string> = {
  PAP: 'Papier',
  ELE: 'Électronique',
  PEL: 'Papier et électronique',
  NON: 'Non imprimé',
};

export interface UserReportLastDocument {
  noTrans: string;
  totalCents: number;
  /** formImpr of the document: PAP, ELE, PEL or NON. */
  formImpr: string;
  /** Already masked (« abcd****** » or « ******1234 »); null when unknown. */
  recipientMasked: string | null;
  /** datTrans AAAAMMJJhhmmss */
  producedAt: string;
  /** psiDatTrans, or null when MEV-WEB has not processed it (communication problem). */
  mevProcessedAt: string | null;
  /** psiNoTrans, or null. */
  mevTransactionNumber: string | null;
}

export interface UserReportInput {
  merchantName: string;
  noTPS: string;
  noTVQ: string;
  userName: string;
  /** « numéro, rue, ville, code postal », or null when the operator has no address. */
  address: string | null;
  lastDocument: UserReportLastDocument | null;
  /** IDAPPRL */
  deviceId: string;
  /** IDSEV */
  sevId: string;
  /** VERSI: the SEV version assigned by its designer. */
  sevVersion: string;
  /** AAAAMMJJhhmmss, or null if the user never logged in (a system user). */
  loginAt: string | null;
  /** AAAAMMJJhhmmss */
  producedAt: string;
  qrContent: string;
}

export interface RenderedUserReport {
  lines: string[];
  html: string;
  qr: { content: string; svg: string; pngDataUrl: string };
}

/**
 * « numéro, rue, ville, code postal » (PROVEN order, comma-separated). The number is the first token of the stored
 * address when it starts with a digit (« 100-3800 boulevard X » → « 100-3800, boulevard X »).
 */
export function formatEstablishmentAddress(op: { address?: string | null; city?: string | null; postalCode?: string | null }): string | null {
  const parts: string[] = [];
  const street = (op.address ?? '').trim().replace(/\s+/g, ' ');
  if (street) {
    const m = /^(\d[\w-]*)[\s,]+(.+)$/.exec(street);
    if (m) parts.push(m[1], m[2].replace(/^,\s*/, ''));
    else parts.push(street);
  }
  if (op.city?.trim()) parts.push(op.city.trim());
  if (op.postalCode?.trim()) parts.push(op.postalCode.trim().toUpperCase());
  return parts.length ? parts.join(', ') : null;
}

/**
 * Masks an electronic recipient as Revenu Québec describes: the first four characters of an e-mail address followed by
 * six asterisks, or six asterisks followed by the last four digits of a phone number.
 */
export function maskRecipient(recipient: string): string {
  const r = recipient.trim();
  if (r.includes('@')) return `${r.slice(0, 4)}******`;
  const digits = r.replace(/\D/g, '');
  return `******${digits.slice(-4)}`;
}

/** Word-wrapped to the receipt width; a word longer than a line is cut. */
function words(s: string, indent: string): string[] {
  const out: string[] = [];
  let line = indent;
  for (const w of s.split(' ').filter(Boolean)) {
    const next = line.trim() ? `${line} ${w}` : `${indent}${w}`;
    if (next.length <= RECEIPT_WIDTH) {
      line = next;
      continue;
    }
    if (line.trim()) out.push(line);
    line = `${indent}${w}`;
    while (line.length > RECEIPT_WIDTH) {
      out.push(line.slice(0, RECEIPT_WIDTH));
      line = `${indent}${line.slice(RECEIPT_WIDTH)}`;
    }
  }
  if (line.trim()) out.push(line);
  return out;
}

/** « Label : value » on one line when it fits, else the label alone and the value indented under it. */
function label(l: string, v: string): string[] {
  const one = `${l} : ${v}`;
  return one.length <= RECEIPT_WIDTH ? [one] : [`${l} :`, ...words(v, '  ')];
}

export function renderUserReportText(r: UserReportInput): string[] {
  const L: string[] = [];
  const rule = '='.repeat(RECEIPT_WIDTH);
  const dash = '-'.repeat(RECEIPT_WIDTH);
  L.push(center(USER_REPORT_TITLE));
  L.push(rule);
  L.push(...wrap(r.merchantName).map(center));
  L.push(...label('No TPS', r.noTPS));
  L.push(...label('No TVQ', r.noTVQ));
  L.push(...label('Utilisateur', r.userName));
  if (r.address) L.push(...label('Adresse', r.address));
  L.push(dash);
  L.push('Dernier document produit');
  const d = r.lastDocument;
  if (!d) {
    L.push('  Aucun document produit sur cet appareil');
  } else {
    const offline = !d.mevTransactionNumber;
    L.push(...label('No de transaction', d.noTrans));
    L.push(...label('Total avec taxes', receiptAmount(d.totalCents)));
    L.push(...label('Support', SUPPORT_LABEL[d.formImpr] ?? d.formImpr));
    if (d.formImpr === 'ELE' || d.formImpr === 'PEL') L.push(...label('Destinataire', d.recipientMasked ?? 'non conservé par le SEV'));
    L.push(...label('Produit le', displayDatTrans(d.producedAt)));
    L.push(...label('Traité par le MEV-WEB', offline || !d.mevProcessedAt ? MENTION.COMMUNICATION_PROBLEM : displayProcessedAt(d.mevProcessedAt)));
    L.push(...label('No de transaction MEV-WEB', offline ? MENTION.COMMUNICATION_PROBLEM : (d.mevTransactionNumber as string)));
  }
  L.push(dash);
  L.push(...label("Identifiant de l'appareil", r.deviceId));
  L.push(...label('Identifiant du SEV', r.sevId));
  L.push(...label('Version du SEV', r.sevVersion));
  L.push(dash);
  L.push(...label('Connexion au compte', r.loginAt ? displayDatTrans(r.loginAt) : '—'));
  L.push(...label('Rapport produit le', displayDatTrans(r.producedAt)));
  L.push(QR_LINE);
  L.push(rule);
  return L;
}

export async function renderUserReport(r: UserReportInput): Promise<RenderedUserReport> {
  const lines = renderUserReportText(r);
  const svg = await QRCode.toString(r.qrContent, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  const pngDataUrl = await QRCode.toDataURL(r.qrContent, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
  return { lines, html: htmlOf(lines, svg, null), qr: { content: r.qrContent, svg, pngDataUrl } };
}

/**
 * The data inside the report's QR code (SPEC: SW-73.B). Encrypted like an invoice QR, with MEV-WEB's certificate.
 */
export function userReportQrPayload(r: Omit<UserReportInput, 'qrContent'>, year: number): string {
  return JSON.stringify({
    t: 'RUT',
    y: year,
    a: r.deviceId,
    i: r.sevId,
    v: r.sevVersion,
    u: r.userName,
    c: r.loginAt,
    p: r.producedAt,
    n: r.lastDocument?.noTrans ?? null,
    m: r.lastDocument ? mevAmount(r.lastDocument.totalCents) : null,
    k: r.lastDocument?.mevTransactionNumber ?? null,
  });
}
