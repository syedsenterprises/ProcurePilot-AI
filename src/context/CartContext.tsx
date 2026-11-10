'use client';

import React, { createContext, useContext, useState, useEffect, useMemo, useCallback } from 'react';
import { Product } from '@/types/product';
import { CartItem, CartSummary, BudgetStatus, CartValidationResult } from '@/types/cart';

interface CartContextType {
  cart: CartItem[];
  addToCart: (product: Product, quantity?: number) => void;
  removeFromCart: (productId: string) => void;
  updateQuantity: (productId: string, quantity: number) => void;
  clearCart: () => void;
  cartSummary: CartSummary;
  budget: number | null;
  setBudget: (budget: number | null) => void;
  budgetStatus: BudgetStatus;
  compareList: Product[];
  addToCompare: (product: Product) => void;
  removeFromCompare: (productId: string) => void;
  clearCompare: () => void;
  isCartOpen: boolean;
  setIsCartOpen: (open: boolean) => void;
  isCompareOpen: boolean;
  setIsCompareOpen: (open: boolean) => void;
  selectedProductDetail: Product | null;
  setSelectedProductDetail: (product: Product | null) => void;
  serverReconciliation: CartValidationResult | null;
  isReconciling: boolean;
  reconcileWithServer: (approvalConfirmed?: boolean) => Promise<CartValidationResult | null>;
}

const CartContext = createContext<CartContextType | undefined>(undefined);

export function CartProvider({ children }: { children: React.ReactNode }) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [budget, setBudget] = useState<number | null>(4500); // Sensible default budget
  const [compareList, setCompareList] = useState<Product[]>([]);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isCompareOpen, setIsCompareOpen] = useState(false);
  const [selectedProductDetail, setSelectedProductDetail] = useState<Product | null>(null);
  const [serverReconciliation, setServerReconciliation] = useState<CartValidationResult | null>(null);
  const [isReconciling, setIsReconciling] = useState(false);

  // Local calculation (will be verified authoritatively server-side on checkout/validation)
  const cartSummary: CartSummary = useMemo(() => {
    const subtotal = cart.reduce((acc, item) => acc + item.product.price * item.quantity, 0);
    const estimatedTax = Math.round(subtotal * 0.0825 * 100) / 100;
    const shipping = subtotal >= 1000 || subtotal === 0 ? 0 : 25;
    const total = Math.round((subtotal + estimatedTax + shipping) * 100) / 100;
    const itemCount = cart.reduce((acc, item) => acc + item.quantity, 0);

    return {
      subtotal,
      estimatedTax,
      shipping,
      total,
      itemCount
    };
  }, [cart]);

  const budgetStatus: BudgetStatus = useMemo(() => {
    const allocated = budget ?? 0;
    const spent = cartSummary.total;
    const remaining = allocated > 0 ? allocated - spent : 0;
    const percentage = allocated > 0 ? Math.min(Math.round((spent / allocated) * 100), 100) : 0;
    const isOverBudget = allocated > 0 && spent > allocated;

    let status: BudgetStatus['status'] = 'safe';
    if (isOverBudget) {
      status = 'exceeded';
    } else if (percentage >= 80) {
      status = 'warning';
    }

    return {
      allocatedBudget: allocated,
      spent,
      remaining,
      percentage,
      isOverBudget,
      status
    };
  }, [budget, cartSummary.total]);

  // Server-side authoritative reconciliation
  const reconcileWithServer = useCallback(
    async (approvalConfirmed = false): Promise<CartValidationResult | null> => {
      if (cart.length === 0) {
        setServerReconciliation(null);
        return null;
      }

      setIsReconciling(true);
      try {
        const res = await fetch('/api/cart/validate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: cart.map((item) => ({ productId: item.product.id, quantity: item.quantity })),
            budgetCap: budget ?? undefined,
            userApprovalConfirmed: approvalConfirmed
          })
        });

        if (!res.ok) {
          throw new Error('Failed to validate cart with server');
        }

        const data = await res.json();
        setServerReconciliation(data.data);
        return data.data;
      } catch (err) {
        console.error('Server cart reconciliation error:', err);
        return null;
      } finally {
        setIsReconciling(false);
      }
    },
    [cart, budget]
  );

  // Reconcile when cart items or budget changes
  useEffect(() => {
    if (cart.length === 0) return;

    const timer = setTimeout(() => {
      reconcileWithServer(false);
    }, 400);
    return () => clearTimeout(timer);
  }, [cart, budget, reconcileWithServer]);

  const addToCart = (product: Product, quantity = 1) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.product.id === product.id);
      if (existing) {
        return prev.map((item) =>
          item.product.id === product.id
            ? { ...item, quantity: item.quantity + quantity }
            : item
        );
      }
      return [...prev, { product, quantity }];
    });
  };

  const removeFromCart = (productId: string) => {
    setCart((prev) => prev.filter((item) => item.product.id !== productId));
  };

  const updateQuantity = (productId: string, quantity: number) => {
    if (quantity <= 0) {
      removeFromCart(productId);
      return;
    }
    setCart((prev) =>
      prev.map((item) =>
        item.product.id === productId ? { ...item, quantity } : item
      )
    );
  };

  const clearCart = () => {
    setCart([]);
    setServerReconciliation(null);
  };

  const addToCompare = (product: Product) => {
    setCompareList((prev) => {
      if (prev.some((p) => p.id === product.id)) {
        return prev;
      }
      if (prev.length >= 4) {
        // limit to 4 items max
        return [...prev.slice(1), product];
      }
      return [...prev, product];
    });
    setIsCompareOpen(true);
  };

  const removeFromCompare = (productId: string) => {
    setCompareList((prev) => prev.filter((p) => p.id !== productId));
  };

  const clearCompare = () => {
    setCompareList([]);
  };

  return (
    <CartContext.Provider
      value={{
        cart,
        addToCart,
        removeFromCart,
        updateQuantity,
        clearCart,
        cartSummary,
        budget,
        setBudget,
        budgetStatus,
        compareList,
        addToCompare,
        removeFromCompare,
        clearCompare,
        isCartOpen,
        setIsCartOpen,
        isCompareOpen,
        setIsCompareOpen,
        selectedProductDetail,
        setSelectedProductDetail,
        serverReconciliation,
        isReconciling,
        reconcileWithServer
      }}
    >
      {children}
    </CartContext.Provider>
  );
}

export function useCart() {
  const context = useContext(CartContext);
  if (!context) {
    throw new Error('useCart must be used within a CartProvider');
  }
  return context;
}
