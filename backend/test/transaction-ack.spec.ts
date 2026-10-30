import * as crypto from 'crypto';
import { of } from 'rxjs';
import { loadConfig } from '../src/config/app-config';
import { generateP256 } from '../src/crypto/ecdsa';
import { softwareSigner } from '../src/crypto/key-custody';
import { MevUnreachableError, MevWebService, transactionAnswers } from '../src/mev-web/mev-web.service';
import { TransActu } from '../src/mev-web/mev-web.types';

const trans = [{ noTrans: '1' }, { noTrans: '2' }] as TransActu[];
const accepted = (noTrans: string) => ({ noTrans, psiNoTrans: `MEV-${noTrans}` });

describe('transaction acknowledgements before queue settlement', () => {
  it.each([
    {},
    { retourTransActu: {} },
    { retourTransActu: { noTrans: 'other', psiNoTrans: 'MEV-other' } },
    { retourTransActu: { noTrans: '1', psiNoTrans: '' } },
    { retourTransActu: { noTrans: '1', psiNoTrans: 123 } },
  ])('never accepts an incomplete single answer: %j', (inner) => {
    expect(() => transactionAnswers(trans.slice(0, 1), { retourTrans: inner } as never, 200)).toThrow(MevUnreachableError);
  });

  it.each([
    [accepted('1')],
    [accepted('1'), accepted('1')],
    [accepted('1'), accepted('other')],
    [accepted('1'), null],
  ])('never maps a missing or duplicate batch reply onto another sale: %j', (...items) => {
    expect(() => transactionAnswers(trans, { retourTrans: { retourTransLot: items } } as never, 200)).toThrow(MevUnreachableError);
  });

  it('matches distinct numbers when the reply is reordered', () => {
    expect(transactionAnswers(trans, { retourTrans: { retourTransLot: [accepted('2'), accepted('1')] } }, 200).map((r) => r.psiNoTrans)).toEqual(['MEV-1', 'MEV-2']);
  });

  it('accepts complete positional replies without noTrans, but not duplicate request numbers across days', () => {
    const answer = { retourTrans: { retourTransLot: [{ psiNoTrans: 'A' }, { psiNoTrans: 'B' }] } };
    expect(transactionAnswers(trans, answer, 200).map((r) => r.psiNoTrans)).toEqual(['A', 'B']);
    expect(() => transactionAnswers([trans[0], trans[0]], answer, 200)).toThrow(MevUnreachableError);
  });

  it('keeps global errors and 4xx rejections even without item acknowledgements', () => {
    const listErr = [{ id: 'E', mess: 'retry', codRetour: '95' }];
    expect(transactionAnswers(trans, { retourTrans: { listErr } }, 200).every((r) => r.listErr?.[0].id === 'E')).toBe(true);
    expect(transactionAnswers(trans, { retourTrans: {} }, 400).every((r) => r.listErr?.[0].id === 'HTTP-400')).toBe(true);
  });

  it('records an incomplete 200 as failed/unreachable, so callers retain their queue', async () => {
    const cfg = loadConfig({ JWT_SECRET: crypto.randomBytes(32).toString('hex'), PRIVATE_KEY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') });
    const update = jest.fn().mockResolvedValue({});
    const prisma = { mevRequestLog: { create: jest.fn().mockResolvedValue({ id: 'log' }), update } };
    const http = { post: jest.fn().mockReturnValue(of({ status: 200, data: { retourTrans: {} } })) };
    const svc = new MevWebService(cfg, http as never, prisma as never);
    const material = { sign: softwareSigner(generateP256().privateKeyPem).sign, certPem: '', thumbprint: 't', mevDeviceId: 'd' };
    await expect(svc.sendTransactions({ id: 'op', noTPS: 'x', noTVQ: 'y' }, material, trans)).rejects.toBeInstanceOf(MevUnreachableError);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ success: false, mevErrorCode: 'INCOMPLETE_ACK' }) }));
    expect(svc.reachability().mevReachable).toBe(false);
  });
});
