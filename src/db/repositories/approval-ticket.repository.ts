import { db } from '../pool';
import { DbApprovalTicket, DbApprovalTicketItem } from './types';

export class ApprovalTicketRepository {
  public async createTicket(
    ticket: Omit<DbApprovalTicket, 'created_at' | 'source_origin' | 'integrity_status'> & {
      source_origin?: DbApprovalTicket['source_origin'];
      integrity_status?: DbApprovalTicket['integrity_status'];
    },
    items: Array<Omit<DbApprovalTicketItem, 'id' | 'ticket_id'>>
  ): Promise<DbApprovalTicket> {
    return db.withTransaction(async (client) => {
      const ticketRes = await client.query<DbApprovalTicket>(
        `INSERT INTO approval_tickets (
          ticket_id, organization_id, procurement_request_id, nonce, cart_fingerprint,
          challenge_signature, verified_subtotal, verified_tax, verified_shipping,
          verified_total, currency, status, session_token_hash, approver_name,
          approver_department, purchase_justification, identity_tier, expires_at,
          source_origin, integrity_status
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
        ) RETURNING *`,
        [
          ticket.ticket_id,
          ticket.organization_id,
          ticket.procurement_request_id || null,
          ticket.nonce,
          ticket.cart_fingerprint,
          ticket.challenge_signature || null,
          ticket.verified_subtotal,
          ticket.verified_tax,
          ticket.verified_shipping,
          ticket.verified_total,
          ticket.currency,
          ticket.status,
          ticket.session_token_hash || null,
          ticket.approver_name || null,
          ticket.approver_department || null,
          ticket.purchase_justification || null,
          ticket.identity_tier,
          ticket.expires_at,
          ticket.source_origin || 'RUNTIME',
          ticket.integrity_status || 'VERIFIED',
        ]
      );

      for (const item of items) {
        await client.query(
          `INSERT INTO approval_ticket_items (
            ticket_id, product_id, product_name, quantity, unit_price, line_total
          ) VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            ticket.ticket_id,
            item.product_id,
            item.product_name,
            item.quantity,
            item.unit_price,
            item.line_total,
          ]
        );
      }

      return ticketRes.rows[0];
    });
  }

  public async getTicket(ticketId: string): Promise<DbApprovalTicket | null> {
    const res = await db.query<DbApprovalTicket>(
      'SELECT * FROM approval_tickets WHERE ticket_id = $1',
      [ticketId]
    );
    return res.rows[0] || null;
  }

  public async getTicketItems(ticketId: string): Promise<DbApprovalTicketItem[]> {
    const res = await db.query<DbApprovalTicketItem>(
      'SELECT * FROM approval_ticket_items WHERE ticket_id = $1 ORDER BY id ASC',
      [ticketId]
    );
    return res.rows;
  }

  public async signTicket(params: {
    ticketId: string;
    approverName: string;
    approverDepartment: string;
    purchaseJustification: string;
    signedAt: Date;
  }): Promise<DbApprovalTicket> {
    const res = await db.query<DbApprovalTicket>(
      `UPDATE approval_tickets
       SET status = 'APPROVED',
           approver_name = $1,
           approver_department = $2,
           purchase_justification = $3,
           signed_at = $4
       WHERE ticket_id = $5 AND status = 'PENDING_APPROVAL'
       RETURNING *`,
      [
        params.approverName,
        params.approverDepartment,
        params.purchaseJustification,
        params.signedAt,
        params.ticketId,
      ]
    );

    if (res.rows.length === 0) {
      throw new Error(`Ticket ${params.ticketId} could not be signed (Ticket not found or status not PENDING_APPROVAL).`);
    }

    return res.rows[0];
  }

  public async consumeTicket(ticketId: string, consumedAt = new Date()): Promise<DbApprovalTicket> {
    const res = await db.query<DbApprovalTicket>(
      `UPDATE approval_tickets
       SET status = 'CONSUMED',
           consumed_at = $1
       WHERE ticket_id = $2 
         AND status = 'APPROVED'
         AND source_origin = 'RUNTIME'
         AND integrity_status = 'VERIFIED'
       RETURNING *`,
      [consumedAt, ticketId]
    );

    if (res.rows.length === 0) {
      throw new Error(`Ticket ${ticketId} could not be consumed (Ticket not found, not in status APPROVED, or not a verified runtime ticket).`);
    }

    return res.rows[0];
  }
}

export const approvalTicketRepository = new ApprovalTicketRepository();
