import { Pool, PoolClient } from 'pg';
import { db } from '@/db/pool';
import { generateLegacyOrderNumber } from '@/db/legacy-migration';
import { parseExactDecimalToCents } from '@/db/legacy-preflight';
import { StoredPayPalOrder } from '../paypal/paypal-order-store';
import { IOrderReadStore, OrderCaptureInfo, ReadOnlyLineItem } from './read-store.interface';

/**
 * PostgreSQL read-only order adapter.
 * Connects to the persistent PostgreSQL store under strict read-only execution boundaries.
 * Enforces strict single-key authoritative lookup (external_order_id = $1),
 * strict dual-field identity verification (external_order_id AND canonical order_number),
 * eager composite item assembly, exact integer-cent arithmetic, and zero synthetic capture
 * contamination in payment_captures.
 */
export class PostgresOrderReadAdapter implements IOrderReadStore {
  private customPool?: Pool;

  constructor(options?: { pool?: Pool }) {
    this.customPool = options?.pool;
  }

  private getPool(): Pool {
    return this.customPool || db.getPool();
  }

  /**
   * Helper: Executes a database query inside an explicit READ ONLY transaction.
   * Guarantees that no mutation statements can execute and releases client on completion.
   */
  private async executeReadOnly<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = this.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Ignore rollback failure on connection termination
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Resolves a PostgreSQL order record from an authoritative original source identifier.
   * - Queries strictly and exclusively by `external_order_id = $1`.
   * - Returns null when no matching external ID exists.
   * - Rejects multiple matching rows with an explicit ambiguity error.
   * - Verifies row.external_order_id === sourceOrderId.
   * - Verifies row.order_number === generateLegacyOrderNumber(sourceOrderId).
   * - Throws an explicit identity-integrity error if either verification fails.
   * - Never falls back to matching by order number alone.
   */
  public async resolvePostgresOrder(sourceOrderId: string, client?: PoolClient): Promise<any | null> {
    const expectedOrderNumber = generateLegacyOrderNumber(sourceOrderId);

    const queryFn = async (cl: PoolClient) => {
      // Authoritative lookup key is strictly and exclusively external_order_id
      const res = await cl.query<any>(
        `SELECT * FROM orders WHERE external_order_id = $1`,
        [sourceOrderId]
      );

      if (res.rows.length > 1) {
        throw new Error(
          `Ambiguous legacy order mapping: original identifier "${sourceOrderId}" matched ${res.rows.length} records in PostgreSQL`
        );
      }

      if (res.rows.length === 0) {
        return null;
      }

      const order = res.rows[0];

      // Strict dual-identity verification
      if (order.external_order_id !== sourceOrderId) {
        throw new Error(
          `Order identity integrity violation: queried for sourceOrderId "${sourceOrderId}", but resolved record had external_order_id="${order.external_order_id}"`
        );
      }

      if (order.order_number !== expectedOrderNumber) {
        throw new Error(
          `Order identity integrity violation: queried for sourceOrderId "${sourceOrderId}", but resolved record had order_number="${order.order_number}" (expected canonical order_number="${expectedOrderNumber}")`
        );
      }

      return order;
    };

    if (client) {
      return queryFn(client);
    }
    return this.executeReadOnly(queryFn);
  }

  /**
   * Maps a raw PostgreSQL order row and child rows into a composite StoredPayPalOrder.
   */
  private mapCompositeOrder(orderRow: any, items: any[], captureRow: any | null): StoredPayPalOrder {
    const totalCents = parseExactDecimalToCents(orderRow.authorized_total, `order[${orderRow.id}].authorized_total`);
    const subtotalCents = orderRow.authorized_subtotal
      ? parseExactDecimalToCents(orderRow.authorized_subtotal, `order[${orderRow.id}].authorized_subtotal`)
      : totalCents;
    const taxCents = orderRow.authorized_tax
      ? parseExactDecimalToCents(orderRow.authorized_tax, `order[${orderRow.id}].authorized_tax`)
      : 0;
    const shippingCents = orderRow.authorized_shipping
      ? parseExactDecimalToCents(orderRow.authorized_shipping, `order[${orderRow.id}].authorized_shipping`)
      : 0;

    // Status mapping: PostgreSQL order state machine -> StoredPayPalOrder status
    let mappedStatus: 'CREATED' | 'CAPTURED' | 'VOIDED' = 'CREATED';
    if (['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(orderRow.status)) {
      mappedStatus = 'CAPTURED';
    } else if (orderRow.status === 'VOIDED') {
      mappedStatus = 'VOIDED';
    }

    const mappedItems: ReadOnlyLineItem[] = items.map((it) => {
      const priceCents = parseExactDecimalToCents(it.unit_price, `item[${it.product_id}].unit_price`);
      const lineCents = it.line_total
        ? parseExactDecimalToCents(it.line_total, `item[${it.product_id}].line_total`)
        : priceCents * it.quantity;
      return {
        productId: it.product_id,
        name: it.product_name,
        quantity: it.quantity,
        unitPrice: Number(priceCents) / 100,
        lineTotal: Number(lineCents) / 100,
      };
    });

    const isSimulated = Boolean(orderRow.is_simulated);
    let captureId: string | undefined = undefined;
    let capturedAt: string | undefined = undefined;

    if (captureRow) {
      captureId = captureRow.external_capture_id;
      capturedAt = captureRow.captured_at ? new Date(captureRow.captured_at).toISOString() : undefined;
    } else if (isSimulated && mappedStatus === 'CAPTURED') {
      // For simulated orders, provide simulated capture reference without ledger contamination
      captureId = `CAP_${orderRow.external_order_id}`;
      capturedAt = orderRow.created_at ? new Date(orderRow.created_at).toISOString() : undefined;
    }

    return {
      orderId: orderRow.external_order_id,
      ticketId: orderRow.ticket_id,
      authorizedTotal: Number(totalCents) / 100,
      authorizedSubtotal: Number(subtotalCents) / 100,
      authorizedTax: Number(taxCents) / 100,
      authorizedShipping: Number(shippingCents) / 100,
      currency: orderRow.currency || 'USD',
      status: mappedStatus,
      approverName: orderRow.approver_name || '',
      approverDepartment: orderRow.approver_department || '',
      items: mappedItems,
      createdAt: orderRow.created_at ? new Date(orderRow.created_at).toISOString() : new Date().toISOString(),
      capturedAt,
      captureId,
      idempotencyKey: orderRow.idempotency_key,
      isSimulated,
    };
  }

  public async getOrder(sourceOrderId: string): Promise<StoredPayPalOrder | null> {
    return this.executeReadOnly(async (client) => {
      const orderRow = await this.resolvePostgresOrder(sourceOrderId, client);
      if (!orderRow) return null;

      // Eagerly assemble order line items
      const itemsRes = await client.query<any>(
        `SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC`,
        [orderRow.id]
      );

      // Query genuine capture from payment_captures
      const captureRes = await client.query<any>(
        `SELECT * FROM payment_captures WHERE order_id = $1`,
        [orderRow.id]
      );
      const captureRow = captureRes.rows[0] || null;

      return this.mapCompositeOrder(orderRow, itemsRes.rows, captureRow);
    });
  }

  public async getOrderByExternalId(externalOrderId: string): Promise<StoredPayPalOrder | null> {
    return this.executeReadOnly(async (client) => {
      const orderRow = await this.resolvePostgresOrder(externalOrderId, client);
      if (!orderRow) return null;

      // Eagerly assemble line items
      const itemsRes = await client.query<any>(
        `SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC`,
        [orderRow.id]
      );

      // Query genuine capture from payment_captures
      const captureRes = await client.query<any>(
        `SELECT * FROM payment_captures WHERE order_id = $1`,
        [orderRow.id]
      );
      const captureRow = captureRes.rows[0] || null;

      return this.mapCompositeOrder(orderRow, itemsRes.rows, captureRow);
    });
  }

  public async getOrderItems(sourceOrderId: string): Promise<ReadOnlyLineItem[] | null> {
    return this.executeReadOnly(async (client) => {
      const orderRow = await this.resolvePostgresOrder(sourceOrderId, client);
      if (!orderRow) return null;

      const itemsRes = await client.query<any>(
        `SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC`,
        [orderRow.id]
      );

      return itemsRes.rows.map((it) => {
        const priceCents = parseExactDecimalToCents(it.unit_price, `item[${it.product_id}].unit_price`);
        const lineCents = it.line_total
          ? parseExactDecimalToCents(it.line_total, `item[${it.product_id}].line_total`)
          : priceCents * it.quantity;
        return {
          productId: it.product_id,
          name: it.product_name,
          quantity: it.quantity,
          unitPrice: Number(priceCents) / 100,
          lineTotal: Number(lineCents) / 100,
        };
      });
    });
  }

  public async getCaptureInfo(sourceOrderId: string): Promise<OrderCaptureInfo | null> {
    return this.executeReadOnly(async (client) => {
      const orderRow = await this.resolvePostgresOrder(sourceOrderId, client);
      if (!orderRow) return null;

      const captureRes = await client.query<any>(
        `SELECT * FROM payment_captures WHERE order_id = $1`,
        [orderRow.id]
      );

      if (captureRes.rows.length > 0) {
        const cap = captureRes.rows[0];
        const cents = parseExactDecimalToCents(cap.captured_amount, `capture[${cap.external_capture_id}]`);
        return {
          orderId: orderRow.external_order_id,
          externalCaptureId: cap.external_capture_id,
          capturedAmount: (Number(cents) / 100).toFixed(2),
          capturedAmountCents: cents,
          currency: cap.currency || 'USD',
          captureOrigin: 'PAYPAL_API',
          isSimulated: false,
          capturedAt: cap.captured_at ? new Date(cap.captured_at).toISOString() : null,
        };
      }

      if (orderRow.is_simulated) {
        const cents = parseExactDecimalToCents(orderRow.authorized_total, `simOrder[${orderRow.external_order_id}]`);
        return {
          orderId: orderRow.external_order_id,
          externalCaptureId: `CAP_${orderRow.external_order_id}`,
          capturedAmount: (Number(cents) / 100).toFixed(2),
          capturedAmountCents: cents,
          currency: orderRow.currency || 'USD',
          captureOrigin: 'LOCAL_SYNTHETIC_TEST',
          isSimulated: true,
          capturedAt: orderRow.created_at ? new Date(orderRow.created_at).toISOString() : null,
        };
      }

      return null;
    });
  }
}

export const postgresOrderReadAdapter = new PostgresOrderReadAdapter();
