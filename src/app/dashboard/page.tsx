'use client';

import React, { useState, Suspense } from 'react';
import { Navbar } from '@/components/navigation/Navbar';
import { Footer } from '@/components/navigation/Footer';
import { ProcurementChat } from '@/components/procurement/ProcurementChat';
import { ProductCatalog } from '@/components/catalog/ProductCatalog';
import { ProductDetailModal } from '@/components/catalog/ProductDetailModal';
import { ComparisonModal } from '@/components/comparison/ComparisonModal';
import { CartDrawer } from '@/components/cart/CartDrawer';
import { BudgetTracker } from '@/components/budget/BudgetTracker';
import { PurchaseSummary } from '@/components/budget/PurchaseSummary';
import { CheckoutReturnHandler } from '@/components/checkout/CheckoutReturnHandler';
import { SAMPLE_PRODUCTS } from '@/services/catalog/products.data';
import { useCart } from '@/context/CartContext';
import {
  Sparkles,
  LayoutDashboard,
  ShieldCheck,
  ShoppingBag,
  ArrowRight
} from 'lucide-react';
import { Button } from '@/components/ui/Button';

export default function DashboardPage() {
  const [activeTab, setActiveTab] = useState<'procure' | 'catalog'>('procure');
  const { cart, setIsCartOpen } = useCart();

  // Aggregate category counts
  const categoryCounts: Record<string, number> = { All: SAMPLE_PRODUCTS.length };
  for (const p of SAMPLE_PRODUCTS) {
    categoryCounts[p.category] = (categoryCounts[p.category] || 0) + 1;
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100 selection:bg-purple-600 selection:text-white">
      {/* Top Application Navbar */}
      <Navbar currentTab={activeTab} onSelectTab={setActiveTab} />

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Checkout Lifecycle & Return Handler */}
        <Suspense fallback={null}>
          <CheckoutReturnHandler />
        </Suspense>

        {/* Top Header Banner */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-white">
                Procurement Operations Dashboard
              </h1>
              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-950 text-indigo-300 border border-indigo-800/60 font-mono">
                Production-Ready Architecture
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Autonomous requirement decomposition, authoritative catalog reconciliation, and
              human-authorized PayPal checkout.
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={() => setActiveTab('procure')}
              className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all ${
                activeTab === 'procure'
                  ? 'bg-purple-600 text-white shadow-md shadow-purple-950 border border-purple-500/50'
                  : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-800'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>AI Procurement Copilot</span>
            </button>

            <button
              onClick={() => setActiveTab('catalog')}
              className={`px-4 py-2 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all ${
                activeTab === 'catalog'
                  ? 'bg-purple-600 text-white shadow-md shadow-purple-950 border border-purple-500/50'
                  : 'bg-slate-900 text-slate-300 hover:bg-slate-800 border border-slate-800'
              }`}
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
              <span>Product Catalogue ({SAMPLE_PRODUCTS.length})</span>
            </button>
          </div>
        </div>

        {/* Tab Content */}
        {activeTab === 'procure' ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left 8 cols: Interactive AI Procurement Agent */}
            <div className="lg:col-span-8">
              <ProcurementChat />
            </div>

            {/* Right 4 cols: Side widgets (Fiscal budget, Cart snapshot, Governance trust mark) */}
            <div className="lg:col-span-4 space-y-6">
              {/* Fiscal Budget Tracker Widget */}
              <BudgetTracker />

              {/* Mini Cart / Live Order Widget */}
              <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800/80 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <ShoppingBag className="w-4 h-4 text-purple-400" />
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-200">
                      Active Cart Queue
                    </h3>
                  </div>
                  <span className="text-xs text-slate-400 font-mono">{cart.length} items</span>
                </div>

                {cart.length > 0 ? (
                  <div className="space-y-3">
                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                      {cart.map((item) => (
                        <div
                          key={item.product.id}
                          className="flex items-center justify-between text-xs p-2 rounded-lg bg-slate-950/60 border border-slate-800/60"
                        >
                          <div className="truncate max-w-[65%]">
                            <span className="font-medium text-slate-200 block truncate">
                              {item.product.name}
                            </span>
                            <span className="text-[10px] text-slate-500">Qty: {item.quantity}</span>
                          </div>
                          <span className="font-mono text-purple-300 font-semibold">
                            ${(item.product.price * item.quantity).toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>

                    <Button
                      variant="primary"
                      size="sm"
                      className="w-full gap-2 text-xs"
                      onClick={() => setIsCartOpen(true)}
                    >
                      <span>Review & Authorize Checkout</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-slate-500 py-3 text-center">
                    No items in queue yet. Request a recommendation above or browse the catalogue.
                  </p>
                )}
              </div>

              {/* Purchase Summary */}
              {cart.length > 0 && <PurchaseSummary />}

              {/* Security Guardrail Card */}
              <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800/70 text-xs text-slate-400 space-y-2">
                <div className="flex items-center gap-1.5 font-semibold text-slate-300">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>Enterprise Security Commitments</span>
                </div>
                <p className="text-[11px] leading-relaxed">
                  Every proposal is recalculated against server-side prices. No client payload prices
                  are trusted. Human approval is strictly enforced prior to PayPal authorization.
                </p>
              </div>
            </div>
          </div>
        ) : (
          /* Full Product Catalogue Tab */
          <div className="space-y-6">
            <ProductCatalog
              initialProducts={SAMPLE_PRODUCTS}
              categoryCounts={categoryCounts}
            />
          </div>
        )}
      </main>

      {/* Global Modals & Slide-over Drawers */}
      <ProductDetailModal />
      <ComparisonModal />
      <CartDrawer />

      <Footer />
    </div>
  );
}
