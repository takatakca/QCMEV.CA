/**
 * Operator settings page — profile, certificates, MEV environment
 */
import React, { useEffect, useState } from 'react';
import Layout from '../../components/Layout';
import { getMe, getMevStatus, getActiveCert, requestCertificate, getExpiringCerts } from '../../lib/api';

export default function SettingsPage() {
  const [operator, setOperator]     = useState<any>(null);
  const [cert, setCert]             = useState<any>(null);
  const [expiring, setExpiring]     = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [certLoading, setCertLoading] = useState(false);
  const [error, setError]           = useState('');
  const [certMsg, setCertMsg]       = useState('');

  useEffect(() => {
    Promise.all([getMe(), getActiveCert(), getExpiringCerts()])
      .then(([meRes, certRes, expRes]) => {
        setOperator(meRes.data);
        setCert(certRes.data);
        setExpiring(expRes.data ?? []);
      })
      .catch(() => setError('Impossible de charger les paramètres'))
      .finally(() => setLoading(false));
  }, []);

  const handleRequestCert = async () => {
    setCertLoading(true);
    setCertMsg('');
    setError('');
    try {
      await requestCertificate();
      setCertMsg('✅ Demande de certificat soumise avec succès. Le certificat sera actif dans quelques instants.');
      // Refresh cert
      const r = await getActiveCert();
      setCert(r.data);
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Erreur lors de la demande');
    } finally {
      setCertLoading(false);
    }
  };

  if (loading) return (
    <Layout><div className="flex items-center justify-center h-64 text-gray-500">Chargement...</div></Layout>
  );

  return (
    <Layout>
      <div className="max-w-2xl mx-auto space-y-6">
        <h2 className="text-2xl font-bold text-gray-900">Paramètres</h2>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Operator profile */}
        <div className="card">
          <h3 className="font-semibold text-gray-900 mb-4">Profil de l'exploitant</h3>
          {operator ? (
            <dl className="grid grid-cols-2 gap-y-3 text-sm">
              <dt className="text-gray-500">Nom commercial</dt>
              <dd className="text-gray-900 font-medium">{operator.businessName}</dd>

              <dt className="text-gray-500">NEQ</dt>
              <dd className="font-mono">{operator.neq ?? '–'}</dd>

              <dt className="text-gray-500">Code d'autorisation</dt>
              <dd className="font-mono">{operator.authorizationCode ?? '–'}</dd>

              <dt className="text-gray-500">Secteur d'activité</dt>
              <dd>{operator.sector ?? '–'}</dd>

              <dt className="text-gray-500">Environnement MEV</dt>
              <dd>
                <span className="badge-blue">{operator.mevEnvironment ?? '–'}</span>
              </dd>

              <dt className="text-gray-500">Numéro de TPS</dt>
              <dd className="font-mono">{operator.tpsNumber ?? '–'}</dd>

              <dt className="text-gray-500">Numéro de TVQ</dt>
              <dd className="font-mono">{operator.tvqNumber ?? '–'}</dd>
            </dl>
          ) : (
            <p className="text-gray-500 text-sm">Aucun profil chargé</p>
          )}
        </div>

        {/* Certificate */}
        <div className="card">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-semibold text-gray-900">Certificat MEV</h3>
            <button
              onClick={handleRequestCert}
              disabled={certLoading}
              className="btn-secondary text-sm disabled:opacity-50"
            >
              {certLoading ? 'Demande en cours...' : '🔄 Renouveler le certificat'}
            </button>
          </div>

          {certMsg && (
            <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-700 mb-3">
              {certMsg}
            </div>
          )}

          {cert ? (
            <dl className="grid grid-cols-2 gap-y-3 text-sm">
              <dt className="text-gray-500">Statut</dt>
              <dd>
                <span className={cert.isActive ? 'badge-green' : 'badge-red'}>
                  {cert.isActive ? 'Actif' : 'Inactif'}
                </span>
              </dd>

              <dt className="text-gray-500">Type</dt>
              <dd>{cert.certificateType}</dd>

              <dt className="text-gray-500">Émis le</dt>
              <dd>{cert.issuedAt ? new Date(cert.issuedAt).toLocaleDateString('fr-CA') : '–'}</dd>

              <dt className="text-gray-500">Expire le</dt>
              <dd>
                {cert.expiresAt ? (
                  <span className={
                    new Date(cert.expiresAt) < new Date(Date.now() + 30 * 86400000)
                      ? 'text-amber-600 font-medium'
                      : ''
                  }>
                    {new Date(cert.expiresAt).toLocaleDateString('fr-CA')}
                  </span>
                ) : '–'}
              </dd>

              <dt className="text-gray-500">N° de série</dt>
              <dd className="font-mono text-xs break-all col-span-1">{cert.serialNumber ?? '–'}</dd>
            </dl>
          ) : (
            <div className="text-center py-6">
              <p className="text-gray-500 text-sm">Aucun certificat actif</p>
              <button
                onClick={handleRequestCert}
                disabled={certLoading}
                className="btn-primary mt-3 disabled:opacity-50"
              >
                Demander un certificat
              </button>
            </div>
          )}
        </div>

        {/* Expiring certs warning */}
        {expiring.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <h4 className="font-medium text-amber-800 mb-2">⚠️ Certificats expirant bientôt</h4>
            {expiring.map((c: any) => (
              <p key={c.id} className="text-sm text-amber-700">
                Certificat {c.certificateType} expire le{' '}
                {new Date(c.expiresAt).toLocaleDateString('fr-CA')}
              </p>
            ))}
          </div>
        )}

        {/* Test cases link */}
        <div className="card">
          <h3 className="font-semibold text-gray-900 mb-2">Simulateur MEV</h3>
          <p className="text-sm text-gray-500 mb-3">
            Exécutez les cas de test SW-77 pour valider votre intégration avant la soumission à Revenu Québec.
          </p>
          <a
            href="/api/mev-simulator/health"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary text-sm"
          >
            🔬 Vérifier le simulateur
          </a>
        </div>
      </div>
    </Layout>
  );
}
