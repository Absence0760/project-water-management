// Migrate Lambda — the production counterpart of `pnpm db:migrate`.
//
// Invoked by .github/workflows/deploy-backend.yml before new API code ships
// (and by the operator after rotating db_app_password). It:
//   1. reads the RDS-managed master credentials (the schema owner, `water`)
//      from Secrets Manager — RDS rotates them, so they are fetched per run;
//   2. ensures the RLS-bound runtime role `water_app` exists with LOGIN and
//      the password from WATER_APP_PASSWORD (sops `db_app_password`, via
//      Terraform), and verifies it is NOSUPERUSER NOBYPASSRLS. The password
//      is sent as a SCRAM-SHA-256 verifier computed here, so plaintext never
//      reaches the server or its logs;
//   3. applies backend/migrations/*.sql through scripts/migrate.ts as the owner.
//
// Packaging (infra/scripts/package-lambdas.sh): the bundle sits at
// dist/lambda-migrate.mjs next to migrations/, because migrate.ts resolves
// `<dirname>/../migrations`. TLS to RDS is verified against the CA bundle at
// NODE_EXTRA_CA_CERTS. The returned payload lists applied migration names
// only — never credentials.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import pg from 'pg';
import { assertLambdaEnv } from './config/production.js';
import { migrate } from '../scripts/migrate.js';

// Refuse to start without its settings (config/production.ts).
assertLambdaEnv('migrate');

interface MasterSecret {
	username: string;
	password: string;
}

export interface MigrateResult {
	applied: string[];
	appRole: 'created' | 'updated';
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`${name} is not set`);
	return v;
}

async function readMasterSecret(secretArn: string): Promise<MasterSecret> {
	// The AWS SDK v3 ships inside the nodejs24.x runtime; importing it through a
	// variable keeps esbuild from bundling it and tsc from needing its types
	// (no new dependency in backend/package.json).
	const sdk = '@aws-sdk/client-secrets-manager';
	const { SecretsManagerClient, GetSecretValueCommand } = await import(sdk);
	const client = new SecretsManagerClient({});
	const out = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
	const parsed = JSON.parse(String(out.SecretString ?? '')) as Partial<MasterSecret>;
	if (!parsed.username || !parsed.password) throw new Error('master secret is missing username/password');
	return { username: parsed.username, password: parsed.password };
}

/**
 * A PostgreSQL SCRAM-SHA-256 password verifier (the format pg_authid stores).
 * Passing this to CREATE/ALTER ROLE ... PASSWORD sets the password without the
 * plaintext ever leaving this process. The password must be ASCII (Terraform
 * enforces alphanumeric), so SASLprep is the identity.
 */
export function scramSha256Verifier(password: string, salt = randomBytes(16), iterations = 4096): string {
	const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
	const clientKey = createHmac('sha256', salted).update('Client Key').digest();
	const storedKey = createHash('sha256').update(clientKey).digest();
	const serverKey = createHmac('sha256', salted).update('Server Key').digest();
	return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

function ownerUrl(secret: MasterSecret): string {
	const host = requireEnv('DB_HOST');
	const port = process.env.DB_PORT ?? '5432';
	const db = requireEnv('DB_NAME');
	const user = encodeURIComponent(secret.username);
	const pass = encodeURIComponent(secret.password);
	return `postgresql://${user}:${pass}@${host}:${port}/${db}?sslmode=verify-full`;
}

/**
 * Create or re-password water_app, then verify the attributes RLS relies on.
 *
 * Only LOGIN + PASSWORD are specified: on RDS the owner is rds_superuser, not
 * a true superuser, and PostgreSQL 16+ refuses to let a non-superuser *mention*
 * SUPERUSER / REPLICATION / BYPASSRLS in ALTER ROLE — even as NO…. The
 * defaults for a new role are already NO for all of them, and the check below
 * fails the deploy if anything ever changed that.
 */
async function syncAppRole(url: string, appPassword: string): Promise<MigrateResult['appRole']> {
	if (!/^[A-Za-z0-9]{24,}$/.test(appPassword)) {
		throw new Error('WATER_APP_PASSWORD must be 24+ alphanumeric characters');
	}
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const verifier = client.escapeLiteral(scramSha256Verifier(appPassword));
		const exists = (await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'water_app'")).rowCount === 1;
		await client.query(`${exists ? 'ALTER' : 'CREATE'} ROLE water_app WITH LOGIN PASSWORD ${verifier}`);
		const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; rolreplication: boolean; rolcreaterole: boolean }>(
			"SELECT rolsuper, rolbypassrls, rolreplication, rolcreaterole FROM pg_roles WHERE rolname = 'water_app'"
		);
		const r = rows[0];
		if (!r || r.rolsuper || r.rolbypassrls || r.rolreplication || r.rolcreaterole) {
			throw new Error('water_app has a privileged attribute (SUPERUSER/BYPASSRLS/REPLICATION/CREATEROLE) — refusing to continue');
		}
		return exists ? 'updated' : 'created';
	} finally {
		await client.end();
	}
}

export async function handler(): Promise<MigrateResult> {
	const secret = await readMasterSecret(requireEnv('MASTER_SECRET_ARN'));
	const url = ownerUrl(secret);
	// Role first: 001_init's guard then skips its NOLOGIN placeholder, and the
	// GRANTs in the migrations land on the real login role.
	const appRole = await syncAppRole(url, requireEnv('WATER_APP_PASSWORD'));
	const applied = await migrate(url, (msg) => console.log(msg));
	console.log(applied.length ? `${applied.length} migration(s) applied` : 'schema up to date');
	return { applied, appRole };
}
