'use client';

import React from 'react';
import { useCart } from '@/context/CartContext';
import { ShieldAlert, ShieldCheck, RefreshCw } from 'lucide-react';
import { Badge } from '../ui/Badge';

export function PurchaseSummary() {
  const { cartSummary, serverReconciliation, isReconciling } = useCart();

  const isServerVerified = Boolean(serverReconciliation && serverReconciliation.isValid);

  return (
    <div className="rounded-xl bg-slate-900/90 border border-slate-800 p-4 space-y-3">
      <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
        <h4 className="text-sm font-semibold text-slate-100">Order Financial Summary</h4>
        {isReconciling ? (
          <span className="flex items-center gap-1 text-[11px] text-purple-400">
            <RefreshCw className="w-3 h-3 animate-spin" /> Verifying Server Prices...
          </span>
        ) : isServerVerified ? (
          <Badge variant="success" className="gap-1 text-[10px]">
            <ShieldCheck className="w-3 h-3" /> Server Reconciled
          </Badge>
        ) : (
          <Badge variant="warning" className="gap-1 text-[10px]">
            <ShieldAlert className="w-3 h-3" /> Preliminary
          </Badge>
        )}
      </div>

      <div className="space-y-2 text-xs text-slate-300">
        <div className="flex justify-between items-center">
          <span className="text-slate-400">Items Subtotal ({cartSummary.itemCount} items)</span>
          <span className="font-medium text-slate-200">
            ${(serverReconciliation?.verifiedSubtotal ?? cartSummary.subtotal).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            })}
          </span>
        </div>

        <div className="flex justify-between items-center">
          <div className="flex items-center gap-1 text-slate-400">
            <span>Estimated Sales Tax</span>
            <span className="text-[10px] text-slate-500">(8.25% B2B)</span>
          </div>
          <span className="font-medium text-slate-200">
            ${(serverReconciliation?.verifiedTax ?? cartSummary.estimatedTax).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            })}
          </span>
        </div>

        <div className="flex justify-between items-center">
          <div className="flex items-center gap-1 text-slate-400">
            <span>Commercial Ground Shipping</span>
            {cartSummary.subtotal >= 1000 && (
              <span className="text-[10px] text-emerald-400 font-medium">Free (&gt;$1k)</span>
            )}
          </div>
          <span className="font-medium text-slate-200">
            {(serverReconciliation?.verifiedShipping ?? cartSummary.shipping) === 0
              ? 'FREE'
              : `$${(serverReconciliation?.verifiedShipping ?? cartSummary.shipping).toFixed(2)}`}
          </span>
        </div>

        <div className="pt-2 border-t border-slate-800/90 flex justify-between items-center">
          <div>
            <span className="text-sm font-bold text-white block">Total Payable</span>
            <span className="text-[10px] text-slate-400">USD Authorized Fixed Currency</span>
          </div>
          <span className="text-lg font-extrabold text-purple-400 tracking-tight">
            ${(serverReconciliation?.verifiedTotal ?? cartSummary.total).toLocaleString(undefined, {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            })}
          </span>
        </div>
      </div>

      {serverReconciliation && serverReconciliation.discrepancies.length > 0 && (
        <div className="p-2.5 rounded-lg bg-rose-950/40 border border-rose-800/50 text-xs text-rose-300 space-y-1">
          <span className="font-semibold block flex items-center gap-1">
            <ShieldAlert className="w-3.5 h-3.5" /> Pricing Reconciliation Discrepancies:
          </span>
          <ul className="list-disc list-inside space-y-0.5 text-[11px] text-rose-300/90">
            {serverReconciliation.discrepancies.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
