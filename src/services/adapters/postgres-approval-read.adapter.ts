import { Pool, PoolClient } from 'pg';
import { db } from '@/db/pool';
import { parseExactDecimalToCents } from '@/db/legacy-preflight';
import { ApprovalChallengeState, VerifiedItemSummary } from '../approval/approval.service';
import { IApprovalReadStore, TicketStatusInfo, ReadOnlyLineItem } from './read-store.interface';

/**
 * PostgreSQL read-only approval adapter.
 * Connects to the persistent PostgreSQL store under strict read-only execution boundaries.
 * Preserves historical provenance (UNVERIFIABLE_LEGACY), never manufactures HMAC signatures,
 * and eagerly assembles verified approval line items.
 */
export class PostgresApprovalReadAdapter implements IApprovalReadStore {
  private customPool?: Pool;

  constructor(options?: { pool?: Pool }) {
    this.customPool = options?.pool;
  }

  private getPool(): Pool {
    return this.customPool || db.getPool();
  }

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
        // Ignore rollback failure
      }
      throw err;
    } finally {
      client.release();
    }
  }

  public async getChallenge(ticketId: string): Promise<ApprovalChallengeState | null> {
    return this.executeReadOnly(async (client) => {
      const ticketRes = await client.query<any>(
        `SELECT * FROM approval_tickets WHERE ticket_id = $1`,
        [ticketId]
      );

      if (ticketRes.rows.length === 0) {
        return null;
      }

      const row = ticketRes.rows[0];

      // Eagerly assemble verified items
      const itemsRes = await client.query<any>(
        `SELECT * FROM approval_ticket_items WHERE ticket_id = $1 ORDER BY id ASC`,
        [ticketId]
      );

      const totalCents = parseExactDecimalToCents(row.verified_total, `ticket[${ticketId}].verified_total`);
      const subtotalCents = row.verified_subtotal
        ? parseExactDecimalToCents(row.verified_subtotal, `ticket[${ticketId}].verified_subtotal`)
        : totalCents;
      const taxCents = row.verified_tax
        ? parseExactDecimalToCents(row.verified_tax, `ticket[${ticketId}].verified_tax`)
        : 0;
      const shippingCents = row.verified_shipping
        ? parseExactDecimalToCents(row.verified_shipping, `ticket[${ticketId}].verified_shipping`)
        : 0;

      const mappedItems: VerifiedItemSummary[] = itemsRes.rows.map((it: any) => {
        const priceCents = parseExactDecimalToCents(it.unit_price, `ticketItem[${it.product_id}].unit_price`);
        const lineCents = it.line_total
          ? parseExactDecimalToCents(it.line_total, `ticketItem[${it.product_id}].line_total`)
          : priceCents * it.quantity;
        return {
          productId: it.product_id,
          name: it.product_name,
          quantity: it.quantity,
          unitPrice: Number(priceCents) / 100,
          lineTotal: Number(lineCents) / 100,
        };
      });

      let signoffObj: any = undefined;
      if (row.approver_name) {
        signoffObj = {
          userName: row.approver_name,
          department: row.approver_department || '',
          purchaseJustification: row.purchase_justification || '',
          signedAt: row.signed_at ? new Date(row.signed_at).toISOString() : new Date().toISOString(),
          identityTier: (row.identity_tier as 'SELF_ATTESTED_REQUISITIONER') || 'SELF_ATTESTED_REQUISITIONER',
        };
      }

      return {
        ticketId: row.ticket_id,
        cartFingerprint: row.cart_fingerprint,
        nonce: row.nonce,
        currency: (row.currency || 'USD') as 'USD',
        createdAt: row.created_at ? new Date(row.created_at).getTime() : Date.now(),
        expiresAt: new Date(row.expires_at).getTime(),
        status: row.status,
        verifiedTotal: Number(totalCents) / 100,
        verifiedSubtotal: Number(subtotalCents) / 100,
        verifiedTax: Number(taxCents) / 100,
        verifiedShipping: Number(shippingCents) / 100,
        verifiedItems: mappedItems,
        signoff: signoffObj,
        consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : undefined,
        sourceOrigin: row.source_origin || 'RUNTIME',
        integrityStatus: row.integrity_status || 'VERIFIED',
      };
    });
  }

  public async getTicketStatus(ticketId: string): Promise<TicketStatusInfo | null> {
    return this.executeReadOnly(async (client) => {
      const res = await client.query<any>(
        `SELECT ticket_id, status, integrity_status, source_origin, challenge_signature 
         FROM approval_tickets WHERE ticket_id = $1`,
        [ticketId]
      );

      if (res.rows.length === 0) return null;
      const row = res.rows[0];

      const isVerifiable = row.integrity_status === 'VERIFIED' && Boolean(row.challenge_signature);

      return {
        ticketId: row.ticket_id,
        status: row.status,
        integrityStatus: row.integrity_status,
        sourceOrigin: row.source_origin,
        isVerifiable,
      };
    });
  }

  public async getTicketItems(ticketId: string): Promise<ReadOnlyLineItem[] | null> {
    return this.executeReadOnly(async (client) => {
      const existsRes = await client.query<any>(
        `SELECT 1 FROM approval_tickets WHERE ticket_id = $1`,
        [ticketId]
      );
      if (existsRes.rows.length === 0) return null;

      const itemsRes = await client.query<any>(
        `SELECT * FROM approval_ticket_items WHERE ticket_id = $1 ORDER BY id ASC`,
        [ticketId]
      );

      return itemsRes.rows.map((it: any) => {
        const priceCents = parseExactDecimalToCents(it.unit_price, `ticketItem[${it.product_id}].unit_price`);
        const lineCents = it.line_total
          ? parseExactDecimalToCents(it.line_total, `ticketItem[${it.product_id}].line_total`)
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
}

export const postgresApprovalReadAdapter = new PostgresApprovalReadAdapter();
