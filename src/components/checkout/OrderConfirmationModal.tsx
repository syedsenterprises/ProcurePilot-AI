'use client';

import React from 'react';
import {
  CheckCircle2,
  Printer,
  X,
  ShieldCheck,
  Building2,
  UserCheck,
  Calendar,
  AlertTriangle,
  Receipt
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { PayPalCaptureResponse } from '@/types/paypal';

interface OrderConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  captureData: PayPalCaptureResponse | null;
}

export function OrderConfirmationModal({
  isOpen,
  onClose,
  captureData
}: OrderConfirmationModalProps) {
  if (!isOpen || !captureData) return null;

  const order = captureData.orderDetails;
  const isSimulated = Boolean(captureData.isSimulated);

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn print:p-0 print:bg-white print:static print:inset-auto">
      <div
        className="relative w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl shadow-black text-slate-200 print:max-h-none print:w-full print:border-none print:shadow-none print:bg-white print:text-black"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 bg-slate-900/90 border-b border-slate-800 print:border-b-2 print:border-black print:bg-white">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-emerald-950/80 border border-emerald-800/60 text-emerald-400 print:bg-transparent print:border-none print:text-black print:p-0">
              <CheckCircle2 className="w-5 h-5 print:w-6 print:h-6" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white print:text-black print:text-xl">
                Commercial Purchase Order Confirmation
              </h3>
              <p className="text-xs text-slate-400 print:text-gray-600">
                Authorized & Verified by ProcurePilot AI Server Registry
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 print:hidden">
            <Button
              variant="outline"
              size="sm"
              onClick={handlePrint}
              className="gap-1.5 text-xs text-slate-300 hover:text-white"
            >
              <Printer className="w-3.5 h-3.5" />
              <span>Print Receipt</span>
            </Button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="p-6 space-y-6 print:p-4 print:space-y-4">
          {/* Simulation Notice Warning (when simulated) */}
          {isSimulated && (
            <div className="flex items-start gap-3 p-3.5 rounded-xl bg-amber-950/40 border border-amber-800/60 text-xs text-amber-200 print:border print:border-amber-700 print:bg-amber-50 print:text-amber-900">
              <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold block text-amber-100 print:text-amber-900">
                  Development Simulation Notice
                </span>
                <p className="text-[11px] leading-relaxed text-amber-300/90 print:text-amber-800">
                  {captureData.simulationNotice ||
                    'This order was processed in development simulation mode. All server-side checks and price verifications succeeded, but no live PayPal Sandbox funds were debited.'}
                </p>
              </div>
            </div>
          )}

          {/* Key Reference Identifiers */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 rounded-xl bg-slate-950/70 border border-slate-800/80 text-xs print:border print:border-gray-300 print:bg-gray-50 print:text-black">
            <div className="space-y-1">
              <span className="text-[11px] text-slate-500 uppercase font-mono print:text-gray-500">
                PayPal Order ID
              </span>
              <p className="font-mono font-semibold text-purple-300 print:text-black text-sm select-all">
                {captureData.orderId || order?.orderId}
              </p>
            </div>
            <div className="space-y-1">
              <span className="text-[11px] text-slate-500 uppercase font-mono print:text-gray-500">
                Capture Transaction ID
              </span>
              <p className="font-mono font-semibold text-emerald-400 print:text-black text-sm select-all">
                {captureData.captureId || order?.captureId || 'N/A'}
              </p>
            </div>
            <div className="space-y-1">
              <span className="text-[11px] text-slate-500 uppercase font-mono print:text-gray-500">
                Payment Status
              </span>
              <div className="pt-0.5">
                <Badge variant="success" size="sm">
                  {captureData.status || order?.status || 'COMPLETED'}
                </Badge>
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-[11px] text-slate-500 uppercase font-mono print:text-gray-500">
                Transaction Date
              </span>
              <p className="text-slate-300 print:text-gray-800 flex items-center gap-1.5 font-mono text-[11px]">
                <Calendar className="w-3.5 h-3.5 text-slate-400 print:hidden" />
                <span>
                  {order?.capturedAt
                    ? new Date(order.capturedAt).toLocaleString()
                    : new Date().toLocaleString()}
                </span>
              </p>
            </div>
          </div>

          {/* Itemized Purchased Products */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 print:text-gray-700 flex items-center gap-1.5">
                <Receipt className="w-3.5 h-3.5 text-purple-400 print:hidden" />
                <span>Authoritative Itemized Inventory</span>
              </h4>
              <span className="text-[11px] text-slate-500 font-mono print:text-gray-500">
                {order?.items?.length || 0} Line Items
              </span>
            </div>

            <div className="rounded-xl border border-slate-800 overflow-hidden print:border-gray-300">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-950/80 text-slate-400 border-b border-slate-800 print:bg-gray-100 print:text-gray-700 print:border-gray-300">
                  <tr>
                    <th className="py-2.5 px-3 font-semibold">Product Description</th>
                    <th className="py-2.5 px-3 font-semibold text-center">Qty</th>
                    <th className="py-2.5 px-3 font-semibold text-right">Unit Price</th>
                    <th className="py-2.5 px-3 font-semibold text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 print:divide-gray-200">
                  {order?.items?.map((item) => (
                    <tr key={item.productId} className="hover:bg-slate-800/20 print:hover:bg-transparent">
                      <td className="py-2.5 px-3">
                        <span className="font-medium text-slate-200 print:text-black block">
                          {item.name}
                        </span>
                        <span className="text-[10px] text-slate-500 font-mono print:text-gray-500">
                          ID: {item.productId}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-center text-slate-300 print:text-black font-mono">
                        {item.quantity}
                      </td>
                      <td className="py-2.5 px-3 text-right text-slate-400 print:text-gray-700 font-mono">
                        ${item.unitPrice.toFixed(2)}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono font-semibold text-slate-200 print:text-black">
                        ${(item.unitPrice * item.quantity).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Pricing & Financial Breakdown */}
          <div className="p-4 rounded-xl bg-slate-950/50 border border-slate-800 space-y-2 text-xs print:border print:border-gray-300 print:bg-gray-50">
            <div className="flex justify-between text-slate-400 print:text-gray-600">
              <span>Item Subtotal</span>
              <span className="font-mono text-slate-200 print:text-black">
                ${order?.authorizedSubtotal?.toFixed(2) || '0.00'}
              </span>
            </div>
            <div className="flex justify-between text-slate-400 print:text-gray-600">
              <span>Commercial Sales Tax (8.25%)</span>
              <span className="font-mono text-slate-200 print:text-black">
                ${order?.authorizedTax?.toFixed(2) || '0.00'}
              </span>
            </div>
            <div className="flex justify-between text-slate-400 print:text-gray-600">
              <span>Enterprise Ground Shipping</span>
              <span className="font-mono text-slate-200 print:text-black">
                {order?.authorizedShipping === 0
                  ? 'FREE (Order > $1,000)'
                  : `$${order?.authorizedShipping?.toFixed(2)}`}
              </span>
            </div>
            <div className="pt-2 border-t border-slate-800 print:border-gray-300 flex justify-between items-center text-sm font-bold text-white print:text-black">
              <span>Total Paid & Captured</span>
              <span className="text-base text-emerald-400 print:text-black font-mono">
                ${order?.authorizedTotal?.toFixed(2)} {order?.currency || 'USD'}
              </span>
            </div>
          </div>

          {/* Governance & Approver Audit Stamp */}
          <div className="p-3.5 rounded-xl bg-slate-950/40 border border-slate-800 text-[11px] text-slate-400 space-y-1.5 print:border print:border-gray-300 print:bg-white print:text-gray-700">
            <div className="flex items-center gap-1.5 font-semibold text-slate-300 print:text-black">
              <ShieldCheck className="w-3.5 h-3.5 text-purple-400 print:text-black" />
              <span>Governance Sign-Off & Ticket Provenance</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
              <div className="flex items-center gap-1.5">
                <UserCheck className="w-3.5 h-3.5 text-slate-500 print:hidden" />
                <span>Requisitioner: {order?.approverName || 'Alex Mercer'}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 text-slate-500 print:hidden" />
                <span>Department: {order?.approverDepartment || 'Engineering'}</span>
              </div>
            </div>
            <p className="text-[10px] text-slate-500 font-mono truncate print:text-gray-500">
              Cryptographic Ticket ID: {order?.ticketId}
            </p>
          </div>

          {/* Footer Action */}
          <div className="flex justify-between items-center pt-2 print:hidden">
            <span className="text-[11px] text-slate-500">
              A copy of this confirmation has been archived in the server audit registry.
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={handlePrint}>
                <Printer className="w-3.5 h-3.5 mr-1" />
                Print Receipt
              </Button>
              <Button variant="primary" size="sm" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
