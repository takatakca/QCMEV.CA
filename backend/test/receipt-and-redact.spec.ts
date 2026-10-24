import { redact, redactString, safeErrorMessage } from '../src/common/redact';
import { qrContent, RECEIPT_WIDTH, ReceiptInput, renderReceipt } from '../src/receipts/receipt-renderer';

const input = (o: Partial<ReceiptInput> = {}): ReceiptInput => ({
  merchant: { name: 'Restaurant Démo', address: '1 rue Exemple', city: 'Montréal', noTPS: '000000000RT0001', noTVQ: '0000000000TQ0001' },
  documentKind: 'RECEIPT', typTrans: 'RFER', modImpr: 'FAC', formImpr: 'PAP', modTrans: 'OPE', typServ: 'LVT', modPai: 'AUT',
  noTrans: '12', datTrans: '20261024233000', utc: '-04:00', deviceId: 'SIM0000000001', externalRef: 'Démo #A1B2',
  lines: [
    { description: 'Trio poulet avec un nom de plat vraiment très long', quantity: '1', unitPriceCents: 1899, totalCents: 1899, tax: 'FP', isModifier: false },
    { description: 'Sauce BBQ', quantity: '1', unitPriceCents: 50, totalCents: 50, tax: 'FP', isModifier: true },
  ],
  subtotalCents: 1949, tpsCents: 97, tvqCents: 194, totalCents: 2240, tipCents: null, mevStatus: 'ACCEPTED', mevTransactionNumber: 'SIM000000012',
  qrContent: qrContent('http://127.0.0.1:3001/api/mev-simulator/qr', { idApprl: 'SIM0000000001', noTrans: '12', datTrans: '20261024233000', apresTax: '22.40', signature: 'A'.repeat(86) + '==' }),
  ...o,
});

describe('receipt renderer', () => {
  it('platform order: PAIEMENT REÇU + COMMANDE PAR UNE PLATEFORME NUMÉRIQUE, QR, link, 42 columns', async () => {
    const r = await renderReceipt(input());
    expect(r.mentions).toEqual(['PAIEMENT REÇU', 'COMMANDE PAR UNE PLATEFORME NUMÉRIQUE']);
    expect(r.text80mm.every((l) => l.length <= RECEIPT_WIDTH)).toBe(true);
    expect(r.text80mm.filter((l) => l === '='.repeat(RECEIPT_WIDTH)).length).toBeGreaterThanOrEqual(2);
    expect(r.text80mm.some((l) => l.includes('Consulter la transaction en ligne'))).toBe(true);
    expect(r.qr.svg).toContain('<svg');
    expect(r.qr.pngDataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(r.html).toContain('Consulter la transaction en ligne');
    expect(r.renderHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await renderReceipt(input())).renderHash).toBe(r.renderHash);
    expect(r.qr.content).not.toMatch(/revenuquebec|mev-web\.ca/);
  });

  it('merchant copy (DUP): the two PROVEN mentions on top', async () => {
    const r = await renderReceipt(input({ modImpr: 'DUP' }));
    expect(r.mentions.slice(0, 2)).toEqual(['***COPIE DU COMMERÇANT***', 'NE PAS REMETTRE AU CLIENT']);
    expect(r.text80mm.slice(0, 4).join('\n')).toContain('***COPIE DU COMMERÇANT***');
  });

  it('reproduction, credit note, training, electronic, offline, invalid certificate', async () => {
    expect((await renderReceipt(input({ modImpr: 'RPR' }))).mentions).toContain('REPRODUCTION');
    expect((await renderReceipt(input({ documentKind: 'CREDIT_NOTE', totalCents: -2240 }))).mentions).toContain('NOTE DE CRÉDIT');
    expect((await renderReceipt(input({ modTrans: 'FOR' }))).mentions).toEqual(expect.arrayContaining(['***DOCUMENT DE FORMATION***', 'NE PAS REMETTRE AU CLIENT']));
    expect((await renderReceipt(input({ formImpr: 'ELE' }))).mentions).toContain('Copie électronique');
    expect((await renderReceipt(input({ mevStatus: 'OFFLINE_PENDING' }))).mentions.some((m) => m.includes('HORS LIGNE'))).toBe(true);
    expect((await renderReceipt(input({ certificateInvalid: true }))).mentions).toContain('*** CERTIFICAT INVALIDE ***');
  });

  it('pourboire printed only when present', async () => {
    expect((await renderReceipt(input())).text80mm.some((l) => l.startsWith('Pourboire'))).toBe(false);
    expect((await renderReceipt(input({ typServ: 'CMP', tipCents: 200 }))).text80mm.some((l) => l.startsWith('Pourboire'))).toBe(true);
  });
});

describe('redaction', () => {
  it('removes identity values, keys and secrets by key and by pattern', () => {
    const out = redact({
      headers: { CODAUTORI: 'XXXX-XXXX', NOTPS: '000000000RT0001', NOTVQ: '0000000000TQ0001', IDAPPRL: 'SIM1' },
      body: { reqTrans: { transActu: { noDossFO: 'ER0000', noTPS: '000000000RT0001', noTVQ: '0000000000TQ0001', mont: { TPS: '1.00' } } } },
      csr: 'MIIB...', note: 'number 000000000RT0001 and -----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----',
    });
    const s = JSON.stringify(out);
    for (const v of ['XXXX-XXXX', '000000000RT0001', '0000000000TQ0001', 'ER0000', 'MIIB', 'BEGIN PRIVATE']) expect(s).not.toContain(v);
    expect(s).toContain('SIM1');
    expect(s).toContain('"TPS":"1.00"');
  });

  it('Prisma-style errors do not echo query arguments', () => {
    const e = Object.assign(new Error('\nInvalid `prisma.operator.create()` invocation:\n{ neq: "1234567890" }'), { name: 'PrismaClientValidationError' });
    expect(safeErrorMessage(e)).toBe('PrismaClientValidationError: database call failed (prisma.operator.create)');
    const dup = Object.assign(new Error('Invalid `prisma.x.create()` invocation:\n\nKey (neq)=(1234567890) already exists'), { code: 'P2002' });
    expect(safeErrorMessage(dup)).toContain('Key (neq)=([REDACTED])');
    expect(safeErrorMessage(dup)).not.toContain('1234567890');
    expect(redactString('TVQ 1234567890TQ0001')).toBe('TVQ [REDACTED TVQ]');
  });
});
