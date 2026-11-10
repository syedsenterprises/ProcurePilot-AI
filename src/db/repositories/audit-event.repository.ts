import { db } from '../pool';
import { DbAuditEvent } from './types';

export class AuditEventRepository {
  public async logEvent(params: {
    event_type: string;
    severity: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';
    message: string;
    session_id?: string | null;
    ip_address?: string | null;
    details?: Record<string, unknown> | null;
  }): Promise<DbAuditEvent> {
    const res = await db.query<DbAuditEvent>(
      `INSERT INTO audit_events (
        event_type, severity, message, session_id, ip_address, details, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *`,
      [
        params.event_type,
        params.severity,
        params.message,
        params.session_id || null,
        params.ip_address || null,
        params.details ? JSON.stringify(params.details) : null,
      ]
    );
    return res.rows[0];
  }

  public async getRecentEvents(limit = 100): Promise<DbAuditEvent[]> {
    const res = await db.query<DbAuditEvent>(
      'SELECT * FROM audit_events ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    return res.rows;
  }
}

export const auditEventRepository = new AuditEventRepository();
