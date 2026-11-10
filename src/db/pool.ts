import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getDatabaseConfig, isDatabaseConfigured } from './config';

class DatabasePoolManager {
  private static instance: DatabasePoolManager;
  private pool: Pool | null = null;

  private constructor() {
    // Server-only runtime check
    if (typeof window !== 'undefined') {
      throw new Error('Security Violation: Database pool cannot be initialized in client-side bundle.');
    }
  }

  public static getInstance(): DatabasePoolManager {
    if (!DatabasePoolManager.instance) {
      DatabasePoolManager.instance = new DatabasePoolManager();
    }
    return DatabasePoolManager.instance;
  }

  public getPool(): Pool {
    if (!this.pool) {
      const config = getDatabaseConfig();

      const poolConfig = config.connectionString
        ? {
            connectionString: config.connectionString,
            ssl: config.ssl ? { rejectUnauthorized: false } : false,
            max: config.maxConnections,
            idleTimeoutMillis: config.idleTimeoutMillis,
            connectionTimeoutMillis: config.connectionTimeoutMillis,
          }
        : {
            host: config.host,
            port: config.port,
            database: config.database,
            user: config.user,
            password: config.password,
            ssl: config.ssl ? { rejectUnauthorized: false } : false,
            max: config.maxConnections,
            idleTimeoutMillis: config.idleTimeoutMillis,
            connectionTimeoutMillis: config.connectionTimeoutMillis,
          };

      this.pool = new Pool(poolConfig);

      this.pool.on('error', (err) => {
        // Unexpected errors on idle clients
        console.error('CRITICAL: Unexpected PostgreSQL idle client error:', err.message);
      });
    }

    return this.pool;
  }

  public async query<R extends QueryResultRow = any, I extends any[] = any[]>(
    text: string,
    params?: I
  ): Promise<QueryResult<R>> {
    const pool = this.getPool();
    return pool.query<R>(text, params);
  }

  public async withTransaction<T>(
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const pool = this.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

export const db = DatabasePoolManager.getInstance();
export { isDatabaseConfigured };
