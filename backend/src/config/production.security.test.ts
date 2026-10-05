// Production config fails closed (config/production.ts, docs/security.md §
// Production configuration). Built from live inventories, not hand lists:
//   * the settings each Lambda can read: every `process.env.X` in the modules
//     esbuild reaches from its entry point, each of which must be classified;
//   * what Terraform sets: each aws_lambda_function's environment block in
//     infra/*.tf, plus the keys of its runtime secret (local.runtime_secrets
//     in infra/secrets.tf, config/runtimeSecrets.ts), which together must set
//     every setting production requires, and no secret key may be in an
//     environment block;
//   * the local defaults: every value in the committed backend/.env.development,
//     each of which a Lambda that checks that setting must refuse.
// Positive control: the production-shaped env (the same keys Terraform sets)
// starts every Lambda, entry point included.
//
// One esbuild build serves both: the inventory reads its metafile, and the
// entry-point tests import its bundles natively, a fresh copy each time, the
// way a Lambda cold start loads one. Not through vitest's module runner: that
// would transform the whole backend and the engine's source (~3 s of CPU on
// the shared Vite server alone, far more beside every other file in a full
// `pnpm test`), which is what made this file time out on a loaded machine.
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeRuntime } from '../__tests__/lambdaRuntime.js';
import { assertLambdaEnv, assertProductionEnv, productionEnvProblems, ROLES, type Role, SETTINGS } from './production.js';
import { RUNTIME_SECRETS } from './runtimeSecrets.js';

const SRC = fileURLToPath(new URL('..', import.meta.url));
const BACKEND = fileURLToPath(new URL('../..', import.meta.url));
const INFRA = fileURLToPath(new URL('../../../infra/', import.meta.url));

const ENTRY: Record<Role, string> = {
	api: 'lambda.ts',
	worker: 'lambda-worker.ts',
	fetcher: 'lambda-fetcher.ts',
	renderer: 'lambda-renderer.ts',
	migrate: 'lambda-migrate.ts'
};
/** Terraform's aws_lambda_function resource for each role. */
const TF_RESOURCE: Record<string, Role> = { backend: 'api', worker: 'worker', fetcher: 'fetcher', renderer: 'renderer', migrate: 'migrate' };
/** Read by the runtime or the test runner, not by our code: classified, but no module mentions them. */
const RUNTIME = new Set(['NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'VITEST']);

// Production-shaped values, as Terraform renders them (keys must match infra/*.tf exactly; checked below):
// PROD is each environment block, PROD_SECRETS each runtime secret's JSON.
const SITE = 'https://water.example.org';
const SQS = (name: string) => `https://sqs.af-south-1.amazonaws.com/000000000000/water-management-${name}`;
const DB_URL = `postgresql://water_app:${'a1'.repeat(16)}@water-management.abc123.af-south-1.rds.amazonaws.com:5432/water?sslmode=verify-full`;
const CA = '/var/task/rds-global-bundle.pem';
const SECRET_ARN = (role: string) => `arn:aws:secretsmanager:af-south-1:000000000000:secret:water-management/runtime/${role}-AbCdEf`;
const runtimeSecret = (role: string) => ({ RUNTIME_SECRET_ARN: SECRET_ARN(role), RUNTIME_SECRET_VERSION: '00000000-0000-0000-0000-000000000000' });
// The report-download key pair, generated per run (the API checks at cold start that they pair).
const pemPair = () =>
	generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const SIGNING = pemPair();
const PROD_SECRETS: Record<Role, Record<string, string>> = {
	api: { DATABASE_URL: DB_URL, AUTH_JWT_SECRET: 'f'.repeat(64), CLOUDFRONT_SHARED_SECRET: 'c'.repeat(48), CLOUDFRONT_PRIVATE_KEY: SIGNING.privateKey, APP_ENCRYPTION_KEY: 'e'.repeat(64) },
	worker: { DATABASE_URL: `${DB_URL}&application_name=worker`, AUTH_JWT_SECRET: 'f'.repeat(64), ALERTS_TOKEN_SECRET: 'a'.repeat(48) },
	fetcher: {},
	renderer: {},
	migrate: { WATER_APP_PASSWORD: 'a1'.repeat(16) }
};
const PROD: Record<Role, Record<string, string>> = {
	api: {
		...runtimeSecret('api'),
		ALLOWED_ORIGINS: SITE,
		COOKIE_SECURE: 'true',
		NODE_EXTRA_CA_CERTS: CA,
		SIGNUP_OPEN: 'false',
		MAIL_TRANSPORT: 'ses',
		MAIL_FROM: 'Water Management <no-reply@water.example.org>',
		SITE_URL: SITE,
		SES_CONFIGURATION_SET: 'water-management',
		JOB_TRANSPORT: 'sqs',
		JOBS_QUEUE_URL: SQS('jobs'),
		STORAGE: 's3',
		REPORTS_BUCKET: 'water-management-reports-000000000000',
		PACKS_BUCKET: 'water-management-packs-000000000000',
		REPORT_DOWNLOADS: 'cloudfront',
		CLOUDFRONT_KEY_PAIR_ID: 'K2JCJMDEHXQW5F',
		CLOUDFRONT_PUBLIC_KEY: SIGNING.publicKey,
		DEM_URL: 's3://water-management-tiles-000000000000/tiles/terrain.pmtiles',
		WATER_URL: 's3://water-management-tiles-000000000000/tiles/water.pmtiles'
	},
	worker: {
		...runtimeSecret('worker'),
		DB_POOL_MAX: '2',
		NODE_EXTRA_CA_CERTS: CA,
		FEED_FETCHER: 'sqs',
		FETCH_REQUESTS_QUEUE_URL: SQS('fetch-requests'),
		REPORT_RENDERER: 'sqs',
		RENDER_REQUESTS_QUEUE_URL: SQS('render-requests'),
		STORAGE: 's3',
		REPORTS_BUCKET: 'water-management-reports-000000000000',
		PACKS_BUCKET: 'water-management-packs-000000000000',
		MAIL_TRANSPORT: 'ses',
		MAIL_FROM: 'Water Management <no-reply@water.example.org>',
		SITE_URL: SITE,
		SES_CONFIGURATION_SET: 'water-management',
		ALERTS_ENABLED: 'true',
		ALERTS_DAILY_CAP: '5',
		MAIL_EVENTS_QUEUE_ARN: 'arn:aws:sqs:af-south-1:000000000000:water-management-mail-events',
		DEM_URL: 's3://water-management-tiles-000000000000/tiles/terrain.pmtiles',
		OPERATOR_EMAIL: 'operator@water.example.org'
	},
	fetcher: { FEED_SOURCE: 'live', INGEST_RESULTS_QUEUE_URL: SQS('ingest-results') },
	renderer: {
		RENDER_SITE_URL: SITE,
		RENDER_API_URL: `${SITE}/api`,
		REPORT_RENDER_TIMEOUT_MS: '100000',
		STORAGE: 's3',
		REPORTS_BUCKET: 'water-management-reports-000000000000',
		PACKS_BUCKET: 'water-management-packs-000000000000',
		RENDER_RESULTS_QUEUE_URL: SQS('render-results')
	},
	migrate: {
		DB_HOST: 'water-management.abc123.af-south-1.rds.amazonaws.com',
		DB_PORT: '5432',
		DB_NAME: 'water',
		MASTER_SECRET_ARN: 'arn:aws:secretsmanager:af-south-1:000000000000:secret:rds!db-0000-AbCdEf',
		...runtimeSecret('migrate'),
		NODE_EXTRA_CA_CERTS: CA,
		REFERENCE_BUCKET: 'water-management-reference-000000000000',
		NODE_OPTIONS: '--max-old-space-size=2556'
	}
};

/** A Lambda's environment once its runtime secret is loaded (the shape the config check sees). */
const prod = (role: Role, patch: Record<string, string | undefined> = {}) => {
	const env: Record<string, string | undefined> = { ...PROD[role], ...PROD_SECRETS[role], AWS_LAMBDA_FUNCTION_NAME: `water-management-${role}`, ...patch };
	for (const [k, v] of Object.entries(patch)) if (v === undefined) delete env[k];
	return env;
};
const problemNames = (role: Role, env: Record<string, string | undefined>) => productionEnvProblems(role, env).map((p) => p.split(' ')[0]);

/** Whether `name` must be set for `role` (its check refuses unset). */
const requiredFor = (role: Role, name: string) => !!SETTINGS[name]?.checks?.[role]?.(undefined);

// --- Live inventories -----------------------------------------------------------------------

/** Env names read by the source modules each entry point reaches. */
const reachable = {} as Record<Role, Map<string, Set<string>>>;
/** Each entry point's bundle (a file: URL), and a loader that imports one natively (see the header). */
const bundle = {} as Record<Role, string>;
let nativeImport: (url: string) => Promise<Record<string, unknown>>;
let outDir: string;
/** Where the bundles' stand-in for config/secretsManager.ts finds the test's Secrets Manager (stubSecretsManager below). */
const SECRETS_HOOK = '__productionSecurityTestGetSecretString';
beforeAll(async () => {
	const { build } = await import('esbuild');
	// Under node_modules: vitest leaves a module there to Node, so load.mjs's import() is Node's own. Bare imports resolve from backend/node_modules.
	mkdirSync(`${BACKEND}node_modules/.cache`, { recursive: true });
	outDir = mkdtempSync(`${BACKEND}node_modules/.cache/production-security-`);
	writeFileSync(`${outDir}/load.mjs`, 'export const load = (url) => import(url);\n');
	({ load: nativeImport } = (await import(/* @vite-ignore */ pathToFileURL(`${outDir}/load.mjs`).href)) as { load: typeof nativeImport });
	// All five in one build, with the flags infra/scripts/package-lambdas.sh bundles them with (less the minifying).
	const out = await build({
		entryPoints: Object.fromEntries(ROLES.map((role) => [role, `${SRC}${ENTRY[role]}`])),
		outdir: outDir,
		absWorkingDir: BACKEND, // the metafile's paths are relative to it, wherever vitest runs from
		outExtension: { '.js': '.mjs' },
		bundle: true,
		platform: 'node',
		target: 'node24',
		format: 'esm',
		external: ['playwright-core'],
		banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
		metafile: true,
		logLevel: 'silent',
		plugins: [
			{
				// The bundles' Secrets Manager is the test's (it never reaches AWS); the inventory still reads the real file from disk.
				name: 'test-secrets-manager',
				setup(b) {
					b.onLoad({ filter: /[\\/]config[\\/]secretsManager\.ts$/ }, () => ({
						contents: `export const getSecretString = (...args) => globalThis.${SECRETS_HOOK}(...args);`,
						loader: 'js'
					}));
				}
			}
		]
	});
	for (const role of ROLES) {
		const [outfile, output] = Object.entries(out.metafile.outputs).find(([f]) => f.endsWith(`/${role}.mjs`))!;
		bundle[role] = pathToFileURL(`${BACKEND}${outfile}`).href;
		const names = new Map<string, Set<string>>();
		const files = Object.keys(output.inputs).filter((f) => !f.includes('node_modules') && f.endsWith('.ts'));
		for (const file of files) {
			const src = readFileSync(`${BACKEND}${file}`, 'utf8');
			// process.env.X, env.X (a function taking `env = process.env`), requireEnv('X').
			for (const m of src.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)\b|requireEnv\('([A-Z][A-Z0-9_]*)'\)/g)) {
				const name = (m[1] ?? m[2])!;
				if (!names.has(name)) names.set(name, new Set());
				names.get(name)!.add(file);
			}
			// A computed read (process.env[name]) can't be inventoried: only requireEnv may do it.
			const computed = [...src.matchAll(/process\.env\[(?!name\])/g)];
			expect(computed, `${file} reads process.env[…] with a computed name; read settings by name so they can be classified`).toEqual([]);
		}
		expect(files.some((f) => f.endsWith(`src/${ENTRY[role]}`))).toBe(true);
		reachable[role] = names;
	}
}, 60_000);
afterAll(() => {
	if (outDir) rmSync(outDir, { recursive: true, force: true });
});

/** Each Lambda's environment block in infra/*.tf: key → literal value, or null for an expression. */
function terraformEnv(): Record<Role, Map<string, string | null>> {
	const out = {} as Record<Role, Map<string, string | null>>;
	for (const file of readdirSync(INFRA).filter((f) => f.endsWith('.tf'))) {
		const tf = readFileSync(`${INFRA}${file}`, 'utf8');
		for (const m of tf.matchAll(/^resource "aws_lambda_function" "([a-z_]+)" \{$/gm)) {
			const role = TF_RESOURCE[m[1]!];
			expect(role, `infra/${file}: aws_lambda_function.${m[1]} is a Lambda this test doesn't know; add it to TF_RESOURCE and give it a role`).toBeDefined();
			const body = tf.slice(m.index!, tf.indexOf('\n}\n', m.index!));
			const lines = body.split('\n');
			const start = lines.findIndex((l) => /^\s*variables = \{$/.test(l));
			expect(start, `aws_lambda_function.${m[1]} has no environment variables block`).toBeGreaterThan(0);
			const vars = new Map<string, string | null>();
			for (const line of lines.slice(start + 1)) {
				if (/^\s*\}$/.test(line)) break;
				const kv = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.+?)\s*$/.exec(line);
				if (!kv) continue; // a comment or a blank line
				const literal = /^"([^"$]*)"$/.exec(kv[2]!);
				vars.set(kv[1]!, literal ? literal[1]! : null);
			}
			out[role!] = vars;
		}
	}
	return out;
}

/** The keys of each role's runtime secret in infra/secrets.tf (local.runtime_secrets). */
function terraformSecrets(): Record<Role, Set<string>> {
	const tf = readFileSync(`${INFRA}secrets.tf`, 'utf8');
	const start = tf.search(/^ {2}runtime_secrets = \{$/m);
	expect(start, 'infra/secrets.tf has no local.runtime_secrets').toBeGreaterThan(0);
	const block = tf.slice(start, tf.indexOf('\n  }\n', start));
	const out = Object.fromEntries(ROLES.map((r) => [r, new Set<string>()])) as Record<Role, Set<string>>;
	for (const m of block.matchAll(/^ {4}([a-z]+) = \{$([\s\S]*?)^ {4}\}$/gm)) {
		const role = m[1] as Role;
		expect(ROLES, `local.runtime_secrets.${role} is not a role`).toContain(role);
		for (const kv of m[2]!.matchAll(/^ {6}([A-Z][A-Z0-9_]*)\s*=/gm)) out[role].add(kv[1]!);
	}
	return out;
}

function devEnv(): [string, string][] {
	return readFileSync(`${BACKEND}.env.development`, 'utf8')
		.split('\n')
		.map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l.trim()))
		.filter((m): m is RegExpExecArray => !!m)
		.map((m) => [m[1]!, m[2]!]);
}

afterEach(() => {
	vi.unstubAllEnvs();
	delete (globalThis as Record<string, unknown>)[SECRETS_HOOK];
});

describe('every setting a Lambda can read is classified', () => {
	it.each(ROLES)('%s: each process.env read it reaches is in SETTINGS', (role) => {
		const unclassified = [...reachable[role]].filter(([name]) => !(name in SETTINGS)).map(([name, files]) => `${name} (${[...files].join(', ')})`);
		expect(unclassified, 'classify each in config/production.ts SETTINGS: a production check for the Lambdas that need it, or why none is needed').toEqual([]);
		// The positive control: the inventory does see the settings this Lambda is known to read.
		expect(reachable[role].size).toBeGreaterThan(0);
	});

	it('the inventory sees known reads (positive control for the scan)', () => {
		expect(reachable.api.has('AUTH_JWT_SECRET')).toBe(true);
		expect(reachable.fetcher.has('FEED_SOURCE')).toBe(true);
		expect(reachable.migrate.has('MASTER_SECRET_ARN')).toBe(true);
		expect(reachable.renderer.has('RENDER_SITE_URL')).toBe(true);
	});

	it('no stale entries: each setting is read by some Lambda (or the runtime), and each check is on a Lambda that reads it', () => {
		const all = new Set(ROLES.flatMap((r) => [...reachable[r].keys()]));
		expect(Object.keys(SETTINGS).filter((n) => !all.has(n) && !RUNTIME.has(n))).toEqual([]);
		const misplaced = ROLES.flatMap((role) =>
			Object.entries(SETTINGS)
				.filter(([name, s]) => s.checks?.[role] && !reachable[role].has(name) && !RUNTIME.has(name))
				.map(([name]) => `${role}: ${name}`)
		);
		expect(misplaced).toEqual([]);
	});
});

describe('Terraform sets what production requires', () => {
	const tf = terraformEnv();

	it('finds every Lambda', () => {
		expect(Object.keys(tf).sort()).toEqual([...ROLES].sort());
	});

	const tfSecrets = terraformSecrets();

	it.each(ROLES)('%s: every required setting is in its environment block or its runtime secret', (role) => {
		const missing = Object.keys(SETTINGS).filter((n) => requiredFor(role, n) && !tf[role].has(n) && !tfSecrets[role].has(n));
		expect(missing).toEqual([]);
	});

	it.each(ROLES)('%s: its runtime secret holds exactly RUNTIME_SECRETS, and the fixture mirrors it', (role) => {
		expect([...tfSecrets[role]].sort()).toEqual([...RUNTIME_SECRETS[role]].sort());
		expect(Object.keys(PROD_SECRETS[role]).sort()).toEqual([...RUNTIME_SECRETS[role]].sort());
		if (RUNTIME_SECRETS[role].length) expect(tf[role].has('RUNTIME_SECRET_ARN') && tf[role].has('RUNTIME_SECRET_VERSION'), role).toBe(true);
		else expect(tf[role].has('RUNTIME_SECRET_ARN'), role).toBe(false);
	});

	it('no environment block holds any secret (GetFunctionConfiguration reads them all): a denylist across every Lambda', () => {
		const denied = new Set([...Object.values(RUNTIME_SECRETS).flat(), 'DB_PASSWORD', 'MASTER_PASSWORD']);
		expect(denied.has('CLOUDFRONT_SHARED_SECRET') && denied.has('WATER_APP_PASSWORD')).toBe(true); // positive control
		const leaks = ROLES.flatMap((role) => [...tf[role].keys()].filter((k) => denied.has(k) || /SECRET(?!_ARN$|_VERSION$)|PASSWORD|PRIVATE_KEY|TOKEN$/.test(k)).map((k) => `${role}: ${k}`));
		expect(leaks).toEqual([]);
	});

	it.each(ROLES)('%s: every key it sets is a classified setting, and the fixture here mirrors it exactly', (role) => {
		expect([...tf[role].keys()].filter((k) => !(k in SETTINGS))).toEqual([]);
		expect(Object.keys(PROD[role]).sort()).toEqual([...tf[role].keys()].sort());
		// Literal values in Terraform pass the checks as they are.
		for (const [k, v] of tf[role]) if (v !== null) expect(PROD[role][k], `${role} ${k}`).toBe(v);
	});
});

describe('a production-shaped env starts every Lambda (positive control)', () => {
	it.each(ROLES)('%s', (role) => {
		expect(productionEnvProblems(role, prod(role))).toEqual([]);
		expect(() => assertProductionEnv(role, prod(role))).not.toThrow();
	});

	it('the alert kill switch may be either decision', () => {
		expect(productionEnvProblems('worker', prod('worker', { ALERTS_ENABLED: 'false' }))).toEqual([]);
	});

	it('off Lambda (no AWS_LAMBDA_FUNCTION_NAME) the entry-point check does nothing: tests and local calls', () => {
		expect(() => assertLambdaEnv('api', {})).not.toThrow();
		expect(() => assertLambdaEnv('api', { AWS_LAMBDA_FUNCTION_NAME: 'x' })).toThrow(/refusing to start the api Lambda/);
	});
});

describe('each Lambda refuses a missing or local-default setting', () => {
	it.each(ROLES)('%s: removing any required setting is refused, naming it', (role) => {
		const required = Object.keys(SETTINGS).filter((n) => requiredFor(role, n));
		expect(required.length).toBeGreaterThan(0);
		for (const name of required) {
			expect(problemNames(role, prod(role, { [name]: undefined })), `${role} without ${name}`).toContain(name);
			expect(problemNames(role, prod(role, { [name]: '  ' })), `${role} with a blank ${name}`).toContain(name);
		}
	});

	// A dev default that is also a valid production value (with why that's safe).
	const DEV_VALUE_OK: Record<string, string> = {
		ALERTS_ENABLED: 'true is a real decision in both',
		REPORTS_BUCKET: 'a name only: each role’s IAM policy grants Terraform’s bucket alone, so a wrong one fails every put',
		PACKS_BUCKET: 'a name only, as REPORTS_BUCKET: the renderer’s and the API’s roles may put, and the worker’s read, only in Terraform’s packs bucket',
		DEM_URL: 'empty in the committed file: delineation off, a valid production choice too (a local value is refused: the named local defaults below)',
		WATER_URL: 'empty in the committed file: tracing a dam off, a valid production choice too (a local value is refused, as DEM_URL)'
	};

	it.each(ROLES)('%s: every committed backend/.env.development value it checks is refused', (role) => {
		const dev = devEnv();
		expect(dev.length).toBeGreaterThan(10);
		const swept: string[] = [];
		for (const [name, value] of dev) {
			if (!SETTINGS[name]?.checks?.[role] || name in DEV_VALUE_OK) continue;
			swept.push(name);
			expect(problemNames(role, prod(role, { [name]: value })), `${role} ${name}=<dev value>`).toContain(name);
		}
		if (role !== 'migrate' && role !== 'fetcher') expect(swept.length).toBeGreaterThan(2);
	});

	it('the named local defaults', () => {
		const devJwt = new Map(devEnv()).get('AUTH_JWT_SECRET')!;
		expect(devJwt.length).toBeGreaterThanOrEqual(32); // so it's the placeholder rule that refuses it, not the length
		const cases: [Role, string, string | undefined][] = [
			['api', 'AUTH_JWT_SECRET', devJwt],
			['api', 'AUTH_JWT_SECRET', 'test-only-jwt-secret-0000000000000000000'],
			['api', 'STORAGE', 'local'],
			['api', 'REPORT_DOWNLOADS', 'presigned'],
			['api', 'REPORT_DOWNLOADS', undefined],
			['api', 'CLOUDFRONT_KEY_PAIR_ID', 'not-a-key-id'],
			['api', 'CLOUDFRONT_PRIVATE_KEY', 'c'.repeat(64)],
			['api', 'CLOUDFRONT_PUBLIC_KEY', 'c'.repeat(64)],
			['api', 'CLOUDFRONT_PUBLIC_KEY', SIGNING.privateKey],
			['worker', 'STORAGE', 'local'],
			['renderer', 'STORAGE', undefined],
			['fetcher', 'FEED_SOURCE', 'fixtures'],
			['fetcher', 'FEED_SOURCE', undefined],
			['worker', 'FEED_FETCHER', 'inline'],
			['worker', 'REPORT_RENDERER', 'inline'],
			['api', 'MAIL_TRANSPORT', 'smtp'],
			['worker', 'MAIL_TRANSPORT', undefined],
			['worker', 'MAIL_FROM', 'Water Management <no-reply@localhost>'],
			['api', 'JOB_TRANSPORT', 'inprocess'],
			['api', 'JOB_TRANSPORT', 'memory'],
			['api', 'JOBS_QUEUE_URL', undefined],
			['renderer', 'RENDER_SITE_URL', 'http://localhost:7777'],
			['renderer', 'RENDER_API_URL', 'https://127.0.0.1:3001'],
			['renderer', 'RENDER_SITE_URL', 'http://water.example.org'],
			['worker', 'RENDER_SITE_URL', 'http://localhost:7777'],
			['api', 'API_PUBLIC_URL', 'http://localhost:3001'],
			['api', 'SITE_URL', 'http://localhost:7777'],
			['api', 'ALLOWED_ORIGINS', `${SITE},http://localhost:7777`],
			['api', 'COOKIE_SECURE', 'false'],
			['api', 'DATABASE_URL', 'postgresql://water_app:water_app@127.0.0.1:5434/water'],
			['api', 'DATABASE_URL', DB_URL.replace('?sslmode=verify-full', '')],
			['worker', 'DATABASE_URL', DB_URL.replace(`:${'a1'.repeat(16)}@`, ':water_app@')],
			['worker', 'ALERTS_ENABLED', undefined],
			['worker', 'ALERTS_ENABLED', 'yes'],
			['worker', 'ALERTS_TOKEN_SECRET', 'dev-only-alerts-token-secret-000000000'],
			['worker', 'MAIL_EVENTS_QUEUE_ARN', undefined],
			['api', 'VITEST', 'true'],
			['worker', 'PASSWORD_HASH_FAST', '1'],
			['api', 'SIGNUP_THROTTLE', 'off'],
			['api', 'SIGNUP_OPEN', 'yes'],
			['migrate', 'MASTER_SECRET_ARN', undefined],
			['migrate', 'DB_HOST', 'localhost'],
			['migrate', 'WATER_APP_PASSWORD', 'water_app'],
			['migrate', 'NODE_EXTRA_CA_CERTS', undefined],
			['api', 'DEM_URL', 'fixtures/dem/synthetic-dem.pmtiles'],
			['api', 'DEM_URL', 'http://localhost:9002/tiles/terrain.pmtiles'],
			['api', 'DEM_URL', 'https://127.0.0.1/terrain.pmtiles'],
			['worker', 'DEM_URL', 'fixtures/dem/synthetic-dem.pmtiles'],
			['worker', 'DEM_URL', 'http://localhost:9002/tiles/terrain.pmtiles'],
			['api', 'WATER_URL', 'fixtures/water/synthetic-water.pmtiles'],
			['api', 'WATER_URL', 'http://localhost:9002/tiles/water.pmtiles']
		];
		for (const [role, name, value] of cases) expect(problemNames(role, prod(role, { [name]: value })), `${role} ${name}=${value}`).toContain(name);
	});

	it('lets the delineation DEM be off or an S3 object (positive control for the DEM_URL refusals)', () => {
		for (const role of ['api', 'worker'] as const)
			for (const v of [undefined, '', 's3://water-tiles/tiles/terrain.pmtiles']) expect(problemNames(role, prod(role, { DEM_URL: v })), `${role} ${String(v)}`).not.toContain('DEM_URL');
		for (const v of [undefined, '', 's3://water-tiles/tiles/water.pmtiles']) expect(problemNames('api', prod('api', { WATER_URL: v })), String(v)).not.toContain('WATER_URL');
	});

	it('refuses a committed placeholder in any setting, classified or not', () => {
		expect(problemNames('fetcher', prod('fetcher', { SOMETHING_NEW: 'dev-only-x' }))).toContain('SOMETHING_NEW');
		expect(problemNames('worker', prod('worker', { AUTH_JWT_SECRET: 'test-only-jwt-secret-0000000000000000000' }))).toContain('AUTH_JWT_SECRET');
	});

	it('never puts a value in the error (it may be a secret)', () => {
		const leaky = { AUTH_JWT_SECRET: 'dev-only-jwt-secret-change-me-0000000000', DATABASE_URL: 'postgresql://water_app:hunter2hunter2@127.0.0.1:5434/water' };
		const message = (() => {
			try {
				assertProductionEnv('api', prod('api', leaky));
			} catch (err) {
				return (err as Error).message;
			}
			return '';
		})();
		expect(message).toMatch(/AUTH_JWT_SECRET/);
		expect(message).toMatch(/DATABASE_URL/);
		for (const v of Object.values(leaky)) expect(message).not.toContain(v);
		expect(message).not.toContain('hunter2');
	});
});

describe('each entry point runs the check at init', () => {
	// The API's handler is a streaming one (http/lambdaStream.ts), made from the runtime's awslambda global at load.
	beforeEach(() => vi.stubGlobal('awslambda', fakeRuntime));
	afterEach(() => vi.unstubAllGlobals());
	/** Stub the process env to `env` for a fresh import: blank every classified setting and placeholder first. */
	function stubProcessEnv(env: Record<string, string | undefined>) {
		for (const name of Object.keys(SETTINGS)) vi.stubEnv(name, '');
		for (const [name, value] of Object.entries(process.env)) if (value && /^(dev|test)-only-/.test(value)) vi.stubEnv(name, '');
		for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value ?? '');
	}

	/** A cold start: a fresh instance of the role's bundle (a new URL is a new module, its whole graph inlined). */
	let loads = 0;
	const load = Object.fromEntries(ROLES.map((role) => [role, () => nativeImport(`${bundle[role]}?load=${++loads}`)])) as Record<Role, () => Promise<unknown>>;

	/** Secrets Manager, as the entry point's loader sees it: `secret` for this role's ARN. */
	function stubSecretsManager(role: Role, secret: Record<string, string>) {
		const read = vi.fn(async (id: string) => {
			if (id !== SECRET_ARN(role)) throw Object.assign(new Error('not this role’s secret'), { name: 'AccessDeniedException' });
			return JSON.stringify(secret);
		});
		(globalThis as Record<string, unknown>)[SECRETS_HOOK] = read;
		return read;
	}

	it.each(ROLES)('%s: loads with the production env and its secret, and refuses to load without a required setting', async (role) => {
		// The environment block alone (no secret values in it), the secret from Secrets Manager.
		stubProcessEnv({ ...PROD[role], AWS_LAMBDA_FUNCTION_NAME: `water-management-${role}` });
		const read = stubSecretsManager(role, PROD_SECRETS[role]);
		await expect(load[role]()).resolves.toHaveProperty('handler');
		expect(read).toHaveBeenCalledTimes(RUNTIME_SECRETS[role].length ? 1 : 0);
		for (const k of RUNTIME_SECRETS[role]) expect(process.env[k], k).toBe(PROD_SECRETS[role][k]);
		const name = Object.keys(SETTINGS).find((n) => requiredFor(role, n) && n in PROD[role] && !n.startsWith('RUNTIME_SECRET_'))!;
		stubProcessEnv(prod(role, { [name]: undefined, ...Object.fromEntries(RUNTIME_SECRETS[role].map((k) => [k, undefined])) }));
		stubSecretsManager(role, PROD_SECRETS[role]);
		await expect(load[role]()).rejects.toThrow(new RegExp(`refusing to start the ${role} Lambda: .*${name}`));
	}, 30_000);

	it('api: refuses to load when its download signing key is not the private half of CLOUDFRONT_PUBLIC_KEY', async () => {
		stubProcessEnv({ ...PROD.api, CLOUDFRONT_PUBLIC_KEY: pemPair().publicKey, AWS_LAMBDA_FUNCTION_NAME: 'water-management-api' });
		stubSecretsManager('api', PROD_SECRETS.api);
		const err = await load.api().then(
			() => null,
			(e: unknown) => e as Error
		);
		expect(err?.message).toMatch(/CLOUDFRONT_PRIVATE_KEY is not the private half of CLOUDFRONT_PUBLIC_KEY/);
		expect(err?.message).not.toContain('PRIVATE KEY-----');
	}, 30_000);

	it.each(ROLES.filter((r) => RUNTIME_SECRETS[r].length))('%s: refuses to load when its secret lacks a key, naming the key', async (role) => {
		const [key, ...rest] = RUNTIME_SECRETS[role];
		stubProcessEnv({ ...PROD[role], AWS_LAMBDA_FUNCTION_NAME: `water-management-${role}` });
		stubSecretsManager(role, Object.fromEntries(rest.map((k) => [k, PROD_SECRETS[role][k]!])));
		await expect(load[role]()).rejects.toThrow(new RegExp(`refusing to start the ${role} Lambda: its runtime secret is missing keys: ${key}`));
	}, 30_000);
});
