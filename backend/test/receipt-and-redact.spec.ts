import { redact, redactString, safeErrorMessage } from '../src/common/redact';
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
