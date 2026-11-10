import { z } from 'zod';

export const DatabaseConfigSchema = z.object({
  connectionString: z.string().optional(),
  host: z.string().default('localhost'),
  port: z.coerce.number().int().positive().default(5432),
  database: z.string().default('procurepilot'),
  user: z.string().default('procurepilot_app'),
  password: z.string().optional(),
  ssl: z.boolean().default(false),
  maxConnections: z.coerce.number().int().positive().default(20),
  idleTimeoutMillis: z.coerce.number().int().nonnegative().default(30000),
  connectionTimeoutMillis: z.coerce.number().int().nonnegative().default(5000),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

export function getDatabaseConfig(): DatabaseConfig {
  // Prevent execution in client-side bundles
  if (typeof window !== 'undefined') {
    throw new Error('Security Violation: Database configuration cannot be accessed on the client side.');
  }

  const rawConfig = {
    connectionString: process.env.DATABASE_URL,
    host: process.env.PGHOST || 'localhost',
    port: process.env.PGPORT ? parseInt(process.env.PGPORT, 10) : 5432,
    database: process.env.PGDATABASE || 'procurepilot',
    user: process.env.PGUSER || 'procurepilot_app',
    password: process.env.PGPASSWORD,
    ssl: process.env.PGSSL === 'true' || process.env.NODE_ENV === 'production',
    maxConnections: process.env.PGMAXCONNECTIONS ? parseInt(process.env.PGMAXCONNECTIONS, 10) : 20,
    idleTimeoutMillis: process.env.PGIDLETIMEOUT ? parseInt(process.env.PGIDLETIMEOUT, 10) : 30000,
    connectionTimeoutMillis: process.env.PGCONNECTTIMEOUT ? parseInt(process.env.PGCONNECTTIMEOUT, 10) : 5000,
  };

  return DatabaseConfigSchema.parse(rawConfig);
}

export function isDatabaseConfigured(): boolean {
  return Boolean(
    process.env.DATABASE_URL ||
    (process.env.PGHOST && process.env.PGDATABASE && process.env.PGUSER)
  );
}
