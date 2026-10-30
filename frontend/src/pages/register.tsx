/**
 * Création de compte (public) : l'opérateur (l'entreprise) et son premier gérant, en une seule fois
 * (POST /api/operators/register, refusé quand QCMEV_PUBLIC_REGISTRATION=false). Ensuite : connexion automatique, puis
 * la page Appareils (numéro de dossier et code d'autorisation de Revenu Québec, certificat, cuisine Food Hub).
 *
 * Venue de TAKATAK MEV sur Clover (page d'accueil Food Hub) : ?tenant=…&fh=CLV_… — le code de cuisine Food Hub du
 * marchand est gardé dans ce navigateur pour pré-remplir « Cuisines Food Hub » sur la page Appareils.
 */
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { FOODHUB_LINK_KEY, login, registerOperator } from '../lib/api';

const TENANT = /^[a-z0-9][a-z0-9-]{1,39}$/;
const LOCATION = /^[A-Za-z0-9_-]{1,64}$/;

const field = 'w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-500';

export default function RegisterPage() {
  const router = useRouter();
  const [f, setF] = useState({
    name: '', neq: '', noTPS: '', noTVQ: '', address: '', city: '', postalCode: '', phone: '', email: '',
    adminFirstName: '', adminLastName: '', adminUsername: '', adminPassword: '', confirm: '',
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [foodhub, setFoodhub] = useState<{ tenantId: string; locationId: string } | null>(null);

  useEffect(() => {
    if (!router.isReady) return;
    const tenantId = String(router.query.tenant ?? '');
    const locationId = String(router.query.fh ?? '');
    if (TENANT.test(tenantId) && LOCATION.test(locationId)) {
      setFoodhub({ tenantId, locationId });
      try { localStorage.setItem(FOODHUB_LINK_KEY, JSON.stringify({ tenantId, locationId })); } catch { /* shown below to copy by hand */ }
    }
  }, [router.isReady, router.query.tenant, router.query.fh]);

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (f.adminPassword !== f.confirm) {
      setError('Les deux mots de passe ne sont pas identiques.');
      return;
    }
    setLoading(true);
    const optional = (v: string) => (v.trim() ? v.trim() : undefined);
    try {
      await registerOperator({
        name: f.name.trim(),
        neq: f.neq.replace(/\s/g, ''),
        noTPS: f.noTPS.replace(/\s/g, '').toUpperCase(),
        noTVQ: f.noTVQ.replace(/\s/g, '').toUpperCase(),
        address: optional(f.address),
        city: optional(f.city),
        postalCode: optional(f.postalCode.toUpperCase()),
        phone: optional(f.phone),
        email: optional(f.email),
        adminUsername: f.adminUsername.trim(),
        adminPassword: f.adminPassword,
        adminFirstName: optional(f.adminFirstName),
        adminLastName: optional(f.adminLastName),
      });
      const res = await login(f.adminUsername.trim(), f.adminPassword);
      localStorage.setItem('takatak_token', res.data.accessToken);
      localStorage.setItem('takatak_user', JSON.stringify(res.data.user));
      router.push('/devices?nouveau=1');
    } catch (err: any) {
      const m = err.response?.data?.message;
      setError(Array.isArray(m) ? m.join(' · ') : m ?? 'La création du compte a échoué.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-brand-900 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-8">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-brand-900">Créer un compte Takatak MEV</h1>
          <p className="text-sm text-gray-500 mt-1">Système d'Enregistrement des Ventes · secteur restauration</p>
        </div>

        {foodhub && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900 mb-6">
            Caisse Clover reliée par TAKATAK MEV. Après la création du compte, ajoutez votre caisse dans Appareils :
            la cuisine Food Hub <span className="font-mono font-semibold">{foodhub.locationId}</span> (locataire{' '}
            <span className="font-mono">{foodhub.tenantId}</span>) sera déjà remplie.
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <fieldset className="space-y-3">
            <legend className="font-semibold text-gray-900 mb-1">L'entreprise</legend>
            <div>
              <label htmlFor="reg-name" className="block text-sm font-medium text-gray-700 mb-1">Nom légal ou commercial</label>
              <input id="reg-name" name="name" value={f.name} onChange={set('name')} required maxLength={200} className={field} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="reg-neq" className="block text-sm font-medium text-gray-700 mb-1">NEQ (10 chiffres)</label>
                <input id="reg-neq" name="neq" value={f.neq} onChange={set('neq')} required inputMode="numeric" pattern="\s*\d{10}\s*" className={`${field} font-mono`} />
              </div>
              <div>
                <label htmlFor="reg-noTPS" className="block text-sm font-medium text-gray-700 mb-1">No TPS</label>
                <input id="reg-noTPS" name="noTPS" value={f.noTPS} onChange={set('noTPS')} required placeholder="123456789RT0001" className={`${field} font-mono`} />
              </div>
              <div>
                <label htmlFor="reg-noTVQ" className="block text-sm font-medium text-gray-700 mb-1">No TVQ</label>
                <input id="reg-noTVQ" name="noTVQ" value={f.noTVQ} onChange={set('noTVQ')} required placeholder="1234567890TQ0001" className={`${field} font-mono`} />
              </div>
            </div>
            <p className="text-xs text-gray-500">Les numéros de TPS et de TVQ sont écrits dans le certificat de chaque appareil : ils ne changent plus après la première demande de certificat.</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label htmlFor="reg-address" className="block text-sm font-medium text-gray-700 mb-1">Adresse</label>
                <input id="reg-address" name="address" value={f.address} onChange={set('address')} maxLength={300} className={field} />
              </div>
              <div>
                <label htmlFor="reg-postalCode" className="block text-sm font-medium text-gray-700 mb-1">Code postal</label>
                <input id="reg-postalCode" name="postalCode" value={f.postalCode} onChange={set('postalCode')} placeholder="H2X 1Y4" className={field} />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label htmlFor="reg-city" className="block text-sm font-medium text-gray-700 mb-1">Ville</label>
                <input id="reg-city" name="city" value={f.city} onChange={set('city')} maxLength={100} className={field} />
              </div>
              <div>
                <label htmlFor="reg-phone" className="block text-sm font-medium text-gray-700 mb-1">Téléphone</label>
                <input id="reg-phone" name="phone" value={f.phone} onChange={set('phone')} maxLength={30} className={field} />
              </div>
              <div>
                <label htmlFor="reg-email" className="block text-sm font-medium text-gray-700 mb-1">Courriel</label>
                <input id="reg-email" name="email" type="email" value={f.email} onChange={set('email')} maxLength={200} className={field} />
              </div>
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="font-semibold text-gray-900 mb-1">Le gérant (premier administrateur)</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="reg-adminFirstName" className="block text-sm font-medium text-gray-700 mb-1">Prénom</label>
                <input id="reg-adminFirstName" name="adminFirstName" value={f.adminFirstName} onChange={set('adminFirstName')} maxLength={100} className={field} />
              </div>
              <div>
                <label htmlFor="reg-adminLastName" className="block text-sm font-medium text-gray-700 mb-1">Nom</label>
                <input id="reg-adminLastName" name="adminLastName" value={f.adminLastName} onChange={set('adminLastName')} maxLength={100} className={field} />
              </div>
            </div>
            <div>
              <label htmlFor="reg-adminUsername" className="block text-sm font-medium text-gray-700 mb-1">Nom d'utilisateur</label>
              <input id="reg-adminUsername" name="adminUsername" value={f.adminUsername} onChange={set('adminUsername')} required autoComplete="username" pattern="[A-Za-z0-9._@\-]{3,60}" className={field} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="reg-adminPassword" className="block text-sm font-medium text-gray-700 mb-1">Mot de passe (12 caractères ou plus)</label>
                <input id="reg-adminPassword" name="adminPassword" type="password" value={f.adminPassword} onChange={set('adminPassword')} required minLength={12} autoComplete="new-password" className={field} />
              </div>
              <div>
                <label htmlFor="reg-confirm" className="block text-sm font-medium text-gray-700 mb-1">Confirmer le mot de passe</label>
                <input id="reg-confirm" name="confirm" type="password" value={f.confirm} onChange={set('confirm')} required minLength={12} autoComplete="new-password" className={field} />
              </div>
            </div>
          </fieldset>

          {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{error}</div>}

          <button type="submit" disabled={loading} className="w-full btn-primary disabled:opacity-50">
            {loading ? 'Création du compte...' : 'Créer le compte'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-gray-500">
          Déjà un compte ? <Link href="/login" className="text-brand-700 font-medium hover:underline">Se connecter</Link>
        </p>
        <p className="mt-2 text-center text-xs text-gray-400">
          Logiciel non certifié · simulateur / DEV seulement
        </p>
      </div>
    </div>
  );
}
