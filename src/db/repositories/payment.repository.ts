import { db } from '../pool';
import {
  DbPaymentAttempt,
  DbPaymentCapture,
  DbPaymentRefund,
  DbPaymentEvent,
  PaymentAttemptStatus,
} from './types';

export class PaymentRepository {
  // --------------------------------------------------------------------------
  // Payment Attempts & Reservations
  // --------------------------------------------------------------------------

  public async createAttempt(params: {
    order_id: string;
    action_type: 'CREATE_ORDER' | 'CAPTURE' | 'REFUND';
    idempotency_key: string;
    provider_request_id?: string | null;
    request_payload?: Record<string, unknown> | null;
    related_capture_id?: string | null;
    requested_amount?: number | null;
    currency?: string | null;
  }): Promise<DbPaymentAttempt> {
    if (params.action_type === 'REFUND') {
      throw new Error('Direct creation of refund attempts is prohibited. Use createRefundReservation instead.');
    }

    const res = await db.query<DbPaymentAttempt>(
      `INSERT INTO payment_attempts (
        order_id, related_capture_id, action_type, provider, idempotency_key,
        provider_request_id, requested_amount, currency, status, request_payload,
        initiated_at
      ) VALUES ($1, $2, $3, 'PAYPAL', $4, $5, $6, $7, 'PREPARED', $8, NOW())
      RETURNING *`,
      [
        params.order_id,
        params.related_capture_id || null,
        params.action_type,
        params.idempotency_key,
        params.provider_request_id || null,
        params.requested_amount !== undefined ? params.requested_amount : null,
        params.currency || 'USD',
        params.request_payload ? JSON.stringify(params.request_payload) : null,
      ]
    );
    return res.rows[0];
  }

  public async updateAttemptStatus(
    id: string,
    status: PaymentAttemptStatus,
    options?: {
      response_status?: number | null;
      response_payload?: Record<string, unknown> | null;
      error_message?: string | null;
    }
  ): Promise<DbPaymentAttempt> {
    const existing = await this.getAttemptById(id);
    if (!existing) {
      throw new Error(`Payment attempt ${id} not found.`);
    }

    if (existing.action_type === 'REFUND') {
      if (status === 'SUCCEEDED') {
        throw new Error('Direct transition of refund attempt to SUCCEEDED is prohibited. Use finalizeRefundSettlement instead.');
      }
      if (status === 'FAILED') {
        throw new Error('Direct transition of refund attempt to FAILED is prohibited. Use recordRefundFailure instead.');
      }
      if (status === 'OUTCOME_UNKNOWN') {
        throw new Error('Direct transition of refund attempt to OUTCOME_UNKNOWN is prohibited. Use recordRefundOutcomeUnknown instead.');
      }
    }

    const res = await db.query<DbPaymentAttempt>(
      `UPDATE payment_attempts
       SET status = $1,
           response_status = COALESCE($2, response_status),
           response_payload = COALESCE($3, response_payload),
           error_message = COALESCE($4, error_message),
           completed_at = CASE WHEN $1 IN ('SUCCEEDED', 'FAILED') THEN NOW() ELSE completed_at END
       WHERE id = $5
       RETURNING *`,
      [
        status,
        options?.response_status !== undefined ? options.response_status : null,
        options?.response_payload ? JSON.stringify(options.response_payload) : null,
        options?.error_message || null,
        id,
      ]
    );

    if (res.rows.length === 0) {
      throw new Error(`Payment attempt ${id} not found.`);
    }

    return res.rows[0];
  }

  public async getAttemptById(id: string): Promise<DbPaymentAttempt | null> {
    const res = await db.query<DbPaymentAttempt>(
      'SELECT * FROM payment_attempts WHERE id = $1',
      [id]
    );
    return res.rows[0] || null;
  }

  public async getAttemptByIdempotencyKey(key: string): Promise<DbPaymentAttempt | null> {
    const res = await db.query<DbPaymentAttempt>(
      'SELECT * FROM payment_attempts WHERE idempotency_key = $1',
      [key]
    );
    return res.rows[0] || null;
  }

  /**
   * Enforceable Refund Reservation
   * Calls stored database function `create_refund_reservation` which locks parent order,
   * calculates per-capture balance ceiling, and prevents race conditions.
   */
  public async createRefundReservation(params: {
    order_id: string;
    capture_id: string;
    refund_amount: number;
    currency: string;
    idempotency_key: string;
    provider_request_id: string;
  }): Promise<{
    attempt_id: string;
    is_existing_reservation: boolean;
    available_balance_after: number;
  }> {
    return db.withTransaction(async (client) => {
      const res = await client.query<{
        attempt_id: string;
        is_existing_reservation: boolean;
        available_balance_after: string;
      }>(
        `SELECT attempt_id, is_existing_reservation, available_balance_after
         FROM create_refund_reservation($1, $2, $3, $4, $5, $6)`,
        [
          params.order_id,
          params.capture_id,
          params.refund_amount,
          params.currency,
          params.idempotency_key,
          params.provider_request_id,
        ]
      );

      const row = res.rows[0];
      return {
        attempt_id: row.attempt_id,
        is_existing_reservation: row.is_existing_reservation,
        available_balance_after: parseFloat(row.available_balance_after),
      };
    });
  }

  // --------------------------------------------------------------------------
  // Payment Captures (Immutable Settlement Facts)
  // --------------------------------------------------------------------------

  public async recordCapture(capture: {
    order_id: string;
    external_capture_id: string;
    payment_attempt_id?: string | null;
    captured_amount: number;
    currency: 'USD';
    transaction_fee?: number | null;
    net_amount?: number | null;
    payer_email?: string | null;
    payer_id?: string | null;
    capture_origin?: 'PAYPAL_API' | 'LOCAL_SYNTHETIC_TEST';
    captured_at?: Date | null;
  }): Promise<DbPaymentCapture> {
    const res = await db.query<DbPaymentCapture>(
      `INSERT INTO payment_captures (
        order_id, external_capture_id, payment_attempt_id, captured_amount,
        currency, transaction_fee, net_amount, payer_email, payer_id,
        capture_origin, captured_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
      RETURNING *`,
      [
        capture.order_id,
        capture.external_capture_id,
        capture.payment_attempt_id || null,
        capture.captured_amount,
        capture.currency,
        capture.transaction_fee !== undefined ? capture.transaction_fee : null,
        capture.net_amount !== undefined ? capture.net_amount : null,
        capture.payer_email || null,
        capture.payer_id || null,
        capture.capture_origin || 'PAYPAL_API',
        capture.captured_at || null,
      ]
    );
    return res.rows[0];
  }

  public async getCaptureByExternalId(externalCaptureId: string): Promise<DbPaymentCapture | null> {
    const res = await db.query<DbPaymentCapture>(
      'SELECT * FROM payment_captures WHERE external_capture_id = $1',
      [externalCaptureId]
    );
    return res.rows[0] || null;
  }

  public async getCaptureByOrderId(orderId: string): Promise<DbPaymentCapture | null> {
    const res = await db.query<DbPaymentCapture>(
      'SELECT * FROM payment_captures WHERE order_id = $1',
      [orderId]
    );
    return res.rows[0] || null;
  }

  // --------------------------------------------------------------------------
  // Payment Refunds (Immutable External Confirmed Settlements)
  // --------------------------------------------------------------------------

  /**
   * Finalize Refund Settlement via Stored Procedure
   * Atomically locks parent order, inserts confirmed refund, marks attempt SUCCEEDED,
   * updates order status, and logs event under strict database invariants.
   */
  public async finalizeRefundSettlement(params: {
    attempt_id: string;
    external_refund_id: string;
    refund_amount: number;
    currency: string;
    reason?: string | null;
    refunded_at?: Date;
  }): Promise<{
    refund_id: string;
    order_id: string;
    capture_id: string;
    new_order_status: string;
  }> {
    return db.withTransaction(async (client) => {
      const res = await client.query<{
        refund_id: string;
        order_id: string;
        capture_id: string;
        new_order_status: string;
      }>(
        `SELECT refund_id, order_id, capture_id, new_order_status
         FROM finalize_refund_settlement($1, $2, $3, $4, $5, $6)`,
        [
          params.attempt_id,
          params.external_refund_id,
          params.refund_amount,
          params.currency,
          params.reason || null,
          params.refunded_at || new Date(),
        ]
      );
      return res.rows[0];
    });
  }

  /**
   * Controlled Refund Failure
   * Releases reserved headroom only after validated terminal failure or when
   * reconciliation has confirmed no external settlement occurred.
   */
  public async recordRefundFailure(params: {
    attempt_id: string;
    error_message: string;
    error_code?: string | null;
    reconciliation_cleared?: boolean;
  }): Promise<{
    attempt_id: string;
    released_amount: number;
  }> {
    return db.withTransaction(async (client) => {
      const res = await client.query<{
        attempt_id: string;
        released_amount: string;
      }>(
        `SELECT attempt_id, released_amount
         FROM record_refund_failure($1, $2, $3, $4)`,
        [
          params.attempt_id,
          params.error_message,
          params.error_code || null,
          params.reconciliation_cleared ?? false,
        ]
      );
      const row = res.rows[0];
      return {
        attempt_id: row.attempt_id,
        released_amount: parseFloat(row.released_amount),
      };
    });
  }

  /**
   * Controlled Ambiguous Outcome Transition
   * Transitions in-flight refund attempt to OUTCOME_UNKNOWN while strictly retaining
   * reservation headroom against double-spending until reconciliation.
   */
  public async recordRefundOutcomeUnknown(params: {
    attempt_id: string;
    reason: string;
  }): Promise<{
    attempt_id: string;
  }> {
    return db.withTransaction(async (client) => {
      const res = await client.query<{
        attempt_id: string;
      }>(
        `SELECT attempt_id
         FROM record_refund_outcome_unknown($1, $2)`,
        [params.attempt_id, params.reason]
      );
      return res.rows[0];
    });
  }

  public async recordConfirmedRefund(refund: {
    order_id: string;
    capture_id: string;
    payment_attempt_id?: string | null;
    external_refund_id: string;
    refund_amount: number;
    currency: 'USD';
    reason?: string | null;
    refunded_at: Date;
  }): Promise<DbPaymentRefund> {
    return db.withTransaction(async (client) => {
      // 1. Lock parent order to ensure serialization
      await client.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [refund.order_id]);

      // 2. Insert into payment_refunds (trigger enforces balance invariant)
      const res = await client.query<DbPaymentRefund>(
        `INSERT INTO payment_refunds (
          order_id, capture_id, payment_attempt_id, external_refund_id,
          refund_amount, currency, reason, refunded_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
        RETURNING *`,
        [
          refund.order_id,
          refund.capture_id,
          refund.payment_attempt_id || null,
          refund.external_refund_id,
          refund.refund_amount,
          refund.currency,
          refund.reason || null,
          refund.refunded_at,
        ]
      );

      // 3. Update order operational status
      const balanceRes = await client.query<{ captured_amount: string; total_refunded: string }>(
        `SELECT c.captured_amount, COALESCE(SUM(r.refund_amount), 0) AS total_refunded
         FROM payment_captures c
         LEFT JOIN payment_refunds r ON r.capture_id = c.id
         WHERE c.id = $1
         GROUP BY c.captured_amount`,
        [refund.capture_id]
      );

      if (balanceRes.rows.length > 0) {
        const { captured_amount, total_refunded } = balanceRes.rows[0];
        const isFullRefund = parseFloat(total_refunded) >= parseFloat(captured_amount);
        const newStatus = isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
        await client.query(
          'UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2',
          [newStatus, refund.order_id]
        );
      }

      return res.rows[0];
    });
  }

  // --------------------------------------------------------------------------
  // Payment Events (Append-Only Audit Timeline)
  // --------------------------------------------------------------------------

  public async recordPaymentEvent(event: {
    order_id: string;
    event_type: string;
    previous_status?: string | null;
    new_status: string;
    amount?: number | null;
    context?: Record<string, unknown> | null;
  }): Promise<DbPaymentEvent> {
    const res = await db.query<DbPaymentEvent>(
      `INSERT INTO payment_events (
        order_id, event_type, previous_status, new_status, amount, context, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *`,
      [
        event.order_id,
        event.event_type,
        event.previous_status || null,
        event.new_status,
        event.amount !== undefined ? event.amount : null,
        event.context ? JSON.stringify(event.context) : null,
      ]
    );
    return res.rows[0];
  }
}

export const paymentRepository = new PaymentRepository();
