import { db } from '../pool';
import { DbOrganization } from './types';

export class OrganizationRepository {
  public async getById(id: string): Promise<DbOrganization | null> {
    const res = await db.query<DbOrganization>(
      'SELECT * FROM organizations WHERE id = $1',
      [id]
    );
    return res.rows[0] || null;
  }

  public async getBySlug(slug: string): Promise<DbOrganization | null> {
    const res = await db.query<DbOrganization>(
      'SELECT * FROM organizations WHERE slug = $1',
      [slug]
    );
    return res.rows[0] || null;
  }

  public async getDefaultSeedOrganization(): Promise<DbOrganization> {
    const seedId = '00000000-0000-0000-0000-000000000001';
    const org = await this.getById(seedId);
    if (!org) {
      throw new Error('Database Inconsistency: Default seed organization not found. Has migration 001 been applied?');
    }
    return org;
  }
}

export const organizationRepository = new OrganizationRepository();
