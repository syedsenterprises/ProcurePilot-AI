'use client';

import React from 'react';
import { Sparkles, Laptop, Armchair, Video, Network } from 'lucide-react';

interface PromptPresetsProps {
  onSelectPrompt: (prompt: string, budget?: number) => void;
}

export function PromptPresets({ onSelectPrompt }: PromptPresetsProps) {
  const presets = [
    {
      icon: Laptop,
      label: 'Software Engineer Station',
      budget: 5500,
      query: 'Equip a senior full-stack developer with a high-spec MacBook Pro, a 6K monitor, and an ergonomic Herman Miller chair under $6,000.'
    },
    {
      icon: Armchair,
      label: 'Ergonomic Workspace Revamp',
      budget: 2000,
      query: 'I need an ergonomic standing desk and an active lumbar chair to reduce back fatigue under $2,000.'
    },
    {
      icon: Video,
      label: 'Executive Video & Podcast Studio',
      budget: 2500,
      query: 'Set up an executive client presentation and podcast suite with a broadcast mic, Studio Display, and noise-cancelling headphones.'
    },
    {
      icon: Network,
      label: 'Startup Office Infrastructure',
      budget: 1500,
      query: 'Recommend enterprise 10G networking and workstation docking for 3 laptops under $1,500.'
    }
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-slate-400">
        <Sparkles className="w-3.5 h-3.5 text-purple-400" />
        <span>Quick Procurement Scenario Presets:</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
        {presets.map((preset, idx) => {
          const Icon = preset.icon;
          return (
            <button
              key={idx}
              onClick={() => onSelectPrompt(preset.query, preset.budget)}
              className="group flex flex-col text-left p-3 rounded-xl bg-slate-900/60 hover:bg-slate-800/80 border border-slate-800 hover:border-purple-500/50 transition-all text-xs space-y-1.5"
            >
              <div className="flex items-center justify-between w-full">
                <span className="p-1.5 rounded-lg bg-slate-800 group-hover:bg-purple-950 text-slate-300 group-hover:text-purple-300 border border-slate-700/60 transition-colors">
                  <Icon className="w-3.5 h-3.5" />
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-950 text-slate-400 border border-slate-800">
                  ${preset.budget.toLocaleString()} Cap
                </span>
              </div>
              <h5 className="font-semibold text-slate-200 group-hover:text-white transition-colors">
                {preset.label}
              </h5>
              <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                {preset.query}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
