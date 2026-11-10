'use client';

import React, { useState } from 'react';
import { useCart } from '@/context/CartContext';
import { Wallet, AlertTriangle, CheckCircle2, ShieldCheck, Edit3, Check } from 'lucide-react';
import { Badge } from '../ui/Badge';

export function BudgetTracker({ compact = false }: { compact?: boolean }) {
  const { budget, setBudget, budgetStatus, cartSummary } = useCart();
  const [isEditing, setIsEditing] = useState(false);
  const [tempBudget, setTempBudget] = useState(budget ? budget.toString() : '4500');

  const handleSaveBudget = (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(tempBudget);
    if (!isNaN(val) && val >= 0) {
      setBudget(val);
    }
    setIsEditing(false);
  };

  const getStatusColor = () => {
    if (budgetStatus.isOverBudget) return 'bg-rose-500';
    if (budgetStatus.status === 'warning') return 'bg-amber-400';
    return 'bg-emerald-400';
  };

  if (compact) {
    return (
      <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-800 text-xs text-slate-300">
        <Wallet className="w-3.5 h-3.5 text-indigo-400" />
        <div className="flex items-center gap-2">
          <span>Budget:</span>
          <span className="font-semibold text-slate-100">${(budget ?? 0).toLocaleString()}</span>
          <span className="text-slate-600">|</span>
          <span>Used:</span>
          <span
            className={`font-semibold ${
              budgetStatus.isOverBudget ? 'text-rose-400' : 'text-slate-200'
            }`}
          >
            ${cartSummary.total.toLocaleString()}
          </span>
        </div>
        <div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden ml-1">
          <div
            className={`h-full ${getStatusColor()} transition-all duration-300`}
            style={{ width: `${Math.min(budgetStatus.percentage, 100)}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800/80 shadow-sm backdrop-blur-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-indigo-950/70 border border-indigo-800/50 text-indigo-400">
            <Wallet className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-100">Fiscal Budget Allocation</h3>
            <p className="text-xs text-slate-400">Strict server-side validation enforced</p>
          </div>
        </div>

        <div>
          {budgetStatus.isOverBudget ? (
            <Badge variant="danger" className="gap-1">
              <AlertTriangle className="w-3 h-3" /> Over Budget
            </Badge>
          ) : budgetStatus.status === 'warning' ? (
            <Badge variant="warning" className="gap-1">
              <AlertTriangle className="w-3 h-3" /> Approaching Cap
            </Badge>
          ) : (
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="w-3 h-3" /> Under Budget
            </Badge>
          )}
        </div>
      </div>

      {/* Figures Display */}
      <div className="grid grid-cols-3 gap-2 py-3 px-3.5 rounded-lg bg-slate-950/60 border border-slate-800/60 mb-3">
        <div>
          <span className="text-[11px] font-medium text-slate-400 block">Total Budget</span>
          {isEditing ? (
            <form onSubmit={handleSaveBudget} className="flex items-center gap-1 mt-0.5">
              <input
                type="number"
                min="0"
                step="100"
                value={tempBudget}
                onChange={(e) => setTempBudget(e.target.value)}
                className="w-20 px-1.5 py-0.5 text-xs rounded bg-slate-900 border border-purple-500/80 text-white focus:outline-none"
                autoFocus
              />
              <button
                type="submit"
                className="p-1 rounded bg-purple-600 hover:bg-purple-500 text-white"
                title="Save Budget"
              >
                <Check className="w-3 h-3" />
              </button>
            </form>
          ) : (
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-sm font-bold text-white tracking-tight">
                ${(budget ?? 0).toLocaleString()}
              </span>
              <button
                onClick={() => {
                  setTempBudget((budget ?? 0).toString());
                  setIsEditing(true);
                }}
                className="text-slate-500 hover:text-slate-300 transition-colors"
                title="Edit Budget Limit"
              >
                <Edit3 className="w-3 h-3" />
              </button>
            </div>
          )}
        </div>

        <div>
          <span className="text-[11px] font-medium text-slate-400 block">Cart Total</span>
          <span
            className={`text-sm font-bold tracking-tight block mt-0.5 ${
              budgetStatus.isOverBudget ? 'text-rose-400' : 'text-slate-200'
            }`}
          >
            ${cartSummary.total.toLocaleString()}
          </span>
        </div>

        <div>
          <span className="text-[11px] font-medium text-slate-400 block">
            {budgetStatus.isOverBudget ? 'Deficit' : 'Remaining'}
          </span>
          <span
            className={`text-sm font-bold tracking-tight block mt-0.5 ${
              budgetStatus.isOverBudget ? 'text-rose-400' : 'text-emerald-400'
            }`}
          >
            ${Math.abs(budgetStatus.remaining).toLocaleString()}
          </span>
        </div>
      </div>

      {/* Progress Bar */}
      <div>
        <div className="flex justify-between items-center text-xs text-slate-400 mb-1.5">
          <span>Spend Utilization</span>
          <span className="font-semibold text-slate-300">{budgetStatus.percentage}%</span>
        </div>
        <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
          <div
            className={`h-full ${getStatusColor()} transition-all duration-300 rounded-full`}
            style={{ width: `${Math.min(budgetStatus.percentage, 100)}%` }}
          />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-400">
        <ShieldCheck className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
        <span>Checkout is automatically locked if items exceed the authorized budget.</span>
      </div>
    </div>
  );
}
