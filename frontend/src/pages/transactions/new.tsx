/**
 * New Transaction page — create a sale (ADD transaction)
 * Supports multiple line items, tax code selection, payment mode
 */
import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Layout from '../../components/Layout';
import { createTransaction, listDevices } from '../../lib/api';

interface LineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  taxCode: string;
}

const TAX_CODES = [
  { value: 'FP', label: 'FP — TPS + TVQ (5% + 9.975%)' },
  { value: 'F',  label: 'F  — TPS seulement (5%)' },
  { value: 'P',  label: 'P  — TVQ seulement (9.975%)' },
  { value: '',   label: '   — Exempté' },
];

const PAYMENT_MODES = [
  { value: 'CASH',         label: 'Comptant' },
  { value: 'CREDIT_CARD',  label: 'Carte de crédit' },
  { value: 'DEBIT_CARD',   label: 'Carte de débit' },
  { value: 'MOBILE',       label: 'Paiement mobile' },
  { value: 'GIFT_CARD',    label: 'Carte-cadeau' },
  { value: 'OTHER',        label: 'Autre' },
];

export default function NewTransactionPage() {
  const router  = useRouter();
  const [devices, setDevices] = useState<any[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [items, setItems] = useState<LineItem[]>([
    { description: '', quantity: 1, unitPrice: 0, taxCode: 'FP' },
  ]);
  const [paymentMode, setPaymentMode] = useState('CASH');
  const [tableNumber, setTableNumber] = useState('');
  const [covers, setCovers] = useState('');
  const [tips, setTips]     = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  useEffect(() => {
    listDevices().then((r) => {
      setDevices(r.data);
      if (r.data.length > 0) setDeviceId(r.data[0].id);
    });
  }, []);

  const addItem = () =>
    setItems([...items, { description: '', quantity: 1, unitPrice: 0, taxCode: 'FP' }]);

  const removeItem = (idx: number) => setItems(items.filter((_, i) => i !== idx));

  const updateItem = (idx: number, field: keyof LineItem, value: any) =>
    setItems(items.map((item, i) => i === idx ? { ...item, [field]: value } : item));

  const calcSubtotal = () =>
    items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);

  const calcTps = () =>
    items.reduce((sum, i) =>
      ['FP', 'F'].includes(i.taxCode) ? sum + i.quantity * i.unitPrice * 0.05 : sum, 0);

  const calcTvq = () =>
    items.reduce((sum, i) =>
      ['FP', 'P'].includes(i.taxCode) ? sum + i.quantity * i.unitPrice * 0.09975 : sum, 0);

  const total = () => calcSubtotal() + calcTps() + calcTvq() + Number(tips || 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deviceId) { setError('Veuillez sélectionner un appareil'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await createTransaction({
        deviceId,
        items: items.map((i) => ({
          ...i,
          quantity:  Number(i.quantity),
          unitPrice: Number(i.unitPrice),
        })),
        paymentMode,
        tableNumber:    tableNumber || undefined,
        numberOfCovers: covers ? Number(covers) : undefined,
        tipsAmount:     tips ? Number(tips) : undefined,
      });
      router.push(`/transactions/${res.data.id}`);
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Erreur lors de la création');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout>
      <div className="max-w-2xl mx-auto">
        <h2 className="text-2xl font-bold text-gray-900 mb-6">Nouvelle transaction</h2>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Device */}
          <div className="card">
            <label className="block text-sm font-medium text-gray-700 mb-1">Appareil</label>
            <select
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2"
            >
              {devices.map((d) => (
                <option key={d.id} value={d.id}>{d.name} ({d.serialNumber})</option>
              ))}
            </select>
          </div>

          {/* Items */}
          <div className="card">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-semibold text-gray-900">Articles</h3>
              <button type="button" onClick={addItem} className="btn-secondary text-sm">
                + Ajouter
              </button>
            </div>

            <div className="space-y-3">
              {items.map((item, idx) => (
                <div key={idx} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-4">
                    {idx === 0 && <label className="block text-xs text-gray-500 mb-1">Description</label>}
                    <input
                      value={item.description}
                      onChange={(e) => updateItem(idx, 'description', e.target.value)}
                      placeholder="Article"
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                      required
                    />
                  </div>
                  <div className="col-span-2">
                    {idx === 0 && <label className="block text-xs text-gray-500 mb-1">Qté</label>}
                    <input
                      type="number" min="0.001" step="0.001"
                      value={item.quantity}
                      onChange={(e) => updateItem(idx, 'quantity', e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div className="col-span-2">
                    {idx === 0 && <label className="block text-xs text-gray-500 mb-1">Prix unit.</label>}
                    <input
                      type="number" min="0" step="0.01"
                      value={item.unitPrice}
                      onChange={(e) => updateItem(idx, 'unitPrice', e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                    />
                  </div>
                  <div className="col-span-3">
                    {idx === 0 && <label className="block text-xs text-gray-500 mb-1">Taxe</label>}
                    <select
                      value={item.taxCode}
                      onChange={(e) => updateItem(idx, 'taxCode', e.target.value)}
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                    >
                      {TAX_CODES.map((t) => (
                        <option key={t.value} value={t.value}>{t.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-1 flex justify-end">
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeItem(idx)}
                        className="text-red-400 hover:text-red-600 text-lg"
                      >×</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Payment + extras */}
          <div className="card grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Mode de paiement</label>
              <select
                value={paymentMode}
                onChange={(e) => setPaymentMode(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              >
                {PAYMENT_MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Pourboire ($)</label>
              <input
                type="number" min="0" step="0.01"
                value={tips}
                onChange={(e) => setTips(e.target.value)}
                placeholder="0.00"
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">N° de table</label>
              <input
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Nbre de couverts</label>
              <input
                type="number" min="0"
                value={covers}
                onChange={(e) => setCovers(e.target.value)}
                className="w-full border border-gray-300 rounded-lg px-3 py-2"
              />
            </div>
          </div>

          {/* Totals */}
          <div className="card">
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-gray-500">Sous-total</dt>
                <dd>{calcSubtotal().toFixed(2)} $</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">TPS (5%)</dt>
                <dd>{calcTps().toFixed(2)} $</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-gray-500">TVQ (9.975%)</dt>
                <dd>{calcTvq().toFixed(2)} $</dd>
              </div>
              {Number(tips) > 0 && (
                <div className="flex justify-between">
                  <dt className="text-gray-500">Pourboire</dt>
                  <dd>{Number(tips).toFixed(2)} $</dd>
                </div>
              )}
              <div className="flex justify-between font-bold text-base border-t border-gray-200 pt-2 mt-2">
                <dt>Total</dt>
                <dd>{total().toFixed(2)} $</dd>
              </div>
            </dl>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button type="submit" disabled={loading} className="btn-primary flex-1 disabled:opacity-50">
              {loading ? 'Envoi en cours...' : '✅ Émettre la transaction'}
            </button>
            <button type="button" onClick={() => router.back()} className="btn-secondary">
              Annuler
            </button>
          </div>
        </form>
      </div>
    </Layout>
  );
}
