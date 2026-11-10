'use client';

import React, { useState } from 'react';
import { useCart } from '@/context/CartContext';
import { CartItemRow } from './CartItemRow';
import { PurchaseSummary } from '../budget/PurchaseSummary';
import { BudgetTracker } from '../budget/BudgetTracker';
import { HumanApprovalGate } from './HumanApprovalGate';
import { X, ShoppingBag, ShieldCheck, ArrowRight, Trash2 } from 'lucide-react';
import { Button } from '../ui/Button';

export function CartDrawer() {
  const { cart, isCartOpen, setIsCartOpen, clearCart, budgetStatus, cartSummary } = useCart();
  const [isApprovalGateOpen, setIsApprovalGateOpen] = useState(false);

  if (!isCartOpen) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={() => setIsCartOpen(false)}
      />

      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col text-slate-200 animate-slideLeft">
        {/* Drawer Header */}
        <div className="flex items-center justify-between p-4 px-5 border-b border-slate-800 bg-slate-900/90">
          <div className="flex items-center gap-2">
            <ShoppingBag className="w-5 h-5 text-purple-400" />
            <h3 className="text-base font-semibold text-white">Procurement Cart</h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 font-mono">
              {cartSummary.itemCount}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {cart.length > 0 && (
              <button
                onClick={clearCart}
                className="text-slate-400 hover:text-rose-400 transition-colors p-1.5 rounded-lg hover:bg-slate-800 text-xs flex items-center gap-1"
                title="Empty Cart"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Empty</span>
              </button>
            )}
            <button
              onClick={() => setIsCartOpen(false)}
              className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Budget Tracker in Cart */}
          <BudgetTracker />

          {/* Items List */}
          {cart.length > 0 ? (
            <div className="space-y-3">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider block">
                Queued Items ({cart.length})
              </span>
              <div className="space-y-2.5">
                {cart.map((item) => (
                  <CartItemRow key={item.product.id} item={item} />
                ))}
              </div>
            </div>
          ) : (
            <div className="text-center py-12 px-4 rounded-xl bg-slate-950/40 border border-slate-800/80">
              <ShoppingBag className="w-10 h-10 text-slate-600 mx-auto mb-2" />
              <h4 className="text-sm font-semibold text-slate-300">Your procurement cart is empty</h4>
              <p className="text-xs text-slate-500 mt-1">
                Ask the AI Procurement Assistant or select equipment from the verified catalogue.
              </p>
            </div>
          )}

          {/* Financial Summary */}
          {cart.length > 0 && <PurchaseSummary />}
        </div>

        {/* Drawer Footer */}
        {cart.length > 0 && (
          <div className="p-4 px-5 border-t border-slate-800 bg-slate-900/90 space-y-3">
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <ShieldCheck className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />
              <span>Step 1 of 2: Explicit human governance approval is required next.</span>
            </div>

            <Button
              variant="primary"
              size="lg"
              className="w-full gap-2 shadow-lg shadow-purple-950"
              disabled={budgetStatus.isOverBudget}
              onClick={() => setIsApprovalGateOpen(true)}
            >
              <span>{budgetStatus.isOverBudget ? 'Budget Exceeded (Adjust Cart)' : 'Proceed to Human Approval'}</span>
              <ArrowRight className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>

      <HumanApprovalGate
        isOpen={isApprovalGateOpen}
        onClose={() => setIsApprovalGateOpen(false)}
      />
    </>
  );
}
