/**
 * Main Layout — sidebar navigation + offline banner
 * Used by all authenticated pages.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';

interface LayoutProps { children: React.ReactNode; }

const navItems = [
  { href: '/',                    label: 'Tableau de bord',   icon: '📊' },
  { href: '/transactions',        label: 'Transactions',      icon: '🧾' },
  { href: '/transactions/new',    label: 'Nouvelle vente',    icon: '➕' },
  { href: '/devices',             label: 'Appareils',         icon: '💻' },
  { href: '/reports/user-report', label: 'Rapports',          icon: '📋' },
  { href: '/settings',            label: 'Paramètres',        icon: '⚙️' },
];

export default function Layout({ children }: LayoutProps) {
  const router = useRouter();
  const [offline, setOffline]   = useState(false);
  const [user, setUser]         = useState<any>(null);

  useEffect(() => {
    const stored = localStorage.getItem('takatak_user');
    if (stored) setUser(JSON.parse(stored));

    const handleOnline  = () => setOffline(false);
    const handleOffline = () => setOffline(true);
    window.addEventListener('online',  handleOnline);
    window.addEventListener('offline', handleOffline);
    setOffline(!navigator.onLine);
    return () => {
      window.removeEventListener('online',  handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const logout = () => {
    localStorage.removeItem('takatak_token');
    localStorage.removeItem('takatak_user');
    router.push('/login');
  };

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Sidebar */}
      <aside className="w-64 bg-brand-900 text-white flex flex-col">
        <div className="p-5 border-b border-brand-700">
          <h1 className="text-xl font-bold">Takatak MEV</h1>
          <p className="text-xs text-blue-300 mt-1">Système d'Enregistrement des Ventes</p>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => {
            const active = router.pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors
                  ${active
                    ? 'bg-brand-500 text-white font-medium'
                    : 'text-blue-200 hover:bg-brand-700 hover:text-white'}`}
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-brand-700">
          {user && (
            <p className="text-xs text-blue-300 mb-2">
              {user.username} ({user.role})
            </p>
          )}
          <button
            onClick={logout}
            className="w-full text-left text-xs text-blue-300 hover:text-white px-3 py-2"
          >
            Déconnexion
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Offline banner */}
        {offline && (
          <div className="bg-amber-500 text-white text-center text-sm py-2 font-medium">
            ⚠️ Mode hors ligne — Les transactions seront soumises au MEV-WEB lors du rétablissement de la connexion
          </div>
        )}
        <div className="flex-1 overflow-auto p-6">
          {children}
        </div>
      </main>
    </div>
  );
}
