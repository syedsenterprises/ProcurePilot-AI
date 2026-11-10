'use client';

import React, { useState } from 'react';
import { ProcurementReasoningStep } from '@/types/procurement';
import { CheckCircle2, ChevronDown, ChevronUp, Cpu, Database, Search, Sparkles } from 'lucide-react';

interface AgentThoughtFeedProps {
  steps: ProcurementReasoningStep[];
  provider: 'gemini-api' | 'procurepilot-heuristic-engine';
}

export function AgentThoughtFeed({ steps, provider }: AgentThoughtFeedProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (!steps || steps.length === 0) return null;

  const getPhaseIcon = (phase: ProcurementReasoningStep['phase']) => {
    switch (phase) {
      case 'parsing':
        return <Search className="w-3.5 h-3.5 text-blue-400" />;
      case 'retrieval':
        return <Database className="w-3.5 h-3.5 text-indigo-400" />;
      case 'constraint_solving':
        return <Cpu className="w-3.5 h-3.5 text-amber-400" />;
      case 'synthesis':
      default:
        return <Sparkles className="w-3.5 h-3.5 text-purple-400" />;
    }
  };

  return (
    <div className="rounded-xl bg-slate-950/80 border border-slate-800/80 text-xs text-slate-300 overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 bg-slate-900/60 hover:bg-slate-900/90 text-left transition-colors"
      >
        <div className="flex items-center gap-2">
          <div className="p-1 rounded bg-purple-950 border border-purple-800 text-purple-400">
            <Cpu className="w-3.5 h-3.5" />
          </div>
          <span className="font-semibold text-slate-200">
            Agent Reasoning & Verification Trace ({steps.length} Steps)
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono">
            {provider === 'gemini-api' ? 'Gemini 2.0 Flash' : 'Heuristic Engine'}
          </span>
        </div>

        <div className="flex items-center gap-1.5 text-slate-500">
          <span className="text-[11px]">{isExpanded ? 'Hide' : 'Inspect'}</span>
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </button>

      {isExpanded && (
        <div className="p-3.5 space-y-2.5 border-t border-slate-800/60 divide-y divide-slate-800/40">
          {steps.map((step) => (
            <div key={step.step} className="pt-2 first:pt-0 flex items-start gap-2.5">
              <div className="mt-0.5">{getPhaseIcon(step.phase)}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-200 text-xs">{step.title}</span>
                  <div className="flex items-center gap-1 text-[10px] text-emerald-400 font-medium">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>Verified</span>
                  </div>
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">{step.detail}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
