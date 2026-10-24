import { correctionOf } from '../src/receipts/receipt.service';
import { MENTION, QR_LINE, qrContent, RECEIPT_WIDTH, ReceiptInput, renderReceipt } from '../src/receipts/receipt-renderer';

const RULE = '='.repeat(RECEIPT_WIDTH);
const input = (o: Partial<ReceiptInput> = {}): ReceiptInput => ({
  merchant: { name: 'Restaurant Démo', address: '1 rue Exemple', city: 'Montréal', noTPS: '000000000RT0001', noTVQ: '0000000000TQ0001' },
  documentKind: 'RECEIPT', typTrans: 'RFER', modImpr: 'FAC', formImpr: 'PAP', modTrans: 'OPE', typServ: 'LVT', modPai: 'AUT',
  noTrans: '12', datTrans: '20261024233000', utc: '-04:00', deviceId: 'SIM0000000001', externalRef: 'Démo #A1B2',
  lines: [
    { description: 'Trio poulet avec un nom de plat vraiment très long', quantity: '1', unitPriceCents: 1899, totalCents: 1899, tax: 'FP', isModifier: false },
    { description: 'Sauce BBQ', quantity: '1', unitPriceCents: 50, totalCents: 50, tax: 'FP', isModifier: true },
  ],
  subtotalCents: 1949, tpsCents: 97, tvqCents: 194, totalCents: 2240, tipCents: null, mevStatus: 'ACCEPTED',
  mevProcessedAt: '20261024233002', mevTransactionNumber: 'SIM000000012',
  qrContent: qrContent('http://127.0.0.1:3001/api/mev-simulator/qr', 'e1.ENCRYPTED'),
  ...o,
});

/** Lines strictly between the two "=" lines, trimmed. */
const block = (lines: string[]) => {
  const a = lines.indexOf(RULE);
  const b = lines.indexOf(RULE, a + 1);
  return lines.slice(a + 1, b).map((l) => l.trim());
};

describe('receipt renderer (Revenu Québec layout: SW-76 §4.4.1, « Exemple de facture – restauration »)', () => {
  it('exactly two "=" lines; TPS, TVQ, TOTAL, mention, QR, processing time, MEV-WEB number, device id, in that order', async () => {
    const r = await renderReceipt(input());
    expect(r.mentions).toEqual(['PAIEMENT REÇU', 'COMMANDE PAR UNE PLATEFORME NUMÉRIQUE']);
    expect(r.text80mm.every((l) => l.length <= RECEIPT_WIDTH)).toBe(true);
    expect(r.text80mm.filter((l) => l === RULE)).toHaveLength(2);
    const b = block(r.text80mm);
    expect(b[0]).toMatch(/^TPS 5 % :\s+0,97 \$$/);
    expect(b[1]).toMatch(/^TVQ 9,975 % :\s+1,94 \$$/);
    expect(b[2]).toMatch(/^TOTAL :\s+22,40 \$$/);
    expect(b.slice(3)).toEqual(['PAIEMENT REÇU', 'COMMANDE PAR UNE PLATEFORME NUMÉRIQUE', '[CODE QR]', '2026-10-24 23:30:02', 'SIM000000012', 'SIM0000000001']);
    // Before the first "=": subtotal, registration numbers, payment mode; nothing of the block.
    const before = r.text80mm.slice(0, r.text80mm.indexOf(RULE));
    expect(before.some((l) => l.startsWith('Sous-total'))).toBe(true);
    expect(before).toEqual(expect.arrayContaining(['No TPS : 000000000RT0001', 'No TVQ : 0000000000TQ0001', 'Paiement : Autre']));
    expect(before.some((l) => l.includes('TOTAL') || l.includes('SIM0000000001'))).toBe(false);
    // Paper: no hyperlink text; nothing after the closing "=".
    expect(r.text80mm.some((l) => l.includes('Consulter la transaction en ligne'))).toBe(false);
    expect(r.text80mm[r.text80mm.length - 1]).toBe(RULE);
    expect(r.electronic).toBeNull();
    expect(r.qr.svg).toContain('<svg');
    expect(r.qr.pngDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(r.renderHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await renderReceipt(input())).renderHash).toBe(r.renderHash);
  });

  it('tip right after TOTAL, inside the block, only when present', async () => {
    expect((await renderReceipt(input())).text80mm.some((l) => l.startsWith('Pourboire'))).toBe(false);
    const b = block((await renderReceipt(input({ typServ: 'CMP', tipCents: 200 }))).text80mm);
    expect(b[3]).toMatch(/^Pourboire :\s+2,00 \$$/);
    expect(b[4]).toBe('PAIEMENT REÇU');
  });

  it('offline: processing time and MEV-WEB number are each replaced by « PROBLÈME DE COMMUNICATION »', async () => {
    const r = await renderReceipt(input({ mevStatus: 'OFFLINE_PENDING', mevProcessedAt: null, mevTransactionNumber: null }));
    const b = block(r.text80mm);
    const qr = b.indexOf('[CODE QR]');
    expect(b.slice(qr + 1)).toEqual(['PROBLÈME DE COMMUNICATION', 'PROBLÈME DE COMMUNICATION', 'SIM0000000001']);
    expect(r.mentions).toContain(MENTION.COMMUNICATION_PROBLEM);
    expect(r.text80mm.some((l) => l.includes('HORS LIGNE'))).toBe(false);
  });

  it('merchant copy (DUP) and reproduction (RPR): mentions in the footer, after the closing "="', async () => {
    const dup = (await renderReceipt(input({ modImpr: 'DUP' }))).text80mm;
    const last = dup.lastIndexOf(RULE);
    expect(dup.filter((l) => l === RULE)).toHaveLength(2);
    expect(dup.slice(last + 1).map((l) => l.trim())).toEqual(['***COPIE DU COMMERÇANT***', 'NE PAS REMETTRE AU CLIENT']);
    expect(dup.slice(0, last).some((l) => l.includes('COMMERÇANT'))).toBe(false);
    const rpr = (await renderReceipt(input({ modImpr: 'RPR' }))).text80mm;
    expect(rpr.slice(rpr.lastIndexOf(RULE) + 1).map((l) => l.trim())).toEqual(['REPRODUCTION']);
  });

  it('credit note: « NOTE DE CRÉDIT », « Crédité à » and « Date de la remise » lines before the first "="', async () => {
    const r = await renderReceipt(input({ documentKind: 'CREDIT_NOTE', totalCents: -2240, reference: { noTrans: '11', datTrans: '20261024220000' } }));
    expect(r.mentions).toContain('NOTE DE CRÉDIT');
    const before = r.text80mm.slice(0, r.text80mm.indexOf(RULE));
    expect(before.some((l) => /^Crédité à : _+$/.test(l))).toBe(true);
    expect(before.some((l) => /^Date de la remise : _+$/.test(l))).toBe(true);
    expect(before.some((l) => l.startsWith('Réf. : transaction 11 du 2026-10-24'))).toBe(true);
    const named = await renderReceipt(input({ documentKind: 'CREDIT_NOTE', totalCents: -2240, creditedTo: 'Marie' }));
    expect(named.text80mm).toContain('Crédité à : Marie');
  });

  it('corrected receipt: « Facture corrigée » in the block', async () => {
    const r = await renderReceipt(input({ corrects: 'RECEIPT', reference: { noTrans: '11', datTrans: '20261024220000' } }));
    expect(block(r.text80mm)).toContain('Facture corrigée');
    expect((await renderReceipt(input({ corrects: 'CREDIT_NOTE', documentKind: 'CREDIT_NOTE' }))).mentions).toContain('Note de crédit corrigée');
  });

  it('which transactions are corrections', () => {
    const rfer = { transactionType: 'RFER', documentKind: 'RECEIPT' };
    expect(correctionOf({ transactionType: 'RFER', printMode: 'FAC', documentKind: 'RECEIPT', related: rfer })).toBe('RECEIPT');
    expect(correctionOf({ transactionType: 'RFER', printMode: 'FAC', documentKind: 'CREDIT_NOTE', related: rfer })).toBeNull();
    expect(correctionOf({ transactionType: 'RFER', printMode: 'RPR', documentKind: 'RECEIPT', related: rfer })).toBeNull();
    expect(correctionOf({ transactionType: 'RFER', printMode: 'FAC', documentKind: 'RECEIPT', related: { transactionType: 'ADDI', documentKind: 'ADDITION' } })).toBeNull();
    expect(correctionOf({ transactionType: 'RFER', printMode: 'FAC', documentKind: 'CREDIT_NOTE', related: { transactionType: 'RFER', documentKind: 'CREDIT_NOTE' } })).toBe('CREDIT_NOTE');
    expect(correctionOf({ transactionType: 'RFER', printMode: 'FAC', documentKind: 'RECEIPT', related: null })).toBeNull();
  });

  it('paper and electronic (PEL): the paper has no link and no « Copie électronique »; the electronic copy has both, link right under the QR', async () => {
    const r = await renderReceipt(input({ formImpr: 'PEL' }));
    expect(r.mentions).not.toContain('Copie électronique');
    expect(r.text80mm.some((l) => l.includes('Consulter'))).toBe(false);
    const e = r.electronic!;
    expect(e.mentions).toContain('Copie électronique');
    expect(e.lines[e.lines.indexOf(QR_LINE) + 1].trim()).toBe('Consulter la transaction en ligne');
    expect(e.lines.slice(e.lines.lastIndexOf(RULE) + 1).map((l) => l.trim())).toEqual(['Copie électronique']);
    expect(e.html).toMatch(/<\/svg>\s*<\/div><p[^>]*><a href="http:\/\/127\.0\.0\.1:3001\/api\/mev-simulator\/qr\?f=e1\.ENCRYPTED">Consulter la transaction en ligne<\/a><\/p>/);
    expect(e.html).not.toContain('[CODE QR]');
  });

  it('electronic only (ELE): the main document is the electronic one, with the link and no « Copie électronique »', async () => {
    const r = await renderReceipt(input({ formImpr: 'ELE' }));
    expect(r.text80mm).toEqual(r.electronic!.lines);
    expect(r.mentions).not.toContain('Copie électronique');
    expect(r.html).toContain('<a href=');
  });

  it('training, invalid certificate and « PAIEMENT NON REÇU » mentions', async () => {
    const t = await renderReceipt(input({ modTrans: 'FOR' }));
    expect(t.mentions).toEqual(expect.arrayContaining(['***DOCUMENT DE FORMATION***', 'NE PAS REMETTRE AU CLIENT']));
    expect((await renderReceipt(input({ certificateInvalid: true }))).mentions).toContain('*** CERTIFICAT INVALIDE ***');
    const psp = await renderReceipt(input({ modImpr: 'DUP', modPai: 'AUC' }));
    expect(psp.mentions).toContain('PAIEMENT NON REÇU');
    expect(psp.mentions).not.toContain('PAIEMENT REÇU');
  });
});
