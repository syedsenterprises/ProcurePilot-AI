'use client';

import React, { useState } from 'react';
import { useCart } from '@/context/CartContext';
import {
  ShieldAlert,
  ShieldCheck,
  CheckCircle2,
  Lock,
  ExternalLink,
  Info,
  X,
  CreditCard,
  Building2,
  UserCheck,
  Key
} from 'lucide-react';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { PayPalOrderResponse } from '@/types/paypal';

interface HumanApprovalGateProps {
  isOpen: boolean;
  onClose: () => void;
}

export function HumanApprovalGate({ isOpen, onClose }: HumanApprovalGateProps) {
  const { cart, cartSummary, budgetStatus, reconcileWithServer } = useCart();

  const [userName, setUserName] = useState('Alex Mercer (Procurement Lead)');
  const [department, setDepartment] = useState('Engineering & DevOps');
  const [justification, setJustification] = useState(
    'Hardware allocation for software engineering team workstation modernization.'
  );
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [stepStatus, setStepStatus] = useState<string>('');
  const [orderResult, setOrderResult] = useState<PayPalOrderResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmitApprovalAndOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConfirmed) {
      setErrorMessage('You must review and check the explicit authorization confirmation.');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);
    setOrderResult(null);

    try {
      // 1. Authoritative Server-Side Reconciliation Check
      setStepStatus('Verifying server-side prices...');
      const reconciliation = await reconcileWithServer(true);
      if (!reconciliation || !reconciliation.isValid) {
        throw new Error(
          reconciliation?.discrepancies.join('; ') ||
            'Failed server reconciliation check. Prices or inventory may have changed.'
        );
      }

      // 2. Stage 1: Request Cryptographic Approval Challenge
      setStepStatus('Generating cryptographic approval challenge...');
      const challengeRes = await fetch('/api/approval/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart.map((i) => ({ productId: i.product.id, quantity: i.quantity })),
          budgetCap: budgetStatus.allocatedBudget > 0 ? budgetStatus.allocatedBudget : undefined
        })
      });

      if (!challengeRes.ok) {
        const errData = await challengeRes.json();
        throw new Error(errData.error || 'Failed to generate approval challenge.');
      }

      const challengeJson = await challengeRes.json();
      const challengeData = challengeJson.data;

      // 3. Stage 2: Sign Challenge with Self-Attested Approver Credentials
      setStepStatus('Signing challenge ticket with HMAC-SHA256 signature...');
      const signRes = await fetch('/api/approval/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticketId: challengeData.ticketId,
          cartFingerprint: challengeData.cartFingerprint,
          nonce: challengeData.nonce,
          signature: challengeData.signature,
          signoff: {
            userName: userName.trim(),
            department: department.trim(),
            purchaseJustification: justification.trim()
          }
        })
      });

      if (!signRes.ok) {
        const signData = await signRes.json();
        throw new Error(signData.error || 'Failed to sign approval challenge.');
      }

      const signJson = await signRes.json();
      const { ticketId, authToken } = signJson.data;

      // 4. Stage 3: Submit Order Creation with Single-Use Auth Token
      setStepStatus('Initiating server-side PayPal Sandbox Order...');
      const orderRes = await fetch('/api/paypal/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticketId,
          authToken,
          items: cart.map((i) => ({ productId: i.product.id, quantity: i.quantity })),
          approvalSignoff: {
            userName: userName.trim(),
            department: department.trim(),
            purchaseJustification: justification.trim()
          },
          currency: 'USD'
        })
      });

      const data: PayPalOrderResponse = await orderRes.json();
      setOrderResult(data);

      if (!orderRes.ok && !data.requiresManualReview) {
        throw new Error(data.message || 'Server order generation failed');
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Order processing failed');
    } finally {
      setIsSubmitting(false);
      setStepStatus('');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fadeIn">
      <div
        className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl shadow-black text-slate-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-5 bg-slate-900/90 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-purple-950/80 border border-purple-800/60 text-purple-400">
              <Lock className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">
                Cryptographic Two-Stage Human Approval
              </h3>
              <p className="text-xs text-slate-400">
                HMAC-SHA256 session-bound authorization ticket required before checkout
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Identity Transparency Banner */}
          <div className="flex items-start gap-3 p-3.5 rounded-xl bg-indigo-950/40 border border-indigo-800/50 text-xs text-indigo-200">
            <Key className="w-4 h-4 text-indigo-400 flex-shrink-0 mt-0.5" />
            <div className="space-y-1">
              <span className="font-semibold block text-indigo-100">
                Security Governance: Two-Stage Requisition Checkpoint
              </span>
              <p className="text-[11px] leading-relaxed">
                Order creation requires a cryptographically signed, single-use ticket bound to this cart&apos;s
                exact items, currency, and total amount. Client-supplied booleans are strictly rejected.
              </p>
              <div className="pt-0.5">
                <Badge variant="navy" size="sm">
                  Identity Tier: Self-Attested Requisitioner (IdP/SSO Not Connected in Stage 2)
                </Badge>
              </div>
            </div>
          </div>

          {/* Cart & Budget Snapshot */}
          <div className="p-4 rounded-xl bg-slate-950/60 border border-slate-800 flex justify-between items-center text-xs">
            <div>
              <span className="text-slate-400 block">Total Payable (Reconciled)</span>
              <span className="text-xl font-bold text-white tracking-tight">
                ${cartSummary.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
              <span className="text-[11px] text-slate-500">Fixed USD authoritative amount</span>
            </div>

            <div className="text-right">
              <span className="text-slate-400 block">Fiscal Budget Cap</span>
              <span
                className={`font-semibold ${
                  budgetStatus.isOverBudget ? 'text-rose-400' : 'text-slate-200'
                }`}
              >
                ${budgetStatus.allocatedBudget.toLocaleString()}
              </span>
              <div className="mt-1">
                {budgetStatus.isOverBudget ? (
                  <Badge variant="danger">Exceeds Budget</Badge>
                ) : (
                  <Badge variant="success">Within Budget Allocation</Badge>
                )}
              </div>
            </div>
          </div>

          {/* Form */}
          {!orderResult ? (
            <form onSubmit={handleSubmitApprovalAndOrder} className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1 flex items-center gap-1">
                    <UserCheck className="w-3.5 h-3.5 text-purple-400" />
                    <span>Requisitioner Full Name & Title</span>
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg bg-slate-950 border border-slate-800 text-slate-100 focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1 flex items-center gap-1">
                    <Building2 className="w-3.5 h-3.5 text-purple-400" />
                    <span>Cost Center / Department</span>
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    className="w-full px-3 py-2 text-xs rounded-lg bg-slate-950 border border-slate-800 text-slate-100 focus:outline-none focus:border-purple-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Business Purpose & Justification (Required for Audit Trail)
                </label>
                <textarea
                  rows={2}
                  required
                  maxLength={500}
                  value={justification}
                  onChange={(e) => setJustification(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg bg-slate-950 border border-slate-800 text-slate-100 focus:outline-none focus:border-purple-500"
                />
              </div>

              {/* Confirmation Checkbox */}
              <div className="p-3 rounded-xl bg-slate-950/80 border border-slate-800">
                <label className="flex items-start gap-2.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={isConfirmed}
                    onChange={(e) => setIsConfirmed(e.target.checked)}
                    className="mt-0.5 rounded bg-slate-900 border-slate-700 text-purple-600 focus:ring-0"
                  />
                  <div className="text-xs text-slate-300 leading-snug">
                    <span className="font-semibold text-white block">
                      Explicit Human Authorization Sign-Off
                    </span>
                    I hereby certify that I have reviewed the itemized products, quantities, and server-verified
                    subtotal, and authoritatively approve this commercial procurement order.
                  </div>
                </label>
              </div>

              {stepStatus && (
                <div className="text-xs text-purple-300 flex items-center gap-2 animate-pulse">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>{stepStatus}</span>
                </div>
              )}

              {errorMessage && (
                <div className="p-3 rounded-lg bg-rose-950/60 border border-rose-800/80 text-xs text-rose-300 flex items-start gap-2">
                  <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{errorMessage}</span>
                </div>
              )}

              {/* Submit Buttons */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <Button variant="outline" size="md" type="button" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="md"
                  type="submit"
                  isLoading={isSubmitting}
                  disabled={!isConfirmed || budgetStatus.isOverBudget}
                  className="gap-2"
                >
                  <CreditCard className="w-4 h-4" />
                  <span>Sign Challenge & Connect PayPal Sandbox</span>
                </Button>
              </div>
            </form>
          ) : (
            /* Result State (Stage 2 Presentation) */
            <div className="space-y-4 animate-fadeIn">
              {orderResult.success && orderResult.orderId ? (
                <div className="p-4 rounded-xl bg-emerald-950/50 border border-emerald-800/70 text-xs text-emerald-200 space-y-2">
                  <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
                    <CheckCircle2 className="w-5 h-5" />
                    <span>PayPal Sandbox Order Authorized & Created</span>
                  </div>
                  <p>
                    Server-to-server authorization confirmed. PayPal Order ID:{' '}
                    <span className="font-mono text-white">{orderResult.orderId}</span>
                  </p>
                  {orderResult.approvalUrl && (
                    <div className="pt-2">
                      <a
                        href={orderResult.approvalUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium transition-colors"
                      >
                        <span>Open PayPal Sandbox Checkout</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-4 rounded-xl bg-slate-950 border border-purple-500/50 text-xs text-slate-300 space-y-3">
                  <div className="flex items-center gap-2 text-purple-400 font-semibold text-sm">
                    <Info className="w-4.5 h-4.5" />
                    <span>Stage 2 Cryptographic Gate Verified</span>
                  </div>
                  <p className="leading-relaxed">
                    {orderResult.message ||
                      'All security checks, server-side price recalculation, and human approval audit logs completed successfully.'}
                  </p>

                  <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 font-mono text-[11px] space-y-1 text-slate-400">
                    <div>Status: PENDING_PAYPAL_CREDENTIALS</div>
                    <div>Environment: sandbox</div>
                    <div>
                      Verified Total: ${orderResult.totalAmount?.value} {orderResult.totalAmount?.currencyCode}
                    </div>
                    <div>Signed Approver: {userName} (Self-Attested)</div>
                    <div>Order Ref: {orderResult.orderId}</div>
                    <div>Timestamp: {orderResult.createdAt}</div>
                  </div>

                  <div className="p-3 rounded-lg bg-purple-950/30 border border-purple-800/40 text-[11px] text-purple-200">
                    <span className="font-semibold block mb-0.5">Sandbox Integration Active:</span>
                    To complete end-to-end checkout on PayPal&apos;s sandbox portal, populate{' '}
                    <code className="text-white bg-slate-900 px-1 py-0.5 rounded">PAYPAL_CLIENT_ID</code> and{' '}
                    <code className="text-white bg-slate-900 px-1 py-0.5 rounded">PAYPAL_CLIENT_SECRET</code>{' '}
                    in your <code className="text-white bg-slate-900 px-1 py-0.5 rounded">.env.local</code>.
                  </div>

                  {orderResult.isSimulated && orderResult.approvalUrl && (
                    <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-800/40 flex items-center justify-between gap-2">
                      <div className="text-[11px] text-amber-200">
                        <span className="font-semibold block text-amber-100">Development Testing:</span>
                        Test frontend return handler & capture flow with simulated Sandbox approval.
                      </div>
                      <a
                        href={orderResult.approvalUrl}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-medium transition-colors text-xs flex-shrink-0"
                      >
                        <span>Simulate Return</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  )}

                  <div className="flex justify-end pt-2">
                    <Button variant="secondary" size="sm" onClick={onClose}>
                      Close
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
