'use client';

import React from 'react';
import Link from 'next/link';
import { useCart } from '@/context/CartContext';
import { BudgetTracker } from '../budget/BudgetTracker';
import {
  Compass,
  ShoppingBag,
  ArrowLeftRight,
  Sparkles,
  LayoutDashboard
} from 'lucide-react';
import { Button } from '../ui/Button';

interface NavbarProps {
  currentTab?: 'procure' | 'catalog';
  onSelectTab?: (tab: 'procure' | 'catalog') => void;
}

export function Navbar({ currentTab, onSelectTab }: NavbarProps) {
  const { cartSummary, setIsCartOpen, compareList, setIsCompareOpen } = useCart();

  return (
    <header className="sticky top-0 z-40 w-full border-b border-slate-800/80 bg-slate-950/80 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
        {/* Brand Logo */}
        <Link href="/" className="flex items-center gap-3 group">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-purple-600 to-indigo-700 flex items-center justify-center shadow-md shadow-purple-950/60 border border-purple-500/40 group-hover:scale-105 transition-transform">
            <Compass className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-base text-white tracking-tight">ProcurePilot</span>
              <span className="text-xs px-1.5 py-0.2 font-mono font-semibold text-purple-400 bg-purple-950/80 border border-purple-800/60 rounded">
                AI
              </span>
            </div>
            <span className="text-[10px] text-slate-400 hidden sm:block">Agentic B2B Commerce</span>
          </div>
        </Link>

        {/* Navigation Switcher (when on dashboard) */}
        {onSelectTab && (
          <nav className="hidden md:flex items-center gap-1 p-1 rounded-xl bg-slate-900 border border-slate-800 text-xs">
            <button
              onClick={() => onSelectTab('procure')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                currentTab === 'procure'
                  ? 'bg-purple-600 text-white shadow-sm shadow-purple-950'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>AI Procurement</span>
            </button>

            <button
              onClick={() => onSelectTab('catalog')}
              className={`px-3 py-1.5 rounded-lg font-medium transition-all flex items-center gap-1.5 ${
                currentTab === 'catalog'
                  ? 'bg-purple-600 text-white shadow-sm shadow-purple-950'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
              <span>Verified Catalogue</span>
            </button>
          </nav>
        )}

        {/* Right Side Tools */}
        <div className="flex items-center gap-3">
          {/* Compact Budget Pill */}
          <div className="hidden lg:block">
            <BudgetTracker compact />
          </div>

          {/* Compare Button */}
          {compareList.length > 0 && (
            <button
              onClick={() => setIsCompareOpen(true)}
              className="relative p-2 rounded-xl bg-slate-900 border border-purple-500/50 text-purple-300 hover:bg-slate-800 transition-colors"
              title="Open Product Comparison"
            >
              <ArrowLeftRight className="w-4 h-4" />
              <span className="absolute -top-1.5 -right-1.5 h-4 w-4 rounded-full bg-purple-600 text-[10px] font-bold text-white flex items-center justify-center">
                {compareList.length}
              </span>
            </button>
          )}

          {/* Cart Trigger */}
          <button
            onClick={() => setIsCartOpen(true)}
            className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 text-xs text-slate-200 transition-colors"
          >
            <div className="relative">
              <ShoppingBag className="w-4 h-4 text-purple-400" />
              {cartSummary.itemCount > 0 && (
                <span className="absolute -top-2 -right-2 h-4 w-4 rounded-full bg-purple-600 text-[10px] font-bold text-white flex items-center justify-center">
                  {cartSummary.itemCount}
                </span>
              )}
            </div>
            <span className="hidden sm:inline font-semibold">
              ${cartSummary.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </button>

          {/* App / Dashboard Link */}
          {!onSelectTab && (
            <Link href="/dashboard">
              <Button size="sm" variant="primary" className="gap-1.5">
                <span>Launch App</span>
              </Button>
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
