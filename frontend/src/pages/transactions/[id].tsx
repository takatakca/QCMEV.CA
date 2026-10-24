/**
 * Transaction detail + receipt page
 * Shows full transaction info, MEV response, and printable receipt with QR code
 */
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Layout from '../../components/Layout';
import { getReceipt, cancelTransaction } from '../../lib/api';

export default function TransactionDetailPage() {
  const router = useRouter();
  const { id }  = router.query as { id: string };

  const [receipt, setReceipt] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!id) return;
    getReceipt(id)
      .then((r) => setReceipt(r.data))
      .catch(() => setError('Transaction introuvable'))
      .finally(() => setLoading(false));
  }, [id]);

  const handleCancel = async () => {
    if (!confirm('Annuler cette transaction ?')) return;
    setCancelling(true);
    try {
      await cancelTransaction(id);
      router.push('/transactions');
    } catch (err: any) {
      alert(err.response?.data?.message ?? 'Erreur lors de l\'annulation');
    } finally {
      setCancelling(false);
    }
  };

  const handlePrint = () => window.print();

  if (loading) return (
    <Layout><div className="flex items-center justify-center h-64 text-gray-500">Chargement...</div></Layout>
  );

  if (error) return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-red-700">{error}</div>
        <Link href="/transactions" className="btn-secondary mt-4 inline-block">← Retour</Link>
      </div>
    </Layout>
  );

  const tx      = receipt?.transaction;
  const mevResp = receipt?.mevResponse;

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        {/* Header */}
        <div className="flex justify-between items-start mb-6">
          <div>
            <Link href="/transactions" className="text-sm text-gray-500 hover:text-gray-700">
              ← Transactions
            </Link>
            <h2 className="text-2xl font-bold text-gray-900 mt-1">
              Transaction #{tx?.transactionNumber}
            </h2>
            <p className="text-sm text-gray-500">
              {tx?.civilDate} · {new Date(tx?.createdAt).toLocaleTimeString('fr-CA')}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={handlePrint} className="btn-secondary text-sm">
              🖨️ Imprimer
            </button>
            {tx?.mevSubmissionStatus !== 'CANCELLED' && (
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="bg-red-100 hover:bg-red-200 text-red-700 font-medium px-4 py-2 rounded-lg text-sm transition-colors disabled:opacity-50"
              >
                {cancelling ? 'Annulation...' : '× Annuler'}
              </button>
            )}
          </div>
        </div>

        {/* MEV status */}
        <div className="card mb-4">
          <div className="flex justify-between items-center">
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">Statut MEV</p>
              <p className="font-semibold text-gray-900">
                {tx?.mevSubmissionStatus}
                {tx?.mevTransactionNumber && (
                  <span className="ml-2 font-mono text-sm text-gray-500">
                    #{tx.mevTransactionNumber}
                  </span>
                )}
              </p>
            </div>
            {receipt?.qrCodeDataUrl && (
              <img
                src={receipt.qrCodeDataUrl}
                alt="QR Code MEV"
                className="w-24 h-24"
              />
            )}
          </div>
          {receipt?.mevMention && (
            <p className="text-xs text-gray-400 mt-2 font-mono">{receipt.mevMention}</p>
          )}
        </div>

        {/* Items */}
        <div className="card mb-4">
          <h3 className="font-semibold text-gray-900 mb-3">Articles</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-gray-500">
                <th className="text-left py-1 font-medium">Description</th>
                <th className="text-right py-1 font-medium">Qté</th>
                <th className="text-right py-1 font-medium">P.U.</th>
                <th className="text-center py-1 font-medium">Taxe</th>
                <th className="text-right py-1 font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {(tx?.items ?? []).map((item: any) => (
                <tr key={item.id} className="border-b border-gray-50">
                  <td className="py-1.5">{item.description}</td>
                  <td className="py-1.5 text-right">{item.quantity}</td>
                  <td className="py-1.5 text-right">{Number(item.unitPrice).toFixed(2)}</td>
                  <td className="py-1.5 text-center text-xs text-gray-500">{item.taxCode || '–'}</td>
                  <td className="py-1.5 text-right">{(item.quantity * item.unitPrice).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div className="card mb-4">
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">Sous-total</dt>
              <dd>{Number(tx?.subtotalAmount ?? 0).toFixed(2)} $</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">TPS (5%)</dt>
              <dd>{Number(tx?.tpsAmount ?? 0).toFixed(2)} $</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">TVQ (9.975%)</dt>
              <dd>{Number(tx?.tvqAmount ?? 0).toFixed(2)} $</dd>
            </div>
            {Number(tx?.tipsAmount ?? 0) > 0 && (
              <div className="flex justify-between">
                <dt className="text-gray-500">Pourboire</dt>
                <dd>{Number(tx.tipsAmount).toFixed(2)} $</dd>
              </div>
            )}
            <div className="flex justify-between font-bold text-base border-t border-gray-200 pt-2 mt-2">
              <dt>Total</dt>
              <dd>{Number(tx?.totalAmount ?? 0).toFixed(2)} $</dd>
            </div>
            <div className="flex justify-between text-gray-500">
              <dt>Mode de paiement</dt>
              <dd>{tx?.paymentMode}</dd>
            </div>
          </dl>
        </div>

        {/* Raw MEV response — collapsible */}
        {mevResp && (
          <details className="card text-xs">
            <summary className="cursor-pointer font-medium text-gray-700 mb-2">
              Réponse MEV-WEB brute
            </summary>
            <pre className="mt-2 overflow-auto text-gray-600 bg-gray-50 rounded p-3 max-h-64">
              {JSON.stringify(mevResp, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </Layout>
  );
}
