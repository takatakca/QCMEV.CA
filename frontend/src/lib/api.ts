/**
 * API client with JWT auth interceptor.
 * All requests go to the NestJS backend at /api.
 */

import axios from 'axios';

const api = axios.create({
  baseURL: typeof window !== 'undefined'
    ? '/api'
    : (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001') + '/api',
  timeout: 15000,
});

// Attach JWT token from localStorage
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('takatak_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Redirect to login on 401
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

// Auth
export const login = (username: string, password: string) =>
  api.post('/auth/login', { username, password });

// Operator
export const getMe = () => api.get('/operators/me');
export const getMevStatus = () => api.get('/operators/mev-status');

// Transactions
export const createTransaction = (data: any) => api.post('/transactions', data);
export const cancelTransaction = (id: string, reason?: string) =>
  api.post(`/transactions/${id}/cancel`, { reason });
export const getReceipt = (id: string) => api.get(`/transactions/${id}/receipt`);
export const getDailySummary = (deviceId: string, date?: string) =>
  api.get('/transactions/daily-summary', { params: { deviceId, date } });

// Devices
export const listDevices = () => api.get('/devices');
export const registerDevice = (data: any) => api.post('/devices', data);
export const getDeviceOfflineStatus = (id: string) => api.get(`/devices/${id}/offline-status`);
export const flushDeviceQueue = (id: string) => api.post(`/devices/${id}/flush-queue`);

// Certificates
export const getActiveCert = () => api.get('/certificates/active');
export const requestCertificate = (deviceId: string) => api.post('/certificates/request', { deviceId });
export const getExpiringCerts = () => api.get('/certificates/expiring');

// Reports
export const listReports = () => api.get('/reports');
export const generateAnnualReport = (year: number) => api.post('/reports/annual', { year });

// MEV Simulator (dev only)
export const getSimulatorHealth = () => api.get('/mev-simulator/health');
export const getTestCases = () => api.get('/mev-simulator/test-cases');

export default api;
