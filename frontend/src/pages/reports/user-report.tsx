/**
 * Annual user report (Rapport Utilisateur — RUT) page
 * Generates and lists annual RUT reports per SW-76 §4.5
 */
import React, { useEffect, useState } from 'react';
import Layout from '../../components/Layout';
import { listReports, generateAnnualReport } from '../../lib/api';

export default function UserReportPage() {
  const [reports, setReports]       = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [generating, setGenerating] = useState(false);
  const [year, setYear]             = useState(new Date().getFullYear() - 1);
  const [error, setError]           = useState('');
  const [success, setSuccess]       = useState('');

  const loadReports = () => {
    setLoading(true);
    listReports()
      .then((r) => setReports(r.data ?? []))
      .catch(() => setError('Impossible de charger les rapports'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadReports(); }, []);

  const handleGenerate = async () => {
    if (!confirm(`Générer le rapport RUT pour l'année ${year} ?`)) return;
    setGenerating(true);
    setError('');
    setSuccess('');
    try {
      await generateAnnualReport(year);
      setSuccess(`✅ Rapport ${year} généré et soumis au MEV-WEB avec succès.`);
      loadReports();
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Erreur lors de la génération');
    } finally {
      setGenerating(false);
    }
  };

  const STATUS_BADGE: Record<string, string> = {
    SUBMITTED: 'badge-green',
    ACCEPTED:  'badge-green',
    PENDING:   'badge-yellow',
    FAILED:    'badge-red',
  };

  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 5 }, (_, i) => currentYear - 1 - i);

  return (
    <Layout>
      <div className="max-w-3xl mx-auto">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Rapports utilisateur (RUT)</h2>
        <p className="text-sm text-gray-500 mb-6">
          Le rapport annuel RUT est requis par Revenu Québec (SW-76 §4.5). Il doit être soumis
          une fois par an, avant le 28 février de l'année suivante.
        </p>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 mb-4">
            {error}
          </div>
        )}

        {success && (
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700 mb-4">
            {success}
          </div>
        )}

        {/* Generate form */}
        <div className="card mb-6">
          <h3 className="font-semibold text-gray-900 mb-4">Générer un rapport annuel</h3>
          <div className="flex gap-4 items-end">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Année fiscale</label>
              <select
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                className="border border-gray-300 rounded-lg px-3 py-2"
              >
                {yearOptions.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="btn-primary disabled:opacity-50"
            >
              {generating ? 'Génération...' : `📄 Générer le rapport ${year}`}
            </button>
          </div>
          <p className="text-xs text-gray-400 mt-3">
            Le rapport consolidera toutes les transactions de l'année et le soumettra au MEV-WEB
            en tant que requête de type DOC.
          </p>
        </div>

        {/* Reports list */}
        <div className="card">
          <h3 className="font-semibold text-gray-900 mb-4">Historique des rapports</h3>
          {loading ? (
            <p className="text-gray-500 text-sm">Chargement...</p>
          ) : reports.length === 0 ? (
            <p className="text-gray-500 text-sm">Aucun rapport soumis</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100">
                <tr>
                  <th className="text-left py-2 text-gray-500 font-medium">Année</th>
                  <th className="text-left py-2 text-gray-500 font-medium">Type</th>
                  <th className="text-left py-2 text-gray-500 font-medium">Soumis le</th>
                  <th className="text-left py-2 text-gray-500 font-medium">Statut MEV</th>
                  <th className="text-right py-2 text-gray-500 font-medium">N° MEV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {reports.map((r: any) => (
                  <tr key={r.id}>
                    <td className="py-2 font-medium">{r.reportYear}</td>
                    <td className="py-2 text-gray-600">{r.reportType}</td>
                    <td className="py-2 text-gray-500">
                      {r.createdAt
                        ? new Date(r.createdAt).toLocaleDateString('fr-CA')
                        : '–'}
                    </td>
                    <td className="py-2">
                      <span className={STATUS_BADGE[r.mevStatus] ?? 'badge-blue'}>
                        {r.mevStatus}
                      </span>
                    </td>
                    <td className="py-2 text-right font-mono text-xs text-gray-500">
                      {r.mevDocumentNumber ?? '–'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  );
}
