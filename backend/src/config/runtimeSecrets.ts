// Runtime secrets come from Secrets Manager, not the Lambda environment
// (issue #126; docs/security.md § Runtime secrets).
//
// A Lambda's environment variables are readable by anyone allowed
// lambda:GetFunctionConfiguration: the deploy role, and any read-only role
// (AWS's ReadOnlyAccess grants it). So a secret there is a secret any reader
// can use to forge a session. Instead each Lambda that needs secrets gets its
// own Secrets Manager secret (infra/secrets.tf), a JSON object holding exactly
// the keys in RUNTIME_SECRETS for its role, and two plain settings naming it:
// RUNTIME_SECRET_ARN and RUNTIME_SECRET_VERSION (the version Terraform last
// wrote; a new version changes the variable, so every instance cold-starts
// onto it).
//
// The entry points call loadRuntimeSecrets before anything else runs: it reads
// the secret once per cold start (never per request) and puts each value in
// process.env, where the code that uses it has always read it, lazily, inside
// a function. So the config checks (config/production.ts) and every reader
// work unchanged, and off Lambda (local dev, tests) it does nothing: the
// values come from the committed .env.development as before.
//
// Fails closed. In Lambda it throws (and the function refuses to start) when
// the secret can't be read, isn't a JSON object of strings, lacks a key or
// carries one this role shouldn't hold, or when a secret key is also set in
// the function's environment (a secret moved back there by mistake). Errors
// name keys, never values, and never quote the secret's text.
import type { Role } from './production.js';
import { getSecretString } from './secretsManager.js';

/** The keys each role's secret holds: no more (least privilege), no fewer. */
export const RUNTIME_SECRETS: Record<Role, readonly string[]> = {
	// The session key, the RLS-bound connection (its water_app password), and
	// the header CloudFront stamps on every /api request.
	api: ['AUTH_JWT_SECRET', 'DATABASE_URL', 'CLOUDFRONT_SHARED_SECRET'],
	// The run-stamp key (the session secret, runs/stamp.ts), the connection,
	// and the key that signs unsubscribe links (only the worker signs).
	worker: ['AUTH_JWT_SECRET', 'DATABASE_URL', 'ALERTS_TOKEN_SECRET'],
	// The password it sets on water_app. Its owner login is the RDS-managed
	// master secret, read per run (lambda-migrate.ts).
	migrate: ['WATER_APP_PASSWORD'],
	// No secrets: no database, no session (feeds.tf, reports.tf).
	fetcher: [],
	renderer: []
};

type Env = Record<string, string | undefined>;
type Fetch = (secretId: string, versionId?: string) => Promise<string>;

const set = (v: string | undefined) => v !== undefined && v.trim() !== '';

export class RuntimeSecretError extends Error {
	override name = 'RuntimeSecretError';
}

/**
 * Put `role`'s runtime secrets in `env` (process.env by default). Off Lambda
 * (no AWS_LAMBDA_FUNCTION_NAME) and for a role with no secrets it does nothing.
 */
export async function loadRuntimeSecrets(role: Role, env: Env = process.env, fetch: Fetch = getSecretString): Promise<void> {
	const keys = RUNTIME_SECRETS[role];
	if (!env.AWS_LAMBDA_FUNCTION_NAME || keys.length === 0) return;
	const fail = (problem: string, cause?: unknown) => new RuntimeSecretError(`refusing to start the ${role} Lambda: its runtime secret ${problem}`, cause ? { cause } : undefined);

	const inEnv = keys.filter((k) => set(env[k]));
	if (inEnv.length) throw fail(`keys are in the function's environment, where any GetFunctionConfiguration caller can read them: ${inEnv.join(', ')}`);
	const arn = env.RUNTIME_SECRET_ARN?.trim() ?? '';
	if (!/^arn:aws[a-z-]*:secretsmanager:/.test(arn)) throw fail('is not named (RUNTIME_SECRET_ARN is not a Secrets Manager ARN)');
	const version = env.RUNTIME_SECRET_VERSION?.trim() || undefined;

	let raw: string;
	try {
		raw = await fetch(arn, version);
	} catch (err) {
		// The SDK's error names the ARN and the denied action, never a value.
		throw fail(`could not be read (${err instanceof Error ? err.name : 'error'})`, err);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Not the parser's message: it quotes the text it choked on.
		throw fail('is not JSON');
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('is not a JSON object');
	const values = parsed as Record<string, unknown>;
	const missing = keys.filter((k) => typeof values[k] !== 'string' || !set(values[k] as string));
	if (missing.length) throw fail(`is missing keys: ${missing.join(', ')}`);
	const extra = Object.keys(values).filter((k) => !keys.includes(k));
	if (extra.length) throw fail(`holds keys this Lambda must not have: ${extra.join(', ')}`);
	for (const k of keys) env[k] = values[k] as string;
}
