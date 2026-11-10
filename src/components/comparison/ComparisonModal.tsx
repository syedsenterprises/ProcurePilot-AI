'use client';

import React from 'react';
import { useCart } from '@/context/CartContext';
import { ComparisonTable } from './ComparisonTable';
import { X, ArrowLeftRight, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';

export function ComparisonModal() {
  const { isCompareOpen, setIsCompareOpen, compareList, clearCompare } = useCart();

  if (!isCompareOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fadeIn">
      <div
        className="relative w-full max-w-6xl max-h-[92vh] flex flex-col rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl shadow-black overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 px-6 bg-slate-900/90 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-purple-950/80 border border-purple-800/60 text-purple-400">
              <ArrowLeftRight className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">Multi-Product Architectural Matrix</h3>
              <p className="text-xs text-slate-400">
                Comparing {compareList.length} candidate specifications side-by-side
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {compareList.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearCompare}
                className="gap-1.5 text-xs text-slate-400 hover:text-rose-300"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear All</span>
              </Button>
            )}
            <button
              onClick={() => setIsCompareOpen(false)}
              className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        <div className="p-6 overflow-y-auto flex-1">
          <ComparisonTable products={compareList} />
        </div>
      </div>
    </div>
  );
}
