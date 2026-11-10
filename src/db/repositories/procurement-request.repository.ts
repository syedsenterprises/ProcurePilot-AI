import { db } from '../pool';
import { DbProcurementRequest } from './types';

export class ProcurementRequestRepository {
  public async create(params: {
    organization_id: string;
    session_token_hash?: string | null;
    department?: string | null;
    user_query: string;
    extracted_budget?: number | null;
  }): Promise<DbProcurementRequest> {
    const res = await db.query<DbProcurementRequest>(
      `INSERT INTO procurement_requests (
        organization_id, session_token_hash, department, user_query, extracted_budget, status
      ) VALUES ($1, $2, $3, $4, $5, 'DRAFT')
      RETURNING *`,
      [
        params.organization_id,
        params.session_token_hash || null,
        params.department || null,
        params.user_query,
        params.extracted_budget !== undefined ? params.extracted_budget : null,
      ]
    );
    return res.rows[0];
  }

  public async getById(id: string): Promise<DbProcurementRequest | null> {
    const res = await db.query<DbProcurementRequest>(
      'SELECT * FROM procurement_requests WHERE id = $1',
      [id]
    );
    return res.rows[0] || null;
  }
}

export const procurementRequestRepository = new ProcurementRequestRepository();
