import { Client } from 'pg';
import crypto from 'crypto';

interface DbInitConfig {
  host: string;
  port: number;
  user: string;
  password?: string;
  targetDatabase: string;
}

function getOperatorConfig(): DbInitConfig {
  const host = process.env.PGHOST || 'localhost';
  const port = parseInt(process.env.PGPORT || '5432', 10);
  const user = process.env.PGUSER || 'postgres';
  const password = process.env.PGPASSWORD;
  const targetDatabase = process.env.TARGET_DATABASE || 'procurepilot';

  // Strict host validation: local instance only
  const allowedHosts = ['localhost', '127.0.0.1', '::1'];
  if (!allowedHosts.includes(host.toLowerCase())) {
    throw new Error(
      `Security Violation: Provisioning is restricted to localhost/127.0.0.1. Supplied host was "${host}".`
    );
  }

  // Strict database name validation: procurepilot only
  if (targetDatabase !== 'procurepilot') {
    throw new Error(
      `Safety Violation: Target database must be "procurepilot". Supplied target was "${targetDatabase}".`
    );
  }

  return { host, port, user, password, targetDatabase };
}

export async function provisionDatabase(): Promise<{
  created: boolean;
  database: string;
  host: string;
  port: number;
}> {
  const config = getOperatorConfig();

  console.log('================================================================');
  console.log('ProcurePilot AI — Dedicated Persistent PostgreSQL Target Provisioning');
  console.log('================================================================');
  console.log(`Target Database: ${config.targetDatabase}`);
  console.log(`Target Host:     ${config.host}:${config.port}`);
  console.log(`Operator User:   ${config.user}`);
  console.log('----------------------------------------------------------------');

  // Connect to maintenance database 'postgres'
  const maintenanceClient = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: 'postgres',
  });

  try {
    await maintenanceClient.connect();
  } catch (err: any) {
    throw new Error(`Failed to connect to PostgreSQL maintenance database: ${err.message}`);
  }

  try {
    // 1. Verify target database absence (FAIL CLOSED if already exists)
    const checkDbRes = await maintenanceClient.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = $1',
      [config.targetDatabase]
    );

    if (checkDbRes.rows.length > 0) {
      throw new Error(
        `Safety Invariant Violated: Target database "${config.targetDatabase}" already exists. ` +
        `Refusing to drop, overwrite, or recreate an existing database.`
      );
    }

    // 2. Verify application role exists and is NOT superuser
    const checkAppRole = await maintenanceClient.query<{
      rolname: string;
      rolsuper: boolean;
      rolcanlogin: boolean;
    }>(
      'SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = $1',
      ['procurepilot_app']
    );

    if (checkAppRole.rows.length === 0) {
      throw new Error(
        `Configuration Error: Application role "procurepilot_app" does not exist in PostgreSQL cluster. ` +
        `Please provision the role before initializing the database.`
      );
    }

    const appRole = checkAppRole.rows[0];
    if (appRole.rolsuper) {
      throw new Error(
        `Least Privilege Violation: Application role "procurepilot_app" has superuser privileges. ` +
        `Superuser privileges must never be granted to application runtime roles.`
      );
    }

    // 3. Create the dedicated persistent database with UTF8 encoding
    console.log(`Provisioning persistent database "${config.targetDatabase}"...`);
    // Safe database creation without string interpolation of unvalidated input
    await maintenanceClient.query(`CREATE DATABASE "${config.targetDatabase}" ENCODING 'UTF8'`);
    console.log(`  ✓ Successfully created database "${config.targetDatabase}" (ENCODING: UTF8)`);

    // 4. Grant connect privilege to procurepilot_app
    await maintenanceClient.query(
      `GRANT CONNECT ON DATABASE "${config.targetDatabase}" TO procurepilot_app`
    );
    console.log(`  ✓ Granted CONNECT on "${config.targetDatabase}" to role "procurepilot_app"`);

    return {
      created: true,
      database: config.targetDatabase,
      host: config.host,
      port: config.port,
    };
  } finally {
    await maintenanceClient.end();
  }
}

// CLI Execution Entrypoint
if (require.main === module) {
  provisionDatabase()
    .then((result) => {
      console.log('----------------------------------------------------------------');
      console.log(`🎉 Provisioning successful: Database "${result.database}" is ready.`);
      console.log('================================================================');
      process.exit(0);
    })
    .catch((err) => {
      console.error('\n❌ Provisioning Failed:', err.message);
      process.exit(1);
    });
}
