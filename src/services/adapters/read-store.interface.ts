import { StoredPayPalOrder } from '../paypal/paypal-order-store';
import { ApprovalChallengeState } from '../approval/approval.service';

/**
 * Capture details retrieved from authoritative payment records or simulation metadata.
 */
export interface OrderCaptureInfo {
  orderId: string;
  externalCaptureId: string;
  capturedAmount: string; // Exact 2-decimal string (e.g. '294.54')
  capturedAmountCents: number; // Exact integer cents (e.g. 29454)
  currency: string;
  captureOrigin: 'PAYPAL_API' | 'LOCAL_SYNTHETIC_TEST';
  isSimulated: boolean;
  capturedAt?: string | null;
}

/**
 * Lightweight ticket status and provenance metadata.
 */
export interface TicketStatusInfo {
  ticketId: string;
  status: string;
  integrityStatus: string;
  sourceOrigin: string;
  isVerifiable: boolean;
}

/**
 * Normalized line item representation for orders and approval challenges.
 */
export interface ReadOnlyLineItem {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal?: number;
}

/**
 * Read-only store interface for order domain queries.
 * Strictly read-only; no mutation methods are exposed.
 */
export interface IOrderReadStore {
  /**
   * Retrieves an order by its original source identifier (e.g. '8HX63874LW066860W' or 'SANDBOX_STAGE2_*').
   * In PostgreSQL implementations, resolves external_order_id and verifies canonical order_number.
   * Returns complete composite order with line items, capture facts, and simulation metadata.
   */
  getOrder(sourceOrderId: string): Promise<StoredPayPalOrder | null>;

  /**
   * Retrieves an order by external PayPal order identifier.
   */
  getOrderByExternalId(externalOrderId: string): Promise<StoredPayPalOrder | null>;

  /**
   * Retrieves line items associated with an order.
   */
  getOrderItems(sourceOrderId: string): Promise<ReadOnlyLineItem[] | null>;

  /**
   * Retrieves capture settlement details for an order.
   * Returns genuine settlement records or simulation metadata without fabricating ledger entries.
   */
  getCaptureInfo(sourceOrderId: string): Promise<OrderCaptureInfo | null>;
}

/**
 * Read-only store interface for approval challenge and ticket domain queries.
 * Strictly read-only; no signing, mutation, or single-use consumption methods are exposed.
 */
export interface IApprovalReadStore {
  /**
   * Retrieves complete approval challenge state by ticket identifier.
   * Preserves historical provenance (UNVERIFIABLE_LEGACY) and prevents signature manufacturing.
   */
  getChallenge(ticketId: string): Promise<ApprovalChallengeState | null>;

  /**
   * Fast status and provenance lookup for an approval ticket.
   */
  getTicketStatus(ticketId: string): Promise<TicketStatusInfo | null>;

  /**
   * Retrieves verified line items associated with an approval challenge.
   */
  getTicketItems(ticketId: string): Promise<ReadOnlyLineItem[] | null>;
}
