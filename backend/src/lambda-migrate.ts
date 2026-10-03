// Migrate Lambda — the production counterpart of `pnpm db:migrate`.
//
// Invoked by .github/workflows/deploy-backend.yml before new API code ships
// (and by the operator after rotating db_app_password). It:
//   1. reads the RDS-managed master credentials (the schema owner, `water`)
//      from Secrets Manager — RDS rotates them, so they are fetched per run;
//   2. ensures the RLS-bound runtime role `water_app` exists with LOGIN and
//      the password from WATER_APP_PASSWORD (sops `db_app_password`, via
//      Terraform into this Lambda's runtime secret, loaded at cold start by
//      config/runtimeSecrets.ts), and verifies it is NOSUPERUSER NOBYPASSRLS. The password
//      is sent as a SCRAM-SHA-256 verifier computed here, so plaintext never
//      reaches the server or its logs;
//   3. applies backend/migrations/*.sql through scripts/migrate.ts as the owner.
//
// Packaging (infra/scripts/package-lambdas.sh): the bundle sits at
// dist/lambda-migrate.mjs next to migrations/, because migrate.ts resolves
// `<dirname>/../migrations`. TLS to RDS is verified against the CA bundle at
// NODE_EXTRA_CA_CERTS. The returned payload lists applied migration names
// only — never credentials.
//
// It also loads the map's reference datasets in production (docs/deployment.md
// § Reference datasets): an event `{ "load": { kind, key, sha256, dataset,
// source?, minOrder? } }` (from .github/workflows/load-reference.yml) runs no
// migration and no role sync; it reads one file from the private reference
// bucket (REFERENCE_BUCKET, through the S3 endpoint), checks it against the
// SHA-256 the operator gave, and replaces that dataset as the owner
// (geo/referenceLoad.ts, which refuses every kind docs/maps.md § Sources
// doesn't mark allowed). It answers with counts only.
//
// The deploy workflow's logs are public (the repo is), so a failure's
// payload is a summary too: a stable code, migration names and where the
// detail is. The detail itself (Postgres's error text, which can quote SQL or
// data) goes to this function's CloudWatch log only (failureSummary).
import type { Context } from 'aws-lambda';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import pg from 'pg';
import { assertLambdaEnv } from './config/production.js';
import { loadRuntimeSecrets } from './config/runtimeSecrets.js';
import { getSecretString } from './config/secretsManager.js';
import { migrate, MigrateError, type MigrateErrorCode } from '../scripts/migrate.js';
import { LoadError, loadReferenceText, parseLoadRequest, readReferenceText, type LoadErrorCode, type LoadResult, type ReadObject } from './geo/referenceLoad.js';

// Its runtime secret (the water_app password) once per cold start
// (config/runtimeSecrets.ts), then refuse to start without its settings
// (config/production.ts). A rotation writes a new secret version, which changes
// RUNTIME_SECRET_VERSION and so cold-starts this Lambda onto it.
await loadRuntimeSecrets('migrate');
assertLambdaEnv('migrate');

interface MasterSecret {
	username: string;
	password: string;
}

export interface MigrateResult {
	applied: string[];
	appRole: 'created' | 'updated';
}

/**
 * What a failed run returns (as the thrown error's message, JSON), which the
 * deploy workflow prints to its public log. Names and codes only: never an
 * error message. `setup_failed` is anything before or around the migrations
 * themselves (reading the secret, connecting, the water_app role).
 */
export interface MigrateFailure {
	code: MigrateErrorCode | 'setup_failed';
	migrations: string[];
	applied: string[];
	pending: string[];
	logGroup: string | null;
	logStream: string | null;
	requestId: string | null;
}

type LogContext = Pick<Context, 'logGroupName' | 'logStreamName' | 'awsRequestId'>;

export function failureSummary(err: unknown, context?: LogContext): MigrateFailure {
	const m = err instanceof MigrateError ? err : null;
	return {
		code: m?.code ?? 'setup_failed',
		migrations: m?.migrations ?? [],
		applied: m?.applied ?? [],
		pending: m?.pending ?? [],
		logGroup: context?.logGroupName ?? null,
		logStream: context?.logStreamName ?? null,
		requestId: context?.awsRequestId ?? null
	};
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`${name} is not set`);
	return v;
}

async function readMasterSecret(secretArn: string): Promise<MasterSecret> {
	// The runtime's SDK (config/secretsManager.ts). Not JSON.parse's message on
	// a malformed secret: it quotes the text.
	let parsed: Partial<MasterSecret>;
	try {
		parsed = JSON.parse(await getSecretString(secretArn)) as Partial<MasterSecret>;
	} catch (err) {
		if (err instanceof SyntaxError) throw new Error('master secret is not JSON');
		throw err;
	}
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

export function ownerUrl(secret: MasterSecret): string {
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
 *
 * `role` is water_app in the Lambda; the DB test (lambda-migrate.db.test.ts)
 * names a throwaway role, since a role is the whole cluster's and water_app's
 * password is every local database's.
 */
export async function syncAppRole(url: string, appPassword: string, role = 'water_app'): Promise<MigrateResult['appRole']> {
	if (!/^[A-Za-z0-9]{24,}$/.test(appPassword)) {
		throw new Error('WATER_APP_PASSWORD must be 24+ alphanumeric characters');
	}
	const client = new pg.Client({ connectionString: url });
	await client.connect();
	try {
		const verifier = client.escapeLiteral(scramSha256Verifier(appPassword));
		const exists = (await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount === 1;
		await client.query(`${exists ? 'ALTER' : 'CREATE'} ROLE ${client.escapeIdentifier(role)} WITH LOGIN PASSWORD ${verifier}`);
		const { rows } = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; rolreplication: boolean; rolcreaterole: boolean }>(
			'SELECT rolsuper, rolbypassrls, rolreplication, rolcreaterole FROM pg_roles WHERE rolname = $1',
			[role]
		);
		const r = rows[0];
		if (!r || r.rolsuper || r.rolbypassrls || r.rolreplication || r.rolcreaterole) {
			throw new Error(`${role} has a privileged attribute (SUPERUSER/BYPASSRLS/REPLICATION/CREATEROLE) — refusing to continue`);
		}
		return exists ? 'updated' : 'created';
	} finally {
		await client.end();
	}
}

/**
 * What a failed reference load returns (the thrown error's message, JSON),
 * which load-reference.yml prints to its public log: a code, the request's
 * kind and dataset only if they were well-formed, a fixed reason, and where
 * the detail is.
 */
export interface LoadFailure {
	code: LoadErrorCode;
	reason: string | null;
	logGroup: string | null;
	logStream: string | null;
	requestId: string | null;
}

export function loadFailureSummary(err: unknown, context?: LogContext): LoadFailure {
	const l = err instanceof LoadError ? err : null;
	return {
		code: l?.code ?? 'load_failed',
		reason: l?.publicReason ?? null,
		logGroup: context?.logGroupName ?? null,
		logStream: context?.logStreamName ?? null,
		requestId: context?.awsRequestId ?? null
	};
}

/**
 * Whether an S3 error means "no such object". The migrate role has GetObject
 * only (no ListBucket, infra/map_data.tf), so S3 answers a missing key with
 * 403 AccessDenied rather than 404 NoSuchKey; both mean the operator's key
 * names nothing it may read.
 */
export function isMissingObject(e: unknown): boolean {
	const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
	return err?.name === 'NoSuchKey' || err?.name === 'AccessDenied' || err?.$metadata?.httpStatusCode === 404 || err?.$metadata?.httpStatusCode === 403;
}

/** The reference bucket through the runtime's S3 client (a lazy import, like delineation/dem.ts). */
const readFromReferenceBucket: ReadObject = async (key) => {
	const bucket = requireEnv('REFERENCE_BUCKET');
	const sdk = await import('@aws-sdk/client-s3');
	const s3 = new sdk.S3Client({});
	try {
		const r = await s3.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
		const body = r.Body;
		if (!body) return null;
		return { contentLength: r.ContentLength ?? 0, bytes: async () => new Uint8Array(await body.transformToByteArray()) };
	} catch (e) {
		if (isMissingObject(e)) return null;
		throw e;
	}
};

/** One reference-dataset load (docs/deployment.md § Reference datasets). */
export async function loadReference(raw: unknown, context?: LogContext, read: ReadObject = readFromReferenceBucket): Promise<LoadResult> {
	try {
		const req = parseLoadRequest(raw);
		const text = await readReferenceText(req, read);
		const client = new pg.Client({ connectionString: ownerUrl(await readMasterSecret(requireEnv('MASTER_SECRET_ARN'))) });
		await client.connect();
		try {
			const result = await loadReferenceText(client, req, text, (line) => console.log(line));
			console.log(`${req.kind}: ${result.written} row(s) loaded as "${req.dataset}" from ${req.key} (SHA-256 ${req.sha256})`);
			if (result.replaced) console.log(`replaced the file loaded ${result.replaced.loadedAt}: ${result.replaced.key} (SHA-256 ${result.replaced.sha256})`);
			return result;
		} finally {
			await client.end();
		}
	} catch (err) {
		console.error('reference load failed:', err);
		const failure = new Error(JSON.stringify(loadFailureSummary(err, context)));
		failure.name = 'LoadFailed';
		failure.stack = `${failure.name}: ${failure.message}`;
		throw failure;
	}
}

export async function handler(event?: unknown, context?: LogContext): Promise<MigrateResult | LoadResult> {
	if (event && typeof event === 'object' && 'load' in event) return loadReference((event as { load: unknown }).load, context);
	try {
		return await run();
	} catch (err) {
		// The full error, stack included, for the operator: CloudWatch is private.
		console.error('migrate failed:', err);
		// Still a failed invocation (FunctionError, the migrate-errors alarm),
		// but its message is the summary alone.
		const failure = new Error(JSON.stringify(failureSummary(err, context)));
		failure.name = 'MigrateFailed';
		failure.stack = `${failure.name}: ${failure.message}`;
		throw failure;
	}
}

async function run(): Promise<MigrateResult> {
	const secret = await readMasterSecret(requireEnv('MASTER_SECRET_ARN'));
	const url = ownerUrl(secret);
	// Role first: 001_init's guard then skips its NOLOGIN placeholder, and the
	// GRANTs in the migrations land on the real login role.
	const appRole = await syncAppRole(url, requireEnv('WATER_APP_PASSWORD'));
	const applied = await migrate(url, (msg) => console.log(msg));
	console.log(applied.length ? `${applied.length} migration(s) applied` : 'schema up to date');
	return { applied, appRole };
}
