import { db } from '../pool';
import { DbWebhookEvent, DbWebhookTransmission } from './types';

export class WebhookRepository {
  /**
   * Atomic Webhook Transmission Ingestion
   * Model B: One record per unique provider transmission_id with atomic delivery counter.
   * If same transmission arrives with identical payload fingerprint: increments counter.
   * If same transmission arrives with conflicting fingerprint: raises anomaly.
   */
  public async recordTransmission(params: {
    transmission_id: string;
    event_id?: string | null;
    raw_body_text: string;
    payload_sha256: string;
    auth_algo?: string | null;
    cert_url?: string | null;
    transmission_sig?: string | null;
    transmission_time?: Date | null;
    verification_status: 'VERIFIED' | 'FAILED' | 'SIMULATED';
    http_status_returned: number;
  }): Promise<{
    transmission: DbWebhookTransmission;
    isDuplicate: boolean;
    isTampered: boolean;
  }> {
    // 1. Check existing transmission by transmission_id
    const existingRes = await db.query<DbWebhookTransmission>(
      'SELECT * FROM webhook_transmissions WHERE transmission_id = $1',
      [params.transmission_id]
    );

    if (existingRes.rows.length > 0) {
      const existing = existingRes.rows[0];

      // Fingerprint Tamper Detection
      if (existing.payload_sha256 !== params.payload_sha256) {
        return {
          transmission: existing,
          isDuplicate: true,
          isTampered: true,
        };
      }

      // Safe duplicate delivery: increment delivery_attempt_number
      const updateRes = await db.query<DbWebhookTransmission>(
        `UPDATE webhook_transmissions
         SET delivery_attempt_number = delivery_attempt_number + 1,
             last_delivery_at = NOW()
         WHERE transmission_id = $1
         RETURNING *`,
        [params.transmission_id]
      );

      return {
        transmission: updateRes.rows[0],
        isDuplicate: true,
        isTampered: false,
      };
    }

    // 2. Insert new transmission record
    const insertRes = await db.query<DbWebhookTransmission>(
      `INSERT INTO webhook_transmissions (
        transmission_id, event_id, delivery_attempt_number, raw_body_text,
        payload_sha256, auth_algo, cert_url, transmission_sig, transmission_time,
        verification_status, http_status_returned, first_received_at, last_delivery_at
      ) VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
      RETURNING *`,
      [
        params.transmission_id,
        params.event_id || null,
        params.raw_body_text,
        params.payload_sha256,
        params.auth_algo || null,
        params.cert_url || null,
        params.transmission_sig || null,
        params.transmission_time || null,
        params.verification_status,
        params.http_status_returned,
      ]
    );

    return {
      transmission: insertRes.rows[0],
      isDuplicate: false,
      isTampered: false,
    };
  }

  /**
   * Canonical Verified Event Ingestion
   * Inserted ONLY after signature verification succeeds.
   */
  public async recordVerifiedEvent(event: {
    id: string;
    event_type: string;
    resource_type: string;
    resource_id?: string | null;
    payload_sha256: string;
    raw_payload: Record<string, unknown>;
  }): Promise<{ event: DbWebhookEvent; isNew: boolean; isTampered: boolean }> {
    const existing = await this.getEventById(event.id);
    if (existing) {
      if (existing.payload_sha256 !== event.payload_sha256) {
        // Tamper anomaly: Flag event but DO NOT overwrite canonical payload
        await db.query(
          'UPDATE webhook_events SET tamper_flag = TRUE WHERE id = $1',
          [event.id]
        );
        return { event: existing, isNew: false, isTampered: true };
      }
      return { event: existing, isNew: false, isTampered: false };
    }

    const insertRes = await db.query<DbWebhookEvent>(
      `INSERT INTO webhook_events (
        id, event_type, resource_type, resource_id, payload_sha256,
        raw_payload, processing_status, processing_attempts, max_processing_attempts,
        tamper_flag, first_received_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'RECEIVED', 0, 5, FALSE, NOW())
      RETURNING *`,
      [
        event.id,
        event.event_type,
        event.resource_type,
        event.resource_id || null,
        event.payload_sha256,
        JSON.stringify(event.raw_payload),
      ]
    );

    return { event: insertRes.rows[0], isNew: true, isTampered: false };
  }

  public async getEventById(id: string): Promise<DbWebhookEvent | null> {
    const res = await db.query<DbWebhookEvent>(
      'SELECT * FROM webhook_events WHERE id = $1',
      [id]
    );
    return res.rows[0] || null;
  }

  public async updateProcessingStatus(
    id: string,
    status: DbWebhookEvent['processing_status'],
    errorMessage?: string
  ): Promise<DbWebhookEvent> {
    const res = await db.query<DbWebhookEvent>(
      `UPDATE webhook_events
       SET processing_status = $1,
           processing_attempts = processing_attempts + 1,
           last_error_message = COALESCE($2, last_error_message),
           processed_at = CASE WHEN $1 = 'PROCESSED' THEN NOW() ELSE processed_at END
       WHERE id = $3
       RETURNING *`,
      [status, errorMessage || null, id]
    );

    if (res.rows.length === 0) {
      throw new Error(`Webhook event ${id} not found.`);
    }

    return res.rows[0];
  }
}

export const webhookRepository = new WebhookRepository();
