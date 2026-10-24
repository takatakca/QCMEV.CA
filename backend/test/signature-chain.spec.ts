import * as crypto from 'crypto';
import { canonicalJson } from '../src/common/canonical-json';
import { FIRST_PRECED, GENESIS_HASH, generateP256, nextHashChain, signP256, transactionSignedString, verifyP256 } from '../src/crypto/ecdsa';
import { buildTransCore, SaleDraft } from '../src/transactions/trans-builder';

const draft = (cents: number): SaleDraft => ({
  documentKind: 'RECEIPT', typTrans: 'RFER', modImpr: 'FAC', formImpr: 'PAP', modTrans: 'OPE', typServ: 'CMP', ecommerce: false, modPai: 'ARG',
  lines: [{ description: 'Poutine', quantity: '1', unitPriceCents: cents, totalCents: cents, tax: 'FP', activity: 'RES' }],
});
const identity = { noTPS: '000000000RT0001', noTVQ: '0000000000TQ0001' };

describe('ECDSA P-256 signatures and the signature chain', () => {
  const keys = generateP256();

  it('a signature is 64 bytes r||s = 88 base64 characters, and verifies', () => {
    const sig = signP256(keys.privateKeyPem, 'hello');
    expect(sig).toHaveLength(88);
    expect(sig.endsWith('=')).toBe(true);
    expect(verifyP256(keys.publicKeyPem, 'hello', sig)).toBe(true);
    expect(verifyP256(keys.publicKeyPem, 'hellO', sig)).toBe(false);
    expect(verifyP256(generateP256().publicKeyPem, 'hello', sig)).toBe(false);
  });

  it('the first preced is 88 "="', () => {
    expect(FIRST_PRECED).toBe('='.repeat(88));
  });

  it('the signed string concatenates the fields in the 2022-sample order', () => {
    expect(
      transactionSignedString({ noTrans: '1', datTrans: '20261024120000', TPS: '0.50', TVQ: '1.00', apresTax: '11.50', noTPS: 'A', noTVQ: 'B', modImpr: 'FAC', modTrans: 'OPE', preced: 'P' }),
    ).toBe('1202610241200000.501.0011.50ABFACOPEP');
  });

  it('chains three transactions: each preced is the previous signature; hashes recompute', () => {
    let preced = FIRST_PRECED;
    let prevHash = GENESIS_HASH;
    const chain: Array<{ actu: string; preced: string; hash: string; core: unknown }> = [];
    [1000, 2500, 399].forEach((cents, i) => {
      const { core, signedString, totals } = buildTransCore(
        draft(cents),
        { noTrans: String(i + 1), datTrans: `2026102412000${i}`, utc: '-04:00', datActu: `2026102412000${i}`, nomUtil: 'FOODHUB-AUTO', preced },
        identity,
      );
      expect(totals.totalCents).toBe(totals.subtotalCents + totals.tpsCents + totals.tvqCents);
      const actu = signP256(keys.privateKeyPem, signedString);
      const full = { ...core, signa: { actu, preced, datActu: core.datTrans } };
      const hash = nextHashChain(prevHash, canonicalJson(full));
      chain.push({ actu, preced, hash, core: full });
      expect(verifyP256(keys.publicKeyPem, signedString, actu)).toBe(true);
      preced = actu;
      prevHash = hash;
    });
    expect(chain[0].preced).toBe(FIRST_PRECED);
    expect(chain[1].preced).toBe(chain[0].actu);
    expect(chain[2].preced).toBe(chain[1].actu);
    let h = GENESIS_HASH;
    for (const c of chain) {
      h = crypto.createHash('sha256').update(`${h}|${canonicalJson(c.core)}`).digest('hex');
      expect(h).toBe(c.hash);
    }
  });

  it('changing an amount breaks the signature', () => {
    const { signedString } = buildTransCore(draft(1000), { noTrans: '1', datTrans: '20261024120000', utc: '-04:00', datActu: '20261024120000', nomUtil: 'X', preced: FIRST_PRECED }, identity);
    const sig = signP256(keys.privateKeyPem, signedString);
    expect(verifyP256(keys.publicKeyPem, signedString.replace('11.50', '11.49'), sig)).toBe(false);
  });

  it('carries the official field names and no identity value', () => {
    const { core } = buildTransCore(
      { ...draft(1000), tipCents: 200 },
      { noTrans: '7', datTrans: '20261024233000', utc: '-04:00', datActu: '20261024233000', nomUtil: 'FOODHUB-AUTO', preced: FIRST_PRECED, ref: { noTrans: '3', datTrans: '20261024100000', subtotalCents: 500 } },
      identity,
    );
    expect(Object.keys(core).sort()).toEqual(['commerElectr', 'datTrans', 'formImpr', 'items', 'modImpr', 'modPai', 'modTrans', 'mont', 'noTrans', 'nomUtil', 'refs', 'sectActi', 'typTrans', 'utc']);
    expect(core.sectActi).toEqual({ abrvt: 'RBC', typServ: 'CMP' });
    expect(core.mont).toEqual({ avantTax: '10.00', TPS: '0.50', TVQ: '1.00', apresTax: '11.50', pourb: '2.00' });
    expect(core.items[0]).toEqual({ qte: '1', descr: 'Poutine', unitr: '10.00', prix: '10.00', tax: 'FP', acti: 'RES' });
    expect(core.refs).toEqual([{ noTrans: '3', datTrans: '20261024100000', avantTax: '5.00' }]);
    expect(JSON.stringify(core)).not.toContain(identity.noTPS);
  });
});
