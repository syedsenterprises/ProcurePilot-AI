import { OrderStatus } from './repositories/types';

/**
 * Authoritative 12-State Order Lifecycle State Machine
 * ProcurePilot AI — Phase 1B.1.1 Canonical Transition Graph
 */
export const AUTHORITATIVE_ORDER_STATES: readonly OrderStatus[] = [
  'DRAFT',
  'CREATION_RECONCILIATION_REQUIRED',
  'PENDING_PAYMENT_APPROVAL',
  'BUYER_APPROVED',
  'SETTLING',
  'COMPLETED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'CANCELLED',
  'EXPIRED',
  'FAILED',
  'RECONCILIATION_REQUIRED',
] as const;

/**
 * Permitted transitions from each order status.
 * Terminal states (REFUNDED, CANCELLED, EXPIRED, FAILED) have empty transition sets.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  DRAFT: [
    'PENDING_PAYMENT_APPROVAL',
    'CREATION_RECONCILIATION_REQUIRED',
    'CANCELLED',
    'FAILED',
  ],
  CREATION_RECONCILIATION_REQUIRED: [
    'PENDING_PAYMENT_APPROVAL',
    'FAILED',
    'CANCELLED',
    'RECONCILIATION_REQUIRED',
  ],
  PENDING_PAYMENT_APPROVAL: [
    'BUYER_APPROVED',
    'EXPIRED',
    'CANCELLED',
    'FAILED',
  ],
  BUYER_APPROVED: [
    'SETTLING',
    'CANCELLED',
    'FAILED',
  ],
  SETTLING: [
    'COMPLETED',
    'FAILED',
    'RECONCILIATION_REQUIRED',
  ],
  COMPLETED: [
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'RECONCILIATION_REQUIRED',
  ],
  PARTIALLY_REFUNDED: [
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'RECONCILIATION_REQUIRED',
  ],
  REFUNDED: [], // Terminal
  CANCELLED: [], // Terminal
  EXPIRED: [], // Terminal
  FAILED: [], // Terminal
  RECONCILIATION_REQUIRED: [
    'COMPLETED',
    'PARTIALLY_REFUNDED',
    'REFUNDED',
    'FAILED',
    'CANCELLED',
  ],
};

/**
 * Returns true if transition from `fromStatus` to `toStatus` is strictly permitted.
 */
export function canTransitionOrder(fromStatus: OrderStatus, toStatus: OrderStatus): boolean {
  if (fromStatus === toStatus) return true; // Idempotent no-op transition
  const allowed = ORDER_STATUS_TRANSITIONS[fromStatus];
  return allowed ? allowed.includes(toStatus) : false;
}

/**
 * Asserts that a transition between two order states is valid.
 * Throws an Error if the transition is prohibited.
 */
export function validateOrderTransition(fromStatus: OrderStatus, toStatus: OrderStatus): void {
  if (!canTransitionOrder(fromStatus, toStatus)) {
    throw new Error(
      `Invalid Order Status Transition: Cannot transition order from '${fromStatus}' to '${toStatus}'`
    );
  }
}

/**
 * Maps legacy file-backed prototype statuses to the authoritative 12-state database model.
 */
export function mapLegacyOrderStatusToDb(legacyStatus: string, hasExternalOrderId = false): OrderStatus {
  const normalized = (legacyStatus || '').toUpperCase().trim();
  switch (normalized) {
    case 'CREATED':
      return hasExternalOrderId ? 'PENDING_PAYMENT_APPROVAL' : 'DRAFT';
    case 'DRAFT':
      return 'DRAFT';
    case 'SAVED':
    case 'PENDING_APPROVAL':
    case 'PENDING_PAYMENT_APPROVAL':
      return 'PENDING_PAYMENT_APPROVAL';
    case 'APPROVED':
    case 'BUYER_APPROVED':
      return 'BUYER_APPROVED';
    case 'SETTLING':
    case 'PAYMENT_PENDING':
      return 'SETTLING';
    case 'CAPTURED':
    case 'COMPLETED':
    case 'PAYMENT_COMPLETED':
      return 'COMPLETED';
    case 'PARTIALLY_REFUNDED':
      return 'PARTIALLY_REFUNDED';
    case 'REFUNDED':
      return 'REFUNDED';
    case 'CANCELLED':
    case 'VOIDED':
      return 'CANCELLED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'FAILED':
    case 'PAYMENT_FAILED':
      return 'FAILED';
    case 'CREATION_RECONCILIATION_REQUIRED':
      return 'CREATION_RECONCILIATION_REQUIRED';
    case 'RECONCILIATION_REQUIRED':
      return 'RECONCILIATION_REQUIRED';
    default:
      throw new Error(`Unmapped or unrecognized legacy order status: '${legacyStatus}'`);
  }
}
