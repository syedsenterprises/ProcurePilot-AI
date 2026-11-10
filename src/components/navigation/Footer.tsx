import React from 'react';
import Link from 'next/link';
import { Compass, ShieldCheck, Lock } from 'lucide-react';

export function Footer() {
  return (
    <footer className="border-t border-slate-800/80 bg-slate-950 text-slate-400 text-xs">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 mb-8">
          {/* Brand Col */}
          <div className="space-y-3 md:col-span-1">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-purple-600 to-indigo-700 flex items-center justify-center text-white">
                <Compass className="w-4 h-4" />
              </div>
              <span className="font-bold text-sm text-white">ProcurePilot AI</span>
            </div>
            <p className="text-slate-400 text-[11px] leading-relaxed">
              Autonomous AI-powered procurement and agentic commerce platform for high-velocity teams,
              freelancers, and startups.
            </p>
            <div className="flex items-center gap-2 text-[10px] text-emerald-400 font-medium">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Human-in-the-Loop Governance Standard</span>
            </div>
          </div>

          {/* Workflow Architecture */}
          <div className="space-y-2.5">
            <h4 className="font-semibold text-slate-200 text-xs uppercase tracking-wider">
              Procurement Pipeline
            </h4>
            <ul className="space-y-1.5 text-[11px]">
              <li>1. Natural-Language RFQ</li>
              <li>2. Catalog Heuristic & LLM Parsing</li>
              <li>3. Multi-Tier Specification Matrix</li>
              <li>4. Server-Side Budget Reconciliation</li>
              <li>5. Mandatory Human Approval Signoff</li>
              <li>6. PayPal Sandbox Orders v2 Gateway</li>
            </ul>
          </div>

          {/* Security & Integrity */}
          <div className="space-y-2.5">
            <h4 className="font-semibold text-slate-200 text-xs uppercase tracking-wider">
              Security Safeguards
            </h4>
            <ul className="space-y-1.5 text-[11px]">
              <li className="flex items-center gap-1.5">
                <Lock className="w-3 h-3 text-purple-400" />
                <span>Zero client-submitted pricing trust</span>
              </li>
              <li className="flex items-center gap-1.5">
                <Lock className="w-3 h-3 text-purple-400" />
                <span>No automated unapproved execution</span>
              </li>
              <li className="flex items-center gap-1.5">
                <Lock className="w-3 h-3 text-purple-400" />
                <span>Strict server-side payment operations</span>
              </li>
              <li className="flex items-center gap-1.5">
                <Lock className="w-3 h-3 text-purple-400" />
                <span>Dual-mode AI fallback transparency</span>
              </li>
            </ul>
          </div>

          {/* Governance & Open Source */}
          <div className="space-y-2.5">
            <h4 className="font-semibold text-slate-200 text-xs uppercase tracking-wider">
              Project & Governance
            </h4>
            <ul className="space-y-1.5 text-[11px]">
              <li>
                <span className="text-slate-300 font-medium">Stage 1 Foundation:</span> Architecture &
                Core Workflows
              </li>
              <li>
                <span className="text-slate-300 font-medium">License:</span> MIT Open Source
              </li>
              <li>
                <span className="text-slate-300 font-medium">Next Stage:</span> Live Webhook & Dynamic
                Supplier Ingestion
              </li>
              <li className="pt-1">
                <span className="text-slate-500">Built with Next.js App Router, TypeScript & Tailwind CSS</span>
              </li>
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-slate-900 flex flex-col sm:flex-row justify-between items-center gap-4 text-[11px] text-slate-500">
          <div>
            © 2026 ProcurePilot AI. All rights reserved. Open-source under MIT License.
          </div>
          <div className="flex items-center gap-4">
            <Link href="/dashboard" className="hover:text-purple-400 transition-colors">
              Application Dashboard
            </Link>
            <span>•</span>
            <span className="text-slate-400 font-mono">v0.1.0-stage-1</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
