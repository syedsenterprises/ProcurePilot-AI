'use client';

import React from 'react';
import Link from 'next/link';
import { Navbar } from '@/components/navigation/Navbar';
import { Footer } from '@/components/navigation/Footer';
import { ProductCard } from '@/components/catalog/ProductCard';
import { ProductDetailModal } from '@/components/catalog/ProductDetailModal';
import { ComparisonModal } from '@/components/comparison/ComparisonModal';
import { CartDrawer } from '@/components/cart/CartDrawer';
import { SAMPLE_PRODUCTS } from '@/services/catalog/products.data';
import {
  Sparkles,
  ArrowRight,
  ShieldCheck,
  Lock,
  Layers,
  CreditCard,
  Bot
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';

export default function LandingPage() {
  const featuredProducts = SAMPLE_PRODUCTS.slice(0, 4);

  return (
    <div className="min-h-screen flex flex-col bg-slate-950 text-slate-100 selection:bg-purple-600 selection:text-white">
      {/* Navbar */}
      <Navbar />

      <main className="flex-1 space-y-24 pb-20">
        {/* HERO SECTION */}
        <section className="relative pt-20 pb-16 px-4 sm:px-6 lg:px-8 max-w-7xl mx-auto text-center space-y-8">
          {/* Subtle Ambient Glow */}
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[300px] bg-purple-900/15 blur-[120px] rounded-full pointer-events-none" />

          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-slate-900/90 border border-purple-500/30 text-xs text-purple-300 shadow-sm backdrop-blur">
            <Sparkles className="w-3.5 h-3.5 text-purple-400" />
            <span className="font-semibold text-white">Stage 1 Foundation:</span>
            <span>Agentic Commerce & Guardrailed Procurement</span>
          </div>

          {/* Headline */}
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-white tracking-tight max-w-4xl mx-auto leading-[1.15]">
            AI-Powered Equipment Procurement for{' '}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-400 via-indigo-300 to-purple-200">
              High-Velocity Teams
            </span>
          </h1>

          {/* Subheading */}
          <p className="text-base sm:text-lg text-slate-400 max-w-2xl mx-auto leading-relaxed">
            Describe your team&apos;s hardware requirements in plain English, define your fiscal budget,
            and let our dual-mode AI discover, reconcile, and present enterprise packages ready for
            explicit human authorization and PayPal checkout.
          </p>

          {/* Action CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 pt-4">
            <Link href="/dashboard">
              <Button size="lg" variant="primary" className="w-full sm:w-auto gap-2 shadow-xl shadow-purple-950/60">
                <Sparkles className="w-4 h-4" />
                <span>Launch Procurement Copilot</span>
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>

            <Link href="/dashboard">
              <Button size="lg" variant="outline" className="w-full sm:w-auto gap-2">
                <Layers className="w-4 h-4" />
                <span>Browse Verified Catalogue</span>
              </Button>
            </Link>
          </div>

          {/* Trust Guarantees Bar */}
          <div className="pt-10 max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-4 gap-4 text-xs text-slate-400">
            <div className="flex items-center justify-center gap-2 p-3 rounded-xl bg-slate-900/60 border border-slate-800/80">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span className="font-medium text-slate-300">100% Server Reconciled</span>
            </div>
            <div className="flex items-center justify-center gap-2 p-3 rounded-xl bg-slate-900/60 border border-slate-800/80">
              <Lock className="w-4 h-4 text-purple-400" />
              <span className="font-medium text-slate-300">Mandatory Human Signoff</span>
            </div>
            <div className="flex items-center justify-center gap-2 p-3 rounded-xl bg-slate-900/60 border border-slate-800/80">
              <CreditCard className="w-4 h-4 text-indigo-400" />
              <span className="font-medium text-slate-300">PayPal Sandbox Ready</span>
            </div>
            <div className="flex items-center justify-center gap-2 p-3 rounded-xl bg-slate-900/60 border border-slate-800/80">
              <Bot className="w-4 h-4 text-blue-400" />
              <span className="font-medium text-slate-300">Gemini 2.0 Architecture</span>
            </div>
          </div>
        </section>

        {/* WORKFLOW PIPELINE ARCHITECTURE */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-8">
          <div className="text-center space-y-2 max-w-2xl mx-auto">
            <span className="text-xs font-semibold uppercase tracking-wider text-purple-400">
              End-to-End Workflow Architecture
            </span>
            <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
              From Natural Language to Approved Purchase Order
            </h2>
            <p className="text-xs sm:text-sm text-slate-400">
              Built on zero-trust commercial principles where AI aids discovery and synthesis, but
              never bypasses financial governance.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-3">
              <div className="w-8 h-8 rounded-lg bg-purple-950 border border-purple-800 flex items-center justify-center font-mono font-bold text-purple-400 text-xs">
                01
              </div>
              <h3 className="font-semibold text-white text-sm">Natural Language RFQ</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Describe desired setups (e.g. &ldquo;2 developer workstations with 32GB RAM under
                $7,000&rdquo;) directly in the chat copilot.
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-3">
              <div className="w-8 h-8 rounded-lg bg-indigo-950 border border-indigo-800 flex items-center justify-center font-mono font-bold text-indigo-400 text-xs">
                02
              </div>
              <h3 className="font-semibold text-white text-sm">Reasoning & Match</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Dual-mode engine scans verified hardware specifications, balances trade-offs, and
                validates stock availability.
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-3">
              <div className="w-8 h-8 rounded-lg bg-emerald-950 border border-emerald-800 flex items-center justify-center font-mono font-bold text-emerald-400 text-xs">
                03
              </div>
              <h3 className="font-semibold text-white text-sm">Budget Guardrails</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Server-side pricing recalculation ensures client modifications cannot alter prices or
                bypass authorized department budgets.
              </p>
            </div>

            <div className="p-5 rounded-2xl bg-slate-900/80 border border-slate-800 space-y-3">
              <div className="w-8 h-8 rounded-lg bg-amber-950 border border-amber-800 flex items-center justify-center font-mono font-bold text-amber-400 text-xs">
                04
              </div>
              <h3 className="font-semibold text-white text-sm">Human Approval</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Explicit authorized officer signoff is required before creating a PayPal Sandbox Order
                or capturing payment.
              </p>
            </div>
          </div>
        </section>

        {/* FEATURED VERIFIED CATALOGUE */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wider text-purple-400">
                Curated B2B Catalogue
              </span>
              <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mt-1">
                Enterprise Benchmarks in Computing & Ergonomics
              </h2>
            </div>

            <Link href="/dashboard">
              <Button variant="outline" size="sm" className="gap-2">
                <span>View All 14 Hardware Products</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </Button>
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
            {featuredProducts.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        </section>

        {/* SECURITY & GOVERNANCE ARCHITECTURE MATRIX */}
        <section className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="p-8 sm:p-10 rounded-3xl bg-slate-900/90 border border-slate-800/90 space-y-6">
            <div className="max-w-2xl space-y-2">
              <Badge variant="navy">Commercial Safety By Design</Badge>
              <h3 className="text-2xl font-bold text-white tracking-tight">
                Why Unchecked AI Agents Cannot Be Allowed in Procurement
              </h3>
              <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
                ProcurePilot AI bridges the agility of generative models with the rigorous compliance,
                audit trails, and security standards expected by CFOs and finance leaders.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-2">
              <div className="p-5 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-2">
                <h4 className="font-semibold text-white text-sm flex items-center gap-2">
                  <Lock className="w-4 h-4 text-purple-400" />
                  <span>Authoritative Pricing Service</span>
                </h4>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Prices are locked in the server catalogue. Any client payload price manipulation is
                  immediately rejected with an audit alert.
                </p>
              </div>

              <div className="p-5 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-2">
                <h4 className="font-semibold text-white text-sm flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>Human Authorization Gate</span>
                </h4>
                <p className="text-xs text-slate-400 leading-relaxed">
                  No purchase or order creation is executed automatically. An authorized procurement
                  approver must sign off on the exact requisition.
                </p>
              </div>

              <div className="p-5 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-2">
                <h4 className="font-semibold text-white text-sm flex items-center gap-2">
                  <CreditCard className="w-4 h-4 text-indigo-400" />
                  <span>Server-Side Payment Tokenization</span>
                </h4>
                <p className="text-xs text-slate-400 leading-relaxed">
                  PayPal credentials, secret tokens, and order creation calls remain strictly in backend
                  Next.js App Router API routes.
                </p>
              </div>
            </div>

            <div className="pt-4 flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-slate-800/80 text-xs text-slate-400">
              <span>Ready to start optimizing your team&apos;s purchasing lifecycle?</span>
              <Link href="/dashboard">
                <Button variant="primary" size="md" className="gap-2">
                  <span>Enter Application Dashboard</span>
                  <ArrowRight className="w-4 h-4" />
                </Button>
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* Global Modals & Drawers */}
      <ProductDetailModal />
      <ComparisonModal />
      <CartDrawer />

      {/* Footer */}
      <Footer />
    </div>
  );
}
