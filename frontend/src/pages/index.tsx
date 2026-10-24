/**
 * Dashboard — shows MEV status, recent transactions, offline state
 */
import React, { useEffect, useState } from 'react';
import Layout from '../components/Layout';
import { getMe, getMevStatus, listDevices } from '../lib/api';

/**
 * Fields read from GET /api/operators/mev-status (OperatorsService.mevStatus): environment, certified, hasCertificate,
 * certificateExpiry, offlineDeviceCount, pendingQueueSize. The operator card reads GET /api/operators/me.
 * backend/test/dashboard-contract.spec.ts fails when this page reads a field those answers do not have.
 */
export default function DashboardPage() {
  const [mevStatus, setMevStatus]     = useState<any>(null);
  const [operator, setOperator]       = useState<any>(null);
  const [devices, setDevices]         = useState<any[]>([]);
  const [loading, setLoading]         = useState(true);

  useEffect(() => {
    Promise.all([getMevStatus(), listDevices(), getMe()])
      .then(([statusRes, devicesRes, meRes]) => {
        setMevStatus(statusRes.data);
        setDevices(devicesRes.data);
        setOperator(meRes.data);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return (
    <Layout>
      <div className="flex items-center justify-center h-64 text-gray-500">Chargement...</div>
    </Layout>
  );

  const certOk   = mevStatus?.hasCertificate;
  const offCount = mevStatus?.offlineDeviceCount ?? 0;
  const pending  = mevStatus?.pendingQueueSize ?? 0;

  return (
    <Layout>
      <div className="max-w-5xl mx-auto">
        <h2 className="text-2xl font-bold text-gray-900 mb-6">Tableau de bord</h2>

        {/* Status cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <div className="card">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Certificat MEV</p>
            <p className={`text-2xl font-bold mt-1 ${certOk ? 'text-green-600' : 'text-red-600'}`}>
              {certOk ? '✅ Actif' : '❌ Absent'}
            </p>
            {mevStatus?.certificateExpiry && (
              <p className="text-xs text-gray-500 mt-1">
                Expire: {new Date(mevStatus.certificateExpiry).toLocaleDateString('fr-CA')}
              </p>
            )}
          </div>

          <div className="card">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Appareils hors ligne</p>
            <p className={`text-2xl font-bold mt-1 ${offCount > 0 ? 'text-amber-600' : 'text-green-600'}`}>
              {offCount} / {devices.length}
            </p>
          </div>

          <div className="card">
            <p className="text-xs text-gray-500 uppercase tracking-wide">File d'attente</p>
            <p className={`text-2xl font-bold mt-1 ${pending > 0 ? 'text-amber-600' : 'text-gray-900'}`}>
              {pending} tx
            </p>
          </div>

          <div className="card">
            <p className="text-xs text-gray-500 uppercase tracking-wide">Environnement</p>
            <p className="text-lg font-bold mt-1 text-brand-600">
              {mevStatus?.environment ?? '–'}
            </p>
            {mevStatus && (
              <p className="text-xs text-gray-500 mt-1">
                {mevStatus.certified ? 'Numéro de certification configuré' : 'Non certifié : simulateur / essais seulement'}
              </p>
            )}
          </div>
        </div>

        {/* Devices table */}
        <div className="card">
          <h3 className="font-semibold text-gray-900 mb-4">Appareils enregistrés</h3>
          {devices.length === 0 ? (
            <p className="text-gray-500 text-sm">Aucun appareil enregistré.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 text-gray-500 font-medium">Appareil</th>
                  <th className="text-left py-2 text-gray-500 font-medium">N° série</th>
                  <th className="text-left py-2 text-gray-500 font-medium">Type</th>
                  <th className="text-left py-2 text-gray-500 font-medium">Statut</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.id} className="border-b border-gray-50">
                    <td className="py-2 font-medium">{d.name}</td>
                    <td className="py-2 text-gray-600">{d.serialNumber}</td>
                    <td className="py-2 text-gray-600">{d.deviceType}</td>
                    <td className="py-2">
                      {d.offlineMode
                        ? <span className="badge-yellow">Hors ligne</span>
                        : <span className="badge-green">En ligne</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Operator info (GET /operators/me: no identity number, no authorization code) */}
        {operator && (
          <div className="card mt-4">
            <h3 className="font-semibold text-gray-900 mb-2">Exploitant</h3>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-gray-500">Nom</dt>
              <dd className="text-gray-900">{operator.name}</dd>
              <dt className="text-gray-500">Secteur</dt>
              <dd className="text-gray-900">{operator.sector}</dd>
              <dt className="text-gray-500">Ville</dt>
              <dd className="text-gray-900">{operator.city ?? '–'}</dd>
              <dt className="text-gray-500">Environnement de l’exploitant</dt>
              <dd className="text-gray-900">{operator.environment}</dd>
            </dl>
          </div>
        )}
      </div>
    </Layout>
  );
}
