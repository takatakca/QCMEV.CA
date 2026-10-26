import { correctionOf } from '../src/receipts/receipt.service';
import { MENTION, QR_LINE, qrContent, RECEIPT_WIDTH, ReceiptInput, renderReceipt, wrap, wrapTokens } from '../src/receipts/receipt-renderer';

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
    // Two lines, cut at a word boundary: the date and the time of the original stay together on the second one.
    const ref = before.findIndex((l) => l.startsWith('Réf. :'));
    expect(before.slice(ref, ref + 2)).toEqual(['Réf. : transaction 11', 'du 2026-10-24 22:00:00']);
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

describe('42 columns, cut only at word boundaries (every line type)', () => {
  const long = {
    merchant: { name: 'Restaurant Démo avec un nom vraiment très long pour la ligne', address: '1234 boulevard de l’Exemple-Très-Long, local 5678', city: 'Montréal-Est (Québec) H1A 1A1 Canada, région test', noTPS: '000000000RT0001', noTVQ: '0000000000TQ0001' },
    externalRef: 'Démo #A1B2 Uber Eats commande numéro EXT-0000000012345',
    creditedTo: 'Marie-Hélène Exemple-Démo de la Grande Famille Test',
    lines: [
      { description: 'Trio poulet avec un nom de plat vraiment très long et encore plus long', quantity: '1', unitPriceCents: 1899, totalCents: 1899, tax: 'FP', isModifier: false },
      { description: 'Sauce BBQ maison fumée à l’érable avec beaucoup de mots', quantity: '1', unitPriceCents: 50, totalCents: 50, tax: 'FP', isModifier: true },
      { description: 'Poutine', quantity: '12.125', unitPriceCents: 1099, totalCents: 13325, tax: 'FP', isModifier: false },
    ],
  };
  const variants: Array<[string, Partial<ReceiptInput>]> = [
    ['closing receipt', {}],
    ['credit note with a reference and a name', { documentKind: 'CREDIT_NOTE', totalCents: -2240, reference: { noTrans: '1234567890', datTrans: '20261024063224' }, creditedTo: long.creditedTo }],
    ['credit note, name to fill by hand', { documentKind: 'CREDIT_NOTE', totalCents: -2240, reference: { noTrans: '2', datTrans: '20261024063224' } }],
    ['corrected receipt', { corrects: 'RECEIPT', reference: { noTrans: '11', datTrans: '20261024220000' } }],
    ['corrected credit note', { documentKind: 'CREDIT_NOTE', corrects: 'CREDIT_NOTE', reference: { noTrans: '11', datTrans: '20261024220000' } }],
    ['reproduction', { modImpr: 'RPR' }],
    ['merchant copy', { modImpr: 'DUP' }],
    ['training', { modTrans: 'FOR' }],
    ['offline', { mevStatus: 'OFFLINE_PENDING', mevProcessedAt: null, mevTransactionNumber: null }],
    ['paper + electronic', { formImpr: 'PEL' }],
    ['electronic only', { formImpr: 'ELE' }],
    ['tip', { typServ: 'CMP', tipCents: 200 }],
    ['invalid certificate', { certificateInvalid: true }],
    ['unknown payment code and long MEV-WEB number', { modPai: 'XYZ', mevTransactionNumber: 'SIM000000012 lot 2026-10-24 numéro très long à couper' }],
  ];
  /** Every word the receipt must print whole (names, address, order, items, reference date and time). */
  const words = (o: Partial<ReceiptInput>) => [
    ...long.merchant.name.split(' '), ...long.merchant.address.split(' '), ...long.merchant.city.split(' '), ...long.externalRef.split(' '),
    ...long.lines.flatMap((l) => l.description.split(' ')),
    ...(o.creditedTo ? o.creditedTo.split(' ') : []),
    ...(o.reference ? [o.reference.noTrans, '2026-10-24', o.reference.datTrans === '20261024220000' ? '22:00:00' : '06:32:24'] : []),
  ];

  it.each(variants)('%s: every line ≤ 42 characters, no word, number, date or time cut', async (_name, o) => {
    const r = await renderReceipt(input({ ...long, ...o }));
    for (const doc of [r.text80mm, ...(r.electronic ? [r.electronic.lines] : [])]) {
      const tooWide = doc.filter((l) => l.length > RECEIPT_WIDTH);
      expect(tooWide).toEqual([]);
      const printed = new Set(doc.flatMap((l) => l.trim().split(/\s+/)));
      expect(words(o).filter((w) => !printed.has(w))).toEqual([]);
      // Each item amount stays on the item's first line, right-aligned in the 42 columns.
      expect(doc.some((l) => /^1 x Trio poulet .* 18,99 \$ FP$/.test(l) && l.length === RECEIPT_WIDTH)).toBe(true);
      if (o.reference) {
        const ref = doc.findIndex((l) => l.startsWith('Réf. : transaction'));
        expect(doc[ref]).toBe(`Réf. : transaction ${o.reference.noTrans}`);
        expect(doc[ref + 1]).toMatch(/^du \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      }
    }
  });

  it('wrapTokens: breaks between tokens only; a single token wider than a line is the one thing ever cut', () => {
    expect(wrap('court')).toEqual(['court']);
    expect(wrap('aaaa bbbb cccc', '  ', 9)).toEqual(['aaaa bbbb', '  cccc']);
    expect(wrapTokens(['Réf.', ':', 'transaction', '7', 'du 2026-10-24 06:32:24'])).toEqual(['Réf. : transaction 7', 'du 2026-10-24 06:32:24']);
    expect(wrap('x'.repeat(50))).toEqual(['x'.repeat(42), 'x'.repeat(8)]);
    expect(wrap(`a ${'y'.repeat(45)} b`, '  ')).toEqual(['a', `  ${'y'.repeat(40)}`, `  ${'y'.repeat(5)} b`]);
    expect(wrapTokens([])).toEqual(['']);
  });
});
