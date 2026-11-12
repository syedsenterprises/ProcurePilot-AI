'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { useCart } from '@/context/CartContext';
import { PayPalCaptureResponse } from '@/types/paypal';
import { OrderConfirmationModal } from './OrderConfirmationModal';
import {
  ShieldAlert,
  Loader2,
  X,
  ArrowRight,
  Info,
  RefreshCw,
  CheckCircle2,
  Receipt
} from 'lucide-react';
import { Button } from '../ui/Button';

export function CheckoutReturnHandler() {
  const searchParams = useSearchParams();
  const { clearCart, setIsCartOpen, recentReceipt, refreshSessionState } = useCart();

  const [isCapturing, setIsCapturing] = useState(false);
  const [captureData, setCaptureData] = useState<PayPalCaptureResponse | null>(null);
  const [isConfirmationOpen, setIsConfirmationOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState<string | null>(null);
  const [showCancellationNotice, setShowCancellationNotice] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      return params.get('status') === 'cancelled';
    }
    return false;
  });

  // Prevent duplicate execution during React StrictMode double-invocations or concurrent events
  const processedTokens = useRef<Set<string>>(new Set());
  const isCapturingRef = useRef(false);

  // Authoritative Capture Execution Function (callable on mount & on retry)
  const executeCapture = useCallback(
    async (tokenToCapture: string) => {
      // Guard against concurrent execution or already-processing token
      if (isCapturingRef.current) return;
      if (processedTokens.current.has(tokenToCapture)) return;

      processedTokens.current.add(tokenToCapture);
      isCapturingRef.current = true;
      setIsCapturing(true);
      setErrorMessage(null);

      try {
        const res = await fetch('/api/paypal/capture-order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: tokenToCapture })
        });

        const data: PayPalCaptureResponse = await res.json();

        if (!res.ok || !data.success) {
          throw new Error(
            data.message || 'Payment capture failed. Your cart items have been safely preserved.'
          );
        }

        // Verified successful capture:
        setCaptureData(data);
        setIsConfirmationOpen(true);
        setRetryToken(null);

        // Clear cart ONLY after server confirmation
        clearCart();
        refreshSessionState();

        // Clean up URL query parameters
        if (typeof window !== 'undefined') {
          window.history.replaceState({}, '', window.location.pathname);
        }
      } catch (err: unknown) {
        // Remove token from processedTokens on failure so legitimate retries can execute
        processedTokens.current.delete(tokenToCapture);

        // Preserve the authorized token for retry
        setRetryToken(tokenToCapture);

        const message = err instanceof Error ? err.message : 'Order capture failed';
        setErrorMessage(message);
        // Cart remains preserved on failure
      } finally {
        setIsCapturing(false);
        isCapturingRef.current = false;
      }
    },
    [clearCart]
  );

  useEffect(() => {
    if (!searchParams) return;

    const status = searchParams.get('status');
    const token = searchParams.get('token');

    // Case 1: Cancelled on PayPal
    if (status === 'cancelled') {
      // Clean up URL query parameter without full-page navigation
      if (typeof window !== 'undefined') {
        window.history.replaceState({}, '', window.location.pathname);
      }
      setTimeout(() => {
        setShowCancellationNotice(true);
      }, 0);
      return;
    }

    // Case 2: Approved by buyer on PayPal
    if (status === 'approved' && token) {
      setTimeout(() => {
        executeCapture(token);
      }, 0);
    }
  }, [searchParams, executeCapture]);

  return (
    <>
      {/* 1. Capturing Processing Indicator Overlay */}
      {isCapturing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
          <div className="w-full max-w-md p-6 rounded-2xl bg-slate-900 border border-purple-500/50 shadow-2xl text-center space-y-4">
            <div className="w-12 h-12 mx-auto rounded-full bg-purple-950/80 border border-purple-700/60 flex items-center justify-center text-purple-400">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">
                Verifying & Capturing Order
              </h3>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                Confirming authoritative prices and recording capture in the server audit registry. Please do not close this window.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* 2. Cancellation Banner */}
      {showCancellationNotice && (
        <div className="p-4 rounded-xl bg-slate-900/90 border border-slate-800 text-xs text-slate-200 flex items-center justify-between gap-4 animate-fadeIn">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-indigo-950/80 border border-indigo-800/60 text-indigo-400 flex-shrink-0">
              <Info className="w-4 h-4" />
            </div>
            <div>
              <span className="font-semibold text-white block">
                Checkout Cancelled
              </span>
              <p className="text-slate-400 text-[11px]">
                Your PayPal checkout was cancelled. All selected items remain safe in your cart queue.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsCartOpen(true)}
              className="gap-1.5 text-xs"
            >
              <span>View Cart & Retry</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Button>
            <button
              onClick={() => setShowCancellationNotice(false)}
              className="p-1 rounded text-slate-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* 3. Capture Error Banner */}
      {errorMessage && (
        <div className="p-4 rounded-xl bg-rose-950/60 border border-rose-800/80 text-xs text-rose-200 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 animate-fadeIn">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-rose-900/80 text-rose-300 flex-shrink-0">
              <ShieldAlert className="w-4 h-4" />
            </div>
            <div>
              <span className="font-semibold text-white block">
                Payment Capture Error
              </span>
              <p className="text-rose-300/90 text-[11px] leading-relaxed">
                {errorMessage}
              </p>
              {retryToken && (
                <p className="text-[10px] text-rose-400/80 font-mono mt-0.5">
                  Order ID: {retryToken} &bull; Cart preserved safely
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 self-end sm:self-auto">
            {retryToken && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => executeCapture(retryToken)}
                disabled={isCapturing}
                className="gap-1.5 text-xs bg-rose-600 hover:bg-rose-500 text-white border-none shadow-md shadow-rose-950/50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isCapturing ? 'animate-spin' : ''}`} />
                <span>{isCapturing ? 'Retrying Capture...' : 'Retry Payment Capture'}</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsCartOpen(true)}
              disabled={isCapturing}
              className="gap-1.5 text-xs text-rose-200 border-rose-800 hover:bg-rose-900/50"
            >
              <span>Review Cart</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Button>
            <button
              onClick={() => setErrorMessage(null)}
              disabled={isCapturing}
              className="p-1 rounded text-rose-400 hover:text-white disabled:opacity-50"
              title="Dismiss error notice"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* 4. Recovered Recent Completed Order Banner */}
      {recentReceipt && !isConfirmationOpen && (
        <div className="p-3.5 rounded-xl bg-emerald-950/40 border border-emerald-800/60 text-xs text-emerald-200 flex items-center justify-between gap-4 animate-fadeIn">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <div>
              <span className="font-semibold text-emerald-100 block">
                Completed Purchase Order Confirmed: {recentReceipt.orderId}
              </span>
              <span className="text-[11px] text-emerald-300/80">
                Total: ${recentReceipt.orderDetails?.authorizedTotal.toFixed(2)} USD &bull; Verified in server registry
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setCaptureData(recentReceipt);
                setIsConfirmationOpen(true);
              }}
              className="gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white border-none"
            >
              <Receipt className="w-3.5 h-3.5" />
              <span>View Receipt</span>
            </Button>
          </div>
        </div>
      )}

      {/* 5. Full Verified Order Confirmation Modal */}
      <OrderConfirmationModal
        isOpen={isConfirmationOpen}
        onClose={() => setIsConfirmationOpen(false)}
        captureData={captureData}
      />
    </>
  );
}
