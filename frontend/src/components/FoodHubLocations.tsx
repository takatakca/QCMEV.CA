/**
 * Food Hub locations (kitchens) → SEV device: which device signs the invoices of each Food Hub kitchen.
 * Reads GET /api/operators/foodhub-locations; links with PUT, unlinks with DELETE (the row stays, inactive).
 * Linking also creates the FOODHUB-AUTO system user and registers it with MEV-WEB once a device is certified.
 */
import React, { useEffect, useState } from 'react';
import { linkFoodHubLocation, listFoodHubLocations, unlinkFoodHubLocation } from '../lib/api';

interface Props { devices: Array<{ id: string; name?: string | null; serialNumber: string; isActive?: boolean }>; }

const flag = (ok: boolean, yes: string, no: string) => <span className={ok ? 'badge-green' : 'badge-yellow'}>{ok ? yes : no}</span>;

export default function FoodHubLocations({ devices }: Props) {
  const [data, setData]         = useState<any>(null);
  const [error, setError]       = useState('');
  const [notice, setNotice]     = useState('');
  const [busy, setBusy]         = useState(false);
  const [tenantId, setTenantId] = useState('takatak');
  const [locationId, setLoc]    = useState('');
  const [deviceId, setDeviceId] = useState('');

  const load = () => {
    listFoodHubLocations()
      .then((r) => setData(r.data))
      .catch((err: any) => setError(err.response?.data?.message ?? 'Impossible de charger les cuisines Food Hub'));
  };
  useEffect(() => { load(); }, []);

  const active = devices.filter((d) => d.isActive !== false);
  const message = (err: any, fallback: string) => {
    const m = err.response?.data?.message;
    return Array.isArray(m) ? m.join(' · ') : m ?? fallback;
  };

  const handleLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const r = await linkFoodHubLocation({ tenantId: tenantId.trim(), locationId: locationId.trim(), deviceId: deviceId || active[0]?.id });
      const reg: string = r.data.foodhubAuto?.registration ?? '';
      setNotice(reg === 'registered'
        ? `Cuisine ${r.data.locationId} liée. Utilisateur FOODHUB-AUTO inscrit au MEV-WEB.`
        : `Cuisine ${r.data.locationId} liée. FOODHUB-AUTO sera inscrit au MEV-WEB après la demande de certificat de l’appareil.`);
      setLoc('');
      load();
    } catch (err: any) {
      setError(message(err, 'Erreur lors de la liaison'));
    } finally {
      setBusy(false);
    }
  };

  const handleUnlink = async (id: string, loc: string) => {
    if (!window.confirm(`Retirer la cuisine ${loc} ? Ses ventes Food Hub seront refusées (423) jusqu’à une nouvelle liaison.`)) return;
    try {
      await unlinkFoodHubLocation(id);
      load();
    } catch (err: any) {
      setError(message(err, 'Erreur lors du retrait'));
    }
  };

  return (
    <div className="card mt-8">
      <h3 className="font-semibold text-gray-900 mb-1">Cuisines Food Hub</h3>
      <p className="text-sm text-gray-500 mb-4">
        Chaque cuisine Food Hub est liée à un appareil SEV, qui numérote et signe ses factures.
        {data && !data.foodhubEnabled && ' L’API Food Hub est désactivée sur ce serveur (QCMEV_FOODHUB_ENABLED=false) : la liaison peut être préparée maintenant.'}
      </p>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 mb-4">{error}</div>}
      {notice && <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700 mb-4">{notice}</div>}

      {data?.locations?.length ? (
        <table className="w-full text-sm mb-6">
          <thead>
            <tr className="border-b border-gray-100 text-left text-gray-500">
              <th className="py-2 font-medium">Cuisine</th>
              <th className="py-2 font-medium">Appareil</th>
              <th className="py-2 font-medium">Prête ?</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {data.locations.map((l: any) => (
              <tr key={l.id} className={`border-b border-gray-50 ${l.isActive ? '' : 'opacity-50'}`}>
                <td className="py-2 font-mono">{l.tenantId} / {l.locationId}</td>
                <td className="py-2">{l.device?.name ?? l.device?.serialNumber}</td>
                <td className="py-2 space-x-1">
                  {l.isActive ? (
                    <>
                      {flag(l.deviceReady, 'Appareil', 'Appareil incomplet')}
                      {flag(l.certReady, 'Certificat', 'Certificat absent ou expiré')}
                      {flag(l.usersReady, 'FOODHUB-AUTO', 'FOODHUB-AUTO non inscrit')}
                    </>
                  ) : <span className="badge-blue">Retirée</span>}
                </td>
                <td className="py-2 text-right">
                  {l.isActive && <button onClick={() => handleUnlink(l.id, l.locationId)} className="btn-secondary text-sm">Retirer</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-gray-500 mb-6">Aucune cuisine Food Hub liée.</p>
      )}

      <form onSubmit={handleLink} className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Locataire Food Hub</label>
          <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} required className="w-full border border-gray-300 rounded-lg px-3 py-2" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Identifiant de la cuisine</label>
          <input value={locationId} onChange={(e) => setLoc(e.target.value)} required placeholder="KITCHEN_A" className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Appareil SEV</label>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2">
            {active.map((d) => <option key={d.id} value={d.id}>{d.name ?? d.serialNumber}</option>)}
          </select>
        </div>
        <div>
          <button type="submit" disabled={busy || !active.length} className="btn-primary w-full disabled:opacity-50">
            {busy ? 'Liaison...' : 'Lier la cuisine'}
          </button>
        </div>
      </form>
    </div>
  );
}
