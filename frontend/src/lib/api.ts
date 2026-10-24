/**
 * API client for the Takatak MEV backend (JWT in localStorage).
 * The backend works in integer cents and Revenu Québec codes; this file adapts them for the dashboard pages.
 */

import axios from 'axios';

const api = axios.create({
  baseURL: typeof window !== 'undefined' ? '/api' : (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001') + '/api',
  timeout: 15000,
});

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('takatak_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('takatak_token');
      localStorage.removeItem('takatak_user');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  },
);

/** Old dashboard payment names → Revenu Québec modPai codes. */
const PAYMENT: Record<string, string> = { CASH: 'ARG', CREDIT_CARD: 'CRE', DEBIT_CARD: 'DEB', CHEQUE: 'CHQ', GIFT_CARD: 'CPR', MIXED: 'MIX', OTHER: 'AUT' };

/** Adds the dollar fields the pages display (the backend stores cents). */
export function withDollars(tx: any) {
  if (!tx) return tx;
  return {
    ...tx,
    subtotal: tx.subtotalCents / 100,
    tpsAmount: tx.tpsCents / 100,
    tvqAmount: tx.tvqCents / 100,
    totalAmount: tx.totalCents / 100,
    tipsAmount: tx.tipCents ? tx.tipCents / 100 : null,
    mevSubmissionStatus: tx.mevStatus,
  };
}

// Auth
export const login = (username: string, password: string) => api.post('/auth/login', { username, password });

// Operator
export const getMe = () => api.get('/operators/me');
export const getMevStatus = () => api.get('/operators/mev-status');
/** Whitelisted operator settings (e.g. addressUtc: the UTC of the business address written in the next certificate request). */
export const updateMe = (body: Record<string, string>) => api.put('/operators/me', body);

// Transactions
export const listTransactions = async () => {
  const r = await api.get('/transactions');
  return { ...r, data: (r.data ?? []).map(withDollars) };
};
export const createTransaction = (data: any) =>
  api.post('/transactions', {
    deviceId: data.deviceId,
    items: (data.items ?? []).map((i: any) => ({
      description: i.description,
      quantity: String(i.quantity ?? 1),
      unitPriceCents: Math.round(Number(i.unitPrice ?? 0) * 100),
      tax: i.taxCode || 'NON',
    })),
    paymentMode: PAYMENT[data.paymentMode] ?? data.paymentMode,
    serviceType: data.tableNumber ? 'TBL' : 'CMP',
    tableNumber: data.tableNumber,
    numberOfCovers: data.numberOfCovers,
    tipCents: data.tipsAmount ? Math.round(Number(data.tipsAmount) * 100) : undefined,
  });
export const cancelTransaction = (id: string, reason?: string) => api.post(`/transactions/${id}/cancel`, { reason });
export const getTransaction = async (id: string) => {
  const r = await api.get(`/transactions/${id}`);
  return { ...r, data: withDollars(r.data) };
};
export const getReceipt = (id: string) => api.get(`/transactions/${id}/receipt`);
export const reprint = (id: string, mode: 'RPR' | 'DUP') => api.post(`/transactions/${id}/reprint`, { mode });
export const getDailySummary = (date?: string) => api.get('/transactions/daily-summary', { params: { date } });

// Devices. The file number and authorization code are write-only: sent once, encrypted, never returned.
export const listDevices = () => api.get('/devices');
export const registerDevice = (data: { name?: string; serialNumber: string; deviceType?: string; description?: string; model?: string; firmwareVersion?: string; fileNumber?: string; authorizationCode?: string }) =>
  api.post('/devices', Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined && v !== '')));
export const getDeviceOfflineStatus = (id: string) => api.get(`/devices/${id}/offline-status`);
export const flushDeviceQueue = (id: string) => api.post(`/devices/${id}/flush-queue`);

// Food Hub locations (kitchens) → SEV device. Linking also creates and registers the FOODHUB-AUTO system user.
export const listFoodHubLocations = () => api.get('/operators/foodhub-locations');
export const linkFoodHubLocation = (body: { tenantId: string; locationId: string; deviceId: string }) => api.put('/operators/foodhub-locations', body);
export const unlinkFoodHubLocation = (id: string) => api.delete(`/operators/foodhub-locations/${id}`);

// Certificates (CRT + UTL per device)
export const listCertificates = () => api.get('/certificates');
export const getActiveCert = async () => {
  const r = await api.get('/certificates');
  const active = (r.data ?? []).find((c: any) => c.type === 'SEV' && c.isActive) ?? null;
  return { ...r, data: active ? { ...active, certificateType: active.type, validTo: active.validUntil, issuedAt: active.validFrom, expiresAt: active.validUntil } : null };
};
export const requestCertificate = async (deviceId?: string) => {
  const id = deviceId ?? (await api.get('/devices')).data?.[0]?.id;
  if (!id) throw new Error('Aucun appareil');
  return api.post(`/devices/${id}/certificate`, {});
};
export const getExpiringCerts = async () => {
  const r = await api.get('/certificates/expiring');
  return { ...r, data: (r.data ?? []).map((c: any) => ({ ...c, certificateType: 'SEV', expiresAt: c.validUntil })) };
};
/** Renews every certified device now (CRT REM), like the nightly job. */
export const renewCertificates = () => api.post('/certificates/renew', {});

// User report (DOC RUT): displayed for the logged-in user, and its sales summary transmitted, every time it is produced
export const listReports = () => api.get('/reports');
export const produceUserReport = (year: number, deviceId?: string) => api.post('/reports/user-report', { year, ...(deviceId ? { deviceId } : {}) });

// Local simulator (SIMULATOR / DEV only)
export const getSimulatorHealth = () => api.get('/mev-simulator/health');

export default api;
