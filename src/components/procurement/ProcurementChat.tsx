'use client';

import React, { useState, useEffect, useRef } from 'react';
import Image from 'next/image';
import { useCart } from '@/context/CartContext';
import { ProcurementMessage, ProcurementResponse } from '@/types/procurement';
import { PromptPresets } from './PromptPresets';
import { AgentThoughtFeed } from './AgentThoughtFeed';
import { SAMPLE_PRODUCTS } from '@/services/catalog/products.data';
import { loadChatSession, saveChatSession, clearChatSession } from '@/lib/storage/client-session';
import {
  Sparkles,
  Send,
  Bot,
  User,
  ShoppingCart,
  Check,
  DollarSign,
  Layers,
  ArrowRight,
  RotateCcw
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';

const DEFAULT_WELCOME_MESSAGE: ProcurementMessage = {
  id: 'welcome-msg',
  role: 'assistant',
  content:
    'Welcome to ProcurePilot AI. Describe what hardware or equipment your team needs, specify budget guidelines, and I will analyze our verified enterprise catalog to generate an optimized procurement proposal.',
  timestamp: 'Just now',
  provider: 'procurepilot-heuristic-engine'
};

export function ProcurementChat() {
  const { addToCart, cart, setBudget, budget, setIsCartOpen, setSelectedProductDetail } = useCart();

  const [inputQuery, setInputQuery] = useState('');
  const [inputBudget, setInputBudget] = useState<string>(budget ? budget.toString() : '');
  const [isLoading, setIsLoading] = useState(false);
  const [messages, setMessages] = useState<ProcurementMessage[]>([DEFAULT_WELCOME_MESSAGE]);
  const [isChatHydrated, setIsChatHydrated] = useState(false);
  const hasLoadedChatRef = useRef(false);

  // Sync inputBudget when budget from CartContext hydrates or changes
  useEffect(() => {
    if (budget !== null && budget !== undefined) {
      setInputBudget(budget.toString());
    }
  }, [budget]);

  // Safe client hydration for chat messages on mount
  useEffect(() => {
    if (hasLoadedChatRef.current) return;
    hasLoadedChatRef.current = true;

    try {
      const saved = loadChatSession();
      if (saved && saved.messages && saved.messages.length > 0) {
        // Enrich recommendations with authoritative catalogue products
        const enriched = saved.messages.map((msg) => {
          if (!msg.recommendations) return msg;
          return {
            ...msg,
            recommendations: msg.recommendations.map((rec) => {
              const authoritative = SAMPLE_PRODUCTS.find((p) => p.id === rec.product.id);
              return {
                ...rec,
                product: authoritative || rec.product
              };
            })
          };
        });
        setMessages(enriched);
      }
    } catch (err) {
      console.warn('Failed to hydrate chat session:', err);
    } finally {
      setIsChatHydrated(true);
    }
  }, []);

  // Persist messages strictly after hydration
  useEffect(() => {
    if (!isChatHydrated) return;
    saveChatSession({ messages });
  }, [messages, isChatHydrated]);

  const handleResetSession = () => {
    clearChatSession();
    setMessages([DEFAULT_WELCOME_MESSAGE]);
    setInputQuery('');
  };

  const handleSubmit = async (queryText?: string, budgetOverride?: number) => {
    const textToSubmit = queryText || inputQuery;
    if (!textToSubmit || textToSubmit.trim().length === 0) return;

    const parsedBudget =
      budgetOverride !== undefined
        ? budgetOverride
        : inputBudget
        ? parseFloat(inputBudget)
        : undefined;

    // Update global budget if provided
    if (parsedBudget && !isNaN(parsedBudget) && parsedBudget > 0) {
      setBudget(parsedBudget);
    }

    const userMsg: ProcurementMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: textToSubmit.trim(),
      budgetConstraint: parsedBudget,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      provider: 'procurepilot-heuristic-engine'
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputQuery('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/procure', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: textToSubmit.trim(),
          budgetLimit: parsedBudget
        })
      });

      if (!response.ok) {
        throw new Error(`Procurement engine responded with HTTP ${response.status}`);
      }

      const data: ProcurementResponse = await response.json();

      const assistantMsg: ProcurementMessage = {
        id: data.messageId,
        role: 'assistant',
        content: data.summary,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        budgetConstraint: data.extractedBudget,
        reasoningSteps: data.reasoningSteps,
        recommendations: data.recommendations,
        totalBundlePrice: data.bundleTotal,
        provider: data.provider,
        aiStatus: data.aiStatus,
        aiError: data.aiError,
        modelUsed: data.modelUsed
      };

      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err: unknown) {
      const errorMsg: ProcurementMessage = {
        id: `err-${Date.now()}`,
        role: 'system',
        content: `Error evaluating procurement proposal: ${
          err instanceof Error ? err.message : 'Unknown network failure'
        }`,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        provider: 'procurepilot-heuristic-engine'
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddBundleToCart = (recommendations: ProcurementMessage['recommendations']) => {
    if (!recommendations) return;
    for (const rec of recommendations) {
      addToCart(rec.product, rec.quantityRecommended || 1);
    }
    setIsCartOpen(true);
  };

  return (
    <div className="flex flex-col h-[780px] rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl shadow-black overflow-hidden">
      {/* Top Banner with Transparency Indicator */}
      <div className="flex items-center justify-between p-4 px-6 border-b border-slate-800 bg-slate-900/90 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-purple-950/80 border border-purple-800/60 text-purple-400">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <span>Agentic Procurement Copilot</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                Stage 1 Foundation
              </span>
            </h3>
            <p className="text-xs text-slate-400">
              Natural-language requirement decomposition & multi-tier catalog matching
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            onClick={handleResetSession}
            type="button"
            className="p-1.5 px-2.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors text-xs flex items-center gap-1.5 border border-slate-700/60"
            title="Reset Conversation Session"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Reset Session</span>
          </button>
          <Badge variant="purple" size="sm" className="gap-1.5">
            <Bot className="w-3.5 h-3.5" />
            <span>Dual-Mode AI Engine</span>
          </Badge>
        </div>
      </div>

      {/* Message Stream */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Preset chips on top */}
        <PromptPresets
          onSelectPrompt={(prompt, presetBudget) => {
            setInputQuery(prompt);
            if (presetBudget) setInputBudget(presetBudget.toString());
            handleSubmit(prompt, presetBudget);
          }}
        />

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex gap-3.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {msg.role !== 'user' && (
              <div className="p-2 rounded-xl bg-purple-950/90 border border-purple-800/60 text-purple-400 h-9 w-9 flex items-center justify-center flex-shrink-0 mt-0.5">
                <Bot className="w-4 h-4" />
              </div>
            )}

            <div
              className={`max-w-3xl space-y-3.5 rounded-2xl p-4.5 text-xs ${
                msg.role === 'user'
                  ? 'bg-purple-600/90 text-white rounded-tr-none shadow-md shadow-purple-950/40 border border-purple-500/50'
                  : msg.role === 'system'
                  ? 'bg-rose-950/60 text-rose-300 border border-rose-800/60'
                  : 'bg-slate-950/80 text-slate-200 rounded-tl-none border border-slate-800/80 shadow-md shadow-black/40'
              }`}
            >
              {/* Header meta */}
              <div className="flex items-center justify-between gap-4 text-[10px] text-slate-400 border-b border-white/10 pb-2">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-300">
                    {msg.role === 'user' ? 'Purchasing Officer' : 'ProcurePilot Assistant'}
                  </span>
                  {msg.role !== 'user' && (
                    <span
                      className={`px-2 py-0.5 rounded font-mono text-[9.5px] ${
                        msg.aiStatus === 'live'
                          ? 'bg-emerald-950/80 text-emerald-300 border border-emerald-800/60'
                          : msg.aiStatus === 'fallback'
                          ? 'bg-amber-950/80 text-amber-300 border border-amber-800/60'
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      }`}
                    >
                      {msg.aiStatus === 'live'
                        ? `${msg.modelUsed || 'Gemini 3.8 Flash'} (Live AI)`
                        : msg.aiStatus === 'fallback'
                        ? 'Heuristic Fallback (Gemini Outage / Rate Limit)'
                        : 'Rule-Based Engine (Demo)'}
                    </span>
                  )}
                </div>
                <span>{msg.timestamp}</span>
              </div>

              {/* Upstream fallback warning if present */}
              {msg.aiError && (
                <div className="p-2.5 rounded-lg bg-amber-950/40 border border-amber-800/50 text-[11px] text-amber-200 space-y-1">
                  <span className="font-semibold block text-amber-300">
                    Transparent Reliability Fallback Activated:
                  </span>
                  <p className="leading-snug text-amber-200/90">{msg.aiError.message}</p>
                </div>
              )}

              {/* Message text */}
              <p className="leading-relaxed text-xs sm:text-[13px]">{msg.content}</p>

              {/* Reasoning Trace if present */}
              {msg.reasoningSteps && (
                <AgentThoughtFeed
                  steps={msg.reasoningSteps}
                  provider={msg.provider}
                />
              )}

              {/* Recommendations Cards Grid */}
              {msg.recommendations && msg.recommendations.length > 0 && (
                <div className="space-y-3 pt-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-purple-300 uppercase tracking-wider flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5" />
                      <span>Recommended Equipment Selection ({msg.recommendations.length})</span>
                    </span>

                    {msg.totalBundlePrice !== undefined && (
                      <span className="text-xs font-bold text-white">
                        Bundle Total: ${msg.totalBundlePrice.toLocaleString()} USD
                      </span>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {msg.recommendations.map((rec) => {
                      const isItemInCart = cart.some((i) => i.product.id === rec.product.id);
                      return (
                        <div
                          key={rec.productId}
                          className="flex flex-col justify-between p-3.5 rounded-xl bg-slate-900 border border-slate-800/90 hover:border-slate-700 transition-colors space-y-2.5"
                        >
                          <div className="flex items-start gap-3">
                            <div
                              className="relative h-16 w-16 rounded-lg overflow-hidden bg-slate-950 border border-slate-800 flex-shrink-0 cursor-pointer"
                              onClick={() => setSelectedProductDetail(rec.product)}
                            >
                              <Image
                                src={rec.product.imageUrl}
                                alt={rec.product.name}
                                fill
                                className="object-cover"
                                unoptimized
                              />
                            </div>

                            <div className="min-w-0 flex-1">
                              <div className="flex items-center justify-between gap-1">
                                <span className="text-[10px] uppercase font-bold text-purple-400">
                                  {rec.product.brand}
                                </span>
                                <Badge variant="success" size="sm">
                                  {rec.matchScore}% Match
                                </Badge>
                              </div>
                              <h5
                                onClick={() => setSelectedProductDetail(rec.product)}
                                className="font-semibold text-white text-xs truncate cursor-pointer hover:text-purple-300 transition-colors mt-0.5"
                              >
                                {rec.product.name}
                              </h5>
                              <span className="text-xs font-bold text-purple-300 block mt-1">
                                ${rec.product.price.toLocaleString()} USD
                              </span>
                            </div>
                          </div>

                          {/* Reasoning note */}
                          <div className="p-2 rounded-lg bg-slate-950/60 border border-slate-800/60 text-[11px] text-slate-300 leading-snug">
                            <span className="text-slate-400 font-semibold block text-[10px] uppercase mb-0.5">
                              Procurement Rationale:
                            </span>
                            {rec.reason}
                          </div>

                          {/* Action Button */}
                          <div className="pt-1 flex items-center justify-between">
                            <button
                              onClick={() => setSelectedProductDetail(rec.product)}
                              className="text-[11px] text-slate-400 hover:text-white transition-colors underline"
                            >
                              View Specs
                            </button>

                            <Button
                              size="sm"
                              variant={isItemInCart ? 'secondary' : 'primary'}
                              onClick={() => addToCart(rec.product, rec.quantityRecommended || 1)}
                              className="gap-1 text-xs"
                            >
                              {isItemInCart ? (
                                <>
                                  <Check className="w-3 h-3 text-emerald-400" />
                                  <span>In Cart</span>
                                </>
                              ) : (
                                <>
                                  <ShoppingCart className="w-3 h-3" />
                                  <span>Add to Cart</span>
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Add Entire Bundle Button */}
                  <div className="pt-2 flex justify-end">
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleAddBundleToCart(msg.recommendations)}
                      className="gap-2 shadow-md shadow-purple-950"
                    >
                      <ShoppingCart className="w-3.5 h-3.5" />
                      <span>Add Entire Recommended Bundle to Cart</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {msg.role === 'user' && (
              <div className="p-2 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 h-9 w-9 flex items-center justify-center flex-shrink-0 mt-0.5">
                <User className="w-4 h-4" />
              </div>
            )}
          </div>
        ))}

        {isLoading && (
          <div className="flex gap-3.5 items-start">
            <div className="p-2 rounded-xl bg-purple-950/90 border border-purple-800/60 text-purple-400 h-9 w-9 flex items-center justify-center flex-shrink-0">
              <Bot className="w-4 h-4 animate-pulse" />
            </div>
            <div className="p-4 rounded-2xl rounded-tl-none bg-slate-950/80 border border-slate-800 text-xs text-slate-300 space-y-2">
              <div className="flex items-center gap-2 text-purple-400 font-semibold">
                <Sparkles className="w-4 h-4 animate-spin" />
                <span>ProcurePilot Agent is solving requirements & catalog constraints...</span>
              </div>
              <p className="text-[11px] text-slate-500">
                Evaluating stock levels, ergonomic posture metrics, and computing specifications...
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Input Form Footer */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
        className="p-4 px-6 border-t border-slate-800 bg-slate-900/90 space-y-2.5"
      >
        <div className="flex flex-col sm:flex-row gap-2.5 items-center">
          {/* Budget input constraint */}
          <div className="relative w-full sm:w-44 flex-shrink-0">
            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="number"
              placeholder="Budget Limit (USD)"
              value={inputBudget}
              onChange={(e) => setInputBudget(e.target.value)}
              className="w-full pl-9 pr-3 py-2.5 text-xs rounded-xl bg-slate-950 border border-slate-800 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-purple-500"
            />
          </div>

          {/* Main Natural Language Prompt */}
          <div className="relative flex-1 w-full">
            <input
              type="text"
              placeholder="e.g., We need 2 developer laptops with 32GB RAM and 6K monitors under $8,000..."
              value={inputQuery}
              onChange={(e) => setInputQuery(e.target.value)}
              disabled={isLoading}
              className="w-full px-4 py-2.5 text-xs rounded-xl bg-slate-950 border border-slate-800 text-slate-200 placeholder-slate-500 focus:outline-none focus:border-purple-500 disabled:opacity-60"
            />
          </div>

          <Button
            type="submit"
            variant="primary"
            size="md"
            isLoading={isLoading}
            disabled={!inputQuery.trim() || isLoading}
            className="w-full sm:w-auto gap-2 flex-shrink-0"
          >
            <Send className="w-4 h-4" />
            <span>Generate Plan</span>
          </Button>
        </div>

        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span>AI prompts automatically enforce authoritative inventory checks & fixed catalog prices.</span>
          <span className="hidden sm:inline">Press Enter to submit</span>
        </div>
      </form>
    </div>
  );
}
