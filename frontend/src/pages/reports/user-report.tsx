/**
 * User report (« rapport de l'utilisateur », DOC RUT).
 * Revenu Québec (« Production du rapport de l'utilisateur »): when Revenu Québec asks for it, the SEV displays, prints
 * or sends the report, and transmits its required information to MEV-WEB. The report shows the business, the logged-in
 * user, the last document produced on the device, the device / SEV identifiers, the login and production moments and
 * a QR code. The sales summary is transmitted only: it is never shown here.
 */
import React, { useEffect, useState } from 'react';
import Layout from '../../components/Layout';
import { listDevices, listReports, produceUserReport } from '../../lib/api';

export default function UserReportPage() {
  const currentYear = new Date().getFullYear();
  const [reports, setReports] = useState<any[]>([]);
  const [devices, setDevices] = useState<any[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [year, setYear] = useState(currentYear);
  const [loading, setLoading] = useState(true);
  const [producing, setProducing] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<any>(null);

  const loadReports = () => {
    setLoading(true);
    listReports()
      .then((r) => setReports(r.data ?? []))
      .catch(() => setError('Impossible de charger les rapports'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadReports();
    listDevices()
      .then((r) => setDevices((r.data ?? []).filter((d: any) => d.isActive && d.certified)))
      .catch(() => setDevices([]));
  }, []);

  const handleProduce = async () => {
    setProducing(true);
    setError('');
    setReport(null);
    try {
      const r = await produceUserReport(year, deviceId || undefined);
      setReport(r.data);
      loadReports();
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Erreur lors de la production du rapport');
    } finally {
      setProducing(false);
    }
  };

  const STATUS_BADGE: Record<string, string> = {
    ACCEPTED: 'badge-green',
    PENDING: 'badge-yellow',
    OFFLINE_PENDING: 'badge-yellow',
    RETRY_BATCH: 'badge-yellow',
    REJECTED: 'badge-red',
  };

  return (
    <Layout>
      <div className="max-w-3xl mx-auto">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Rapport de l'utilisateur</h2>
        <p className="text-sm text-gray-500 mb-6">
          À produire quand Revenu Québec le demande. Le rapport est affiché (et peut être imprimé) pour l'utilisateur
          connecté, et ses renseignements sont transmis au MEV-WEB chaque fois qu'il est produit. Le sommaire des ventes
          est transmis seulement : il ne s'affiche pas.
        </p>

        {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 mb-4">{error}</div>}

        <div className="card mb-6">
          <div className="flex flex-wrap gap-4 items-end">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Année des ventes</label>
              <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="border border-gray-300 rounded-lg px-3 py-2">
                <option value={currentYear}>{currentYear} (en cours)</option>
                <option value={currentYear - 1}>{currentYear - 1} (précédente)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Appareil</label>
              <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="border border-gray-300 rounded-lg px-3 py-2">
                <option value="">Premier appareil certifié</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>{d.name ?? d.serialNumber}</option>
                ))}
              </select>
            </div>
            <button onClick={handleProduce} disabled={producing} className="btn-primary disabled:opacity-50">
              {producing ? 'Production...' : 'Produire le rapport'}
            </button>
          </div>
        </div>

        {report && (
          <div className="card mb-6">
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-semibold text-gray-900">Rapport affiché</h3>
              <button onClick={() => window.print()} className="btn-secondary text-sm">Imprimer</button>
            </div>
            <p className="text-sm mb-3">
              {report.transmitted
                ? <>Transmis au MEV-WEB : <span className={STATUS_BADGE[report.mevStatus] ?? 'badge-blue'}>{report.mevStatus}</span>{report.mevReportNumber ? ` (n° ${report.mevReportNumber})` : ''}</>
                : <span className="text-red-700">Non transmis : le certificat de l'appareil est expiré. Renouvelez-le.</span>}
            </p>
            {/* Built by the backend from escaped text and the QR SVG (no user HTML). */}
            <div className="overflow-x-auto" dangerouslySetInnerHTML={{ __html: report.display?.html ?? '' }} />
          </div>
        )}

        <div className="card">
          <h3 className="font-semibold text-gray-900 mb-4">Rapports produits</h3>
          {loading ? (
            <p className="text-gray-500 text-sm">Chargement...</p>
          ) : reports.length === 0 ? (
            <p className="text-gray-500 text-sm">Aucun rapport produit</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100">
                <tr>
                  <th className="text-left py-2 text-gray-500 font-medium">Année</th>
                  <th className="text-left py-2 text-gray-500 font-medium">Produit le</th>
                  <th className="text-left py-2 text-gray-500 font-medium">Statut MEV</th>
                  <th className="text-right py-2 text-gray-500 font-medium">N° MEV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {reports.map((r: any) => (
                  <tr key={r.id}>
                    <td className="py-2 font-medium">{r.reportYear}</td>
                    <td className="py-2 text-gray-500">{r.createdAt ? new Date(r.createdAt).toLocaleString('fr-CA') : '–'}</td>
                    <td className="py-2"><span className={STATUS_BADGE[r.mevStatus] ?? 'badge-blue'}>{r.mevStatus}</span></td>
                    <td className="py-2 text-right font-mono text-xs text-gray-500">{r.mevReportNumber ?? '–'}</td>
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
