/**
 * Devices management page — register and monitor SEV devices
 */
import React, { useEffect, useState } from 'react';
import Layout from '../../components/Layout';
import { listDevices, flushDeviceQueue, registerDevice } from '../../lib/api';

// The file number (noDossFO) and the authorization code are private identity values: they are sent once, encrypted
// by the backend, never returned, and frozen once the device holds its certificate.
const DEVICE_TYPES = [
  { value: 'SERVER',         label: 'Serveur (QCMEV signe pour l’établissement)' },
  { value: 'CASH_REGISTER',  label: 'Caisse enregistreuse' },
  { value: 'TABLET',         label: 'Tablette' },
  { value: 'MOBILE',         label: 'Mobile' },
];

export default function DevicesPage() {
  const [devices, setDevices]       = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showForm, setShowForm]     = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [flushing, setFlushing]     = useState<string | null>(null);
  const [error, setError]           = useState('');

  // New device form state
  const [name, setName]             = useState('');
  const [serial, setSerial]         = useState('');
  const [deviceType, setDeviceType] = useState('SERVER');
  const [location, setLocation]     = useState('');
  const [fileNumber, setFileNumber] = useState('');
  const [authCode, setAuthCode]     = useState('');

  const loadDevices = () => {
    setLoading(true);
    listDevices()
      .then((r) => setDevices(r.data))
      .catch(() => setError('Impossible de charger les appareils'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadDevices(); }, []);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await registerDevice({ name, serialNumber: serial, deviceType, description: location, fileNumber, authorizationCode: authCode });
      setShowForm(false);
      setName(''); setSerial(''); setLocation(''); setFileNumber(''); setAuthCode('');
      loadDevices();
    } catch (err: any) {
      const m = err.response?.data?.message;
      setError(Array.isArray(m) ? m.join(' · ') : m ?? 'Erreur lors de l’enregistrement');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFlush = async (deviceId: string) => {
    setFlushing(deviceId);
    try {
      const res = await flushDeviceQueue(deviceId);
      alert(`File vidée — ${res.data.accepted} transaction(s) soumises`);
      loadDevices();
    } catch (err: any) {
      alert(err.response?.data?.message ?? 'Erreur lors du vidage de la file');
    } finally {
      setFlushing(null);
    }
  };

  return (
    <Layout>
      <div className="max-w-4xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Appareils SEV</h2>
          <button onClick={() => setShowForm(!showForm)} className="btn-primary">
            {showForm ? 'Annuler' : '+ Enregistrer un appareil'}
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 mb-4">
            {error}
          </div>
        )}

        {/* Registration form */}
        {showForm && (
          <div className="card mb-6">
            <h3 className="font-semibold text-gray-900 mb-4">Nouvel appareil</h3>
            <form onSubmit={handleRegister} className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Nom de l'appareil</label>
                <input
                  value={name} onChange={(e) => setName(e.target.value)} required
                  placeholder="Caisse principale"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">N° de série</label>
                <input
                  value={serial} onChange={(e) => setSerial(e.target.value)} required
                  placeholder="SN-123456"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Type</label>
                <select
                  value={deviceType} onChange={(e) => setDeviceType(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                >
                  {DEVICE_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Emplacement</label>
                <input
                  value={location} onChange={(e) => setLocation(e.target.value)}
                  placeholder="Salle principale"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">N° de dossier (facturation obligatoire)</label>
                <input
                  value={fileNumber} onChange={(e) => setFileNumber(e.target.value)}
                  placeholder="facultatif maintenant" autoComplete="off"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Code d’autorisation (XXXX-XXXX)</label>
                <input
                  type="password" value={authCode} onChange={(e) => setAuthCode(e.target.value.toUpperCase())}
                  placeholder="facultatif maintenant" autoComplete="off"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2"
                />
              </div>
              <div className="col-span-2">
                <button type="submit" disabled={submitting} className="btn-primary disabled:opacity-50">
                  {submitting ? 'Enregistrement...' : 'Enregistrer'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* Devices list */}
        {loading ? (
          <div className="text-center py-12 text-gray-500">Chargement...</div>
        ) : devices.length === 0 ? (
          <div className="card text-center py-12">
            <p className="text-gray-500">Aucun appareil enregistré</p>
          </div>
        ) : (
          <div className="space-y-3">
            {devices.map((device) => (
              <div key={device.id} className="card">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1">
                      <h3 className="font-semibold text-gray-900">{device.name ?? device.serialNumber}</h3>
                      <span className={device.offlineMode ? 'badge-yellow' : 'badge-green'}>
                        {device.offlineMode ? 'Hors ligne' : 'En ligne'}
                      </span>
                      <span className="badge-blue text-xs">{device.deviceType}</span>
                    </div>
                    <dl className="grid grid-cols-3 gap-x-6 text-sm mt-2">
                      <div>
                        <dt className="text-gray-500">N° série</dt>
                        <dd className="font-mono">{device.serialNumber}</dd>
                      </div>
                      <div>
                        <dt className="text-gray-500">Emplacement</dt>
                        <dd>{device.description || '–'}</dd>
                      </div>
                      <div>
                        <dt className="text-gray-500">Certificat (IDAPPRL)</dt>
                        <dd className="font-mono">{device.mevDeviceId ?? 'aucun'}</dd>
                      </div>
                    </dl>
                  </div>

                  <div className="flex gap-2 ml-4">
                    {device.offlineMode && (
                      <button
                        onClick={() => handleFlush(device.id)}
                        disabled={flushing === device.id}
                        className="btn-secondary text-sm disabled:opacity-50"
                      >
                        {flushing === device.id ? 'Envoi...' : '↑ Vider la file'}
                      </button>
                    )}
                  </div>
                </div>

                {device.lastSyncAt && (
                  <p className="text-xs text-gray-400 mt-2">
                    Dernière synchro: {new Date(device.lastSyncAt).toLocaleString('fr-CA')}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
