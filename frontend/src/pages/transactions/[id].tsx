/**
 * Transaction detail: the receipt exactly as the backend rendered it (80 mm text + QR),
 * with reproduction (RPR), merchant copy (DUP) and credit note actions. Each action is a new, transmitted transaction.
 */
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Layout from '../../components/Layout';
import { cancelTransaction, getReceipt, getTransaction, reprint } from '../../lib/api';

export default function TransactionDetailPage() {
  const router = useRouter();
  const { id } = router.query as { id: string };
  const [tx, setTx] = useState<any>(null);
  const [receipt, setReceipt] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    Promise.all([getTransaction(id), getReceipt(id)])
      .then(([t, r]) => {
        setTx(t.data);
        setReceipt(r.data);
      })
      .catch(() => setError('Transaction introuvable'))
      .finally(() => setLoading(false));
  }, [id]);

  const act = async (fn: () => Promise<any>) => {
    setBusy(true);
    try {
      const r = await fn();
      router.push(`/transactions/${r.data.id}`);
    } catch (err: any) {
      alert(err.response?.data?.message ?? err.response?.data?.errors?.[0]?.message ?? 'Erreur');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Layout><div className="flex items-center justify-center h-64 text-gray-500">Chargement...</div></Layout>;
  if (error || !tx) {
    return (
      <Layout>
        <div className="max-w-2xl mx-auto">
          <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-red-700">{error || 'Transaction introuvable'}</div>
          <Link href="/transactions" className="btn-secondary mt-4 inline-block">← Retour</Link>
        </div>
      </Layout>
    );
  }

  const qrAt = receipt.text80mm.findIndex((l: string) => l.includes('[CODE QR]'));
  return (
    <Layout>
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex flex-wrap gap-2 justify-between items-center">
          <h2 className="text-2xl font-bold text-gray-900">Transaction {tx.noTrans} · {tx.civilDate}</h2>
          <div className="flex flex-wrap gap-2">
            <button className="btn-secondary" onClick={() => window.print()}>Imprimer</button>
            {tx.printMode === 'FAC' && (
              <>
                <button className="btn-secondary" disabled={busy} onClick={() => act(() => reprint(id, 'RPR'))}>Reproduction</button>
                <button className="btn-secondary" disabled={busy} onClick={() => act(() => reprint(id, 'DUP'))}>Copie du commerçant</button>
                {tx.documentKind === 'RECEIPT' && tx.status === 'ISSUED' && (
                  <button className="btn-secondary" disabled={busy} onClick={() => confirm('Émettre une note de crédit complète ?') && act(() => cancelTransaction(id))}>Note de crédit</button>
                )}
              </>
            )}
          </div>
        </div>

        <div className="card text-sm grid grid-cols-2 gap-2">
          <div>Statut MEV : <strong>{tx.mevStatus}</strong></div>
          <div>No MEV : {tx.mevTransactionNumber ?? '–'}</div>
          <div>Type : {tx.transactionType} / {tx.printMode} / {tx.transactionMode}</div>
          <div>Service : {tx.serviceType ?? '–'} · Paiement : {tx.paymentMode}</div>
          <div className="col-span-2 break-all text-xs text-gray-500">Signature : {tx.signature}</div>
          {Array.isArray(tx.mevErrors) && tx.mevErrors.length > 0 && (
            <div className="col-span-2 text-red-700">Erreurs MEV : {tx.mevErrors.map((e: any) => `${e.codRetour} ${e.mess}`).join(' · ')}</div>
          )}
        </div>

        <div className="card flex justify-center">
          <div className="font-mono text-xs leading-tight" style={{ width: '42ch' }}>
            <pre className="whitespace-pre">{receipt.text80mm.slice(0, qrAt).join('\n')}</pre>
            <div className="flex justify-center my-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={receipt.qr.pngDataUrl} alt="Code QR de la transaction" width={160} height={160} />
            </div>
            <p className="text-center"><a href={receipt.qr.content} className="underline">Consulter la transaction en ligne</a></p>
            <pre className="whitespace-pre">{receipt.text80mm.slice(qrAt + 2).join('\n')}</pre>
          </div>
        </div>
      </div>
    </Layout>
  );
}
