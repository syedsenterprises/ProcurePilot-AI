import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { PoolClient } from 'pg';
import { db, isDatabaseConfigured } from './pool';

export interface MigrationFile {
  version: string;
  name: string;
  filePath: string;
  checksum: string;
  sql: string;
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
}

export interface MigrationStatus {
  version: string;
  name: string;
  applied: boolean;
  appliedAt?: Date;
  checksumMatches?: boolean;
}

const MIGRATION_ADVISORY_LOCK_ID = 83921049281; // 64-bit int safe advisory lock ID

export class MigrationEngine {
  private readonly migrationsDir: string;

  constructor(migrationsDir?: string) {
    this.migrationsDir =
      migrationsDir || path.resolve(process.cwd(), 'src', 'db', 'migrations');
  }

  public getMigrationFiles(): MigrationFile[] {
    if (!fs.existsSync(this.migrationsDir)) {
      return [];
    }

    const files = fs
      .readdirSync(this.migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    return files.map((file) => {
      const filePath = path.join(this.migrationsDir, file);
      const rawSql = fs.readFileSync(filePath, 'utf8');
      // Normalize line breaks (\r\n -> \n) for deterministic cross-OS checksum calculation
      const normalizedSql = rawSql.replace(/\r\n/g, '\n');
      const checksum = crypto
        .createHash('sha256')
        .update(normalizedSql, 'utf8')
        .digest('hex');

      const parts = file.split('_');
      const version = parts[0];
      const name = parts.slice(1).join('_').replace('.sql', '');

      return {
        version,
        name,
        filePath,
        checksum,
        sql: rawSql,
      };
    });
  }

  public async initMigrationTracking(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  public async getAppliedMigrations(client: PoolClient): Promise<AppliedMigration[]> {
    await this.initMigrationTracking(client);
    const res = await client.query<AppliedMigration>(`
      SELECT version, name, checksum, applied_at
      FROM schema_migrations
      ORDER BY version ASC;
    `);
    return res.rows;
  }

  public async getStatus(): Promise<MigrationStatus[]> {
    if (!isDatabaseConfigured()) {
      throw new Error('Database is not configured. Set DATABASE_URL or PG* environment variables.');
    }

    const pool = db.getPool();
    const client = await pool.connect();

    try {
      const diskFiles = this.getMigrationFiles();
      const applied = await this.getAppliedMigrations(client);
      const appliedMap = new Map(applied.map((m) => [m.version, m]));

      return diskFiles.map((f) => {
        const app = appliedMap.get(f.version);
        if (!app) {
          return {
            version: f.version,
            name: f.name,
            applied: false,
          };
        }
        return {
          version: f.version,
          name: f.name,
          applied: true,
          appliedAt: app.applied_at,
          checksumMatches: app.checksum === f.checksum,
        };
      });
    } finally {
      client.release();
    }
  }

  public async run(): Promise<{ appliedCount: number; versions: string[] }> {
    if (!isDatabaseConfigured()) {
      throw new Error('Database is not configured. Set DATABASE_URL or PG* environment variables.');
    }

    const pool = db.getPool();
    const client = await pool.connect();

    try {
      // 1. Acquire exclusive PostgreSQL session-level advisory lock
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_ID]);

      try {
        await this.initMigrationTracking(client);
        const diskFiles = this.getMigrationFiles();
        const applied = await this.getAppliedMigrations(client);
        const appliedMap = new Map(applied.map((m) => [m.version, m]));

        // 2. Validate historical checksum integrity
        for (const diskFile of diskFiles) {
          const app = appliedMap.get(diskFile.version);
          if (app && app.checksum !== diskFile.checksum) {
            throw new Error(
              `Migration Integrity Violation: Migration ${diskFile.version}_${diskFile.name} was already applied ` +
                `with checksum ${app.checksum}, but on-disk file checksum is ${diskFile.checksum}. Historical migrations must never be altered.`
            );
          }
        }

        // 3. Identify and apply pending migrations in strict version order
        const pending = diskFiles.filter((f) => !appliedMap.has(f.version));
        const appliedVersions: string[] = [];

        for (const migration of pending) {
          console.log(`Applying migration ${migration.version}_${migration.name}...`);

          await client.query('BEGIN');
          try {
            await client.query(migration.sql);
            await client.query(
              `INSERT INTO schema_migrations (version, name, checksum, applied_at)
               VALUES ($1, $2, $3, NOW());`,
              [migration.version, migration.name, migration.checksum]
            );
            await client.query('COMMIT');
            appliedVersions.push(migration.version);
            console.log(`  ✓ Successfully applied ${migration.version}_${migration.name}`);
          } catch (error) {
            await client.query('ROLLBACK');
            console.error(`  ✗ Migration ${migration.version}_${migration.name} failed:`, error);
            throw error;
          }
        }

        return {
          appliedCount: appliedVersions.length,
          versions: appliedVersions,
        };
      } finally {
        // Release advisory lock
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_ID]);
      }
    } finally {
      client.release();
    }
  }
}

export const migrator = new MigrationEngine();

// CLI Entrypoint
if (require.main === module) {
  const command = process.argv[2] || 'status';

  (async () => {
    try {
      if (command === 'run') {
        const result = await migrator.run();
        console.log(`Migration complete. ${result.appliedCount} migrations applied.`);
        process.exit(0);
      } else if (command === 'status') {
        const statuses = await migrator.getStatus();
        console.log('------------------------------------------------------------');
        console.log('ProcurePilot AI — PostgreSQL Migration Status');
        console.log('------------------------------------------------------------');
        for (const s of statuses) {
          const statusText = s.applied
            ? `APPLIED (${s.appliedAt?.toISOString()}) [${s.checksumMatches ? 'CHECKSUM OK' : 'CHECKSUM MISMATCH'}]`
            : 'PENDING';
          console.log(`${s.version}_${s.name.padEnd(30)} : ${statusText}`);
        }
        console.log('------------------------------------------------------------');
        process.exit(0);
      } else {
        console.error(`Unknown command "${command}". Use "run" or "status".`);
        process.exit(1);
      }
    } catch (err) {
      console.error('Migration operation failed:', err);
      process.exit(1);
    }
  })();
}
