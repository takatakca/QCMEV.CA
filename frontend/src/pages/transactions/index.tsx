/**
 * Transactions list page — shows recent transactions with MEV status badges
 */
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import Layout from '../../components/Layout';
import { listTransactions } from '../../lib/api';

const STATUS_COLORS: Record<string, string> = {
  ACCEPTED:        'badge-green',
  PENDING:         'badge-yellow',
  OFFLINE_PENDING: 'badge-yellow',
  RETRY_BATCH:     'badge-yellow',
  REJECTED:        'badge-red',
};

const TX_TYPE_LABELS: Record<string, string> = {
  RFER: 'Reçu de fermeture', ADDI: 'Addition', ESTM: 'Estimation', SOUM: 'Soumission',
};

export default function TransactionsPage() {
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');

  useEffect(() => {
    listTransactions()
      .then((r) => setTransactions(r.data ?? []))
      .catch(() => setError('Impossible de charger les transactions'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Layout>
      <div className="max-w-5xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Transactions</h2>
          <Link href="/transactions/new" className="btn-primary">
            + Nouvelle transaction
          </Link>
        </div>

        {loading && (
          <div className="text-center py-12 text-gray-500">Chargement...</div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700">
            {error}
          </div>
        )}

        {!loading && !error && transactions.length === 0 && (
          <div className="card text-center py-12">
            <p className="text-gray-500 text-lg">Aucune transaction</p>
            <p className="text-sm text-gray-400 mt-1">
              Les transactions récentes apparaîtront ici
            </p>
            <Link href="/transactions/new" className="btn-primary mt-4 inline-block">
              Créer une transaction
            </Link>
          </div>
        )}

        {!loading && transactions.length > 0 && (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">N° TX</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">Type</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">Heure</th>
                  <th className="text-right px-4 py-3 text-gray-500 font-medium">Total</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">Statut MEV</th>
                  <th className="text-left px-4 py-3 text-gray-500 font-medium">N° MEV</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {transactions.map((tx) => (
                  <tr key={tx.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">
                      {tx.transactionNumber}
                    </td>
                    <td className="px-4 py-3">
                      {tx.documentKind === 'CREDIT_NOTE' ? 'Note de crédit' : TX_TYPE_LABELS[tx.transactionType] ?? tx.transactionType}
                    </td>
                    <td className="px-4 py-3 text-gray-500">
                      {new Date(tx.createdAt).toLocaleTimeString('fr-CA', {
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </td>
                    <td className="px-4 py-3 text-right font-medium">
                      {Number(tx.totalAmount).toFixed(2)} $
                    </td>
                    <td className="px-4 py-3">
                      <span className={STATUS_COLORS[tx.mevSubmissionStatus] ?? 'badge-blue'}>
                        {tx.mevSubmissionStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">
                      {tx.mevTransactionNumber ?? '–'}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/transactions/${tx.id}`}
                        className="text-brand-600 hover:text-brand-800 font-medium text-xs"
                      >
                        Détail →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Layout>
  );
}
