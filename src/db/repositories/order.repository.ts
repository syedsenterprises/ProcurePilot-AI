import { db } from '../pool';
import { DbOrder, DbOrderItem, OrderStatus } from './types';
import { validateOrderTransition } from '../order-state-machine';

export class OrderRepository {
  public async createDraftOrder(
    order: Omit<DbOrder, 'id' | 'created_at' | 'updated_at'>,
    items: Array<Omit<DbOrderItem, 'id' | 'order_id' | 'organization_id'>>
  ): Promise<DbOrder> {
    return db.withTransaction(async (client) => {
      const orderRes = await client.query<DbOrder>(
        `INSERT INTO orders (
          order_number, organization_id, ticket_id, external_order_id, provider,
          provider_environment, status, authorized_total, authorized_subtotal,
          authorized_tax, authorized_shipping, currency, approver_name,
          approver_department, idempotency_key, is_simulated, is_simulated_provenance,
          source_origin
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
        ) RETURNING *`,
        [
          order.order_number,
          order.organization_id,
          order.ticket_id,
          order.external_order_id || null,
          order.provider || 'PAYPAL',
          order.provider_environment || 'SANDBOX',
          order.status || 'DRAFT',
          order.authorized_total,
          order.authorized_subtotal,
          order.authorized_tax,
          order.authorized_shipping,
          order.currency || 'USD',
          order.approver_name || null,
          order.approver_department || null,
          order.idempotency_key,
          order.is_simulated !== undefined ? order.is_simulated : null,
          order.is_simulated_provenance || 'EXPLICIT_SOURCE',
          order.source_origin || 'ONLINE_CHECKOUT',
        ]
      );

      const createdOrder = orderRes.rows[0];

      for (const item of items) {
        await client.query(
          `INSERT INTO order_items (
            organization_id, order_id, product_id, product_name, quantity, unit_price, line_total
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            createdOrder.organization_id,
            createdOrder.id,
            item.product_id,
            item.product_name,
            item.quantity,
            item.unit_price,
            item.line_total,
          ]
        );
      }

      return createdOrder;
    });
  }

  public async bindExternalOrderId(
    id: string,
    externalOrderId: string,
    nextStatus: OrderStatus = 'PENDING_PAYMENT_APPROVAL'
  ): Promise<DbOrder> {
    const res = await db.query<DbOrder>(
      `UPDATE orders
       SET external_order_id = $1,
           status = $2,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [externalOrderId, nextStatus, id]
    );

    if (res.rows.length === 0) {
      throw new Error(`Order ${id} not found to bind externalOrderId.`);
    }

    return res.rows[0];
  }

  public async updateStatus(id: string, status: OrderStatus): Promise<DbOrder> {
    return db.withTransaction(async (client) => {
      const currentRes = await client.query<DbOrder>(
        'SELECT * FROM orders WHERE id = $1 FOR UPDATE',
        [id]
      );

      if (currentRes.rows.length === 0) {
        throw new Error(`Order ${id} not found to update status.`);
      }

      const currentOrder = currentRes.rows[0];
      validateOrderTransition(currentOrder.status, status);

      const res = await client.query<DbOrder>(
        `UPDATE orders
         SET status = $1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [status, id]
      );

      return res.rows[0];
    });
  }

  public async getById(id: string): Promise<DbOrder | null> {
    const res = await db.query<DbOrder>(
      'SELECT * FROM orders WHERE id = $1',
      [id]
    );
    return res.rows[0] || null;
  }

  public async getByExternalOrderId(externalOrderId: string): Promise<DbOrder | null> {
    const res = await db.query<DbOrder>(
      'SELECT * FROM orders WHERE external_order_id = $1',
      [externalOrderId]
    );
    return res.rows[0] || null;
  }

  public async getByTicketId(ticketId: string): Promise<DbOrder | null> {
    const res = await db.query<DbOrder>(
      'SELECT * FROM orders WHERE ticket_id = $1',
      [ticketId]
    );
    return res.rows[0] || null;
  }

  public async getOrderItems(orderId: string): Promise<DbOrderItem[]> {
    const res = await db.query<DbOrderItem>(
      'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC',
      [orderId]
    );
    return res.rows;
  }
}

export const orderRepository = new OrderRepository();
