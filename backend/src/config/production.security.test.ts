// Production config fails closed (config/production.ts, docs/security.md §
// Production configuration). Built from live inventories, not hand lists:
//   * the settings each Lambda can read: every `process.env.X` in the modules
//     esbuild reaches from its entry point, each of which must be classified;
//   * what Terraform sets: each aws_lambda_function's environment block in
//     infra/*.tf, which must set every setting production requires;
//   * the local defaults: every value in the committed backend/.env.development,
//     each of which a Lambda that checks that setting must refuse.
// Positive control: the production-shaped env (the same keys Terraform sets)
// starts every Lambda, entry point included.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { assertLambdaEnv, assertProductionEnv, productionEnvProblems, ROLES, type Role, SETTINGS } from './production.js';

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
const RUNTIME = new Set(['NODE_EXTRA_CA_CERTS', 'VITEST']);

// Production-shaped values, as Terraform renders them (keys must match infra/*.tf exactly; checked below).
const SITE = 'https://water.example.org';
const SQS = (name: string) => `https://sqs.af-south-1.amazonaws.com/000000000000/water-management-${name}`;
const DB_URL = `postgresql://water_app:${'a1'.repeat(16)}@water-management.abc123.af-south-1.rds.amazonaws.com:5432/water?sslmode=verify-full`;
const CA = '/var/task/rds-global-bundle.pem';
const PROD: Record<Role, Record<string, string>> = {
	api: {
		DATABASE_URL: DB_URL,
		AUTH_JWT_SECRET: 'f'.repeat(64),
		CLOUDFRONT_SHARED_SECRET: 'c'.repeat(48),
		ALLOWED_ORIGINS: SITE,
		COOKIE_SECURE: 'true',
		NODE_EXTRA_CA_CERTS: CA,
		MAIL_TRANSPORT: 'ses',
		MAIL_FROM: 'Water Management <no-reply@water.example.org>',
		SITE_URL: SITE,
		SES_CONFIGURATION_SET: 'water-management',
		JOB_TRANSPORT: 'sqs',
		JOBS_QUEUE_URL: SQS('jobs'),
		STORAGE: 's3',
		REPORTS_BUCKET: 'water-management-reports-000000000000'
	},
	worker: {
		DATABASE_URL: `${DB_URL}&application_name=worker`,
		DB_POOL_MAX: '2',
		AUTH_JWT_SECRET: 'f'.repeat(64),
		NODE_EXTRA_CA_CERTS: CA,
		JOB_TRANSPORT: 'sqs',
		JOBS_QUEUE_URL: SQS('jobs'),
		FEED_FETCHER: 'sqs',
		FETCH_REQUESTS_QUEUE_URL: SQS('fetch-requests'),
		REPORT_RENDERER: 'sqs',
		RENDER_REQUESTS_QUEUE_URL: SQS('render-requests'),
		STORAGE: 's3',
		REPORTS_BUCKET: 'water-management-reports-000000000000',
		MAIL_TRANSPORT: 'ses',
		MAIL_FROM: 'Water Management <no-reply@water.example.org>',
		SITE_URL: SITE,
		SES_CONFIGURATION_SET: 'water-management',
		ALERTS_TOKEN_SECRET: 'a'.repeat(48),
		ALERTS_ENABLED: 'true',
		ALERTS_DAILY_CAP: '5',
		MAIL_EVENTS_QUEUE_ARN: 'arn:aws:sqs:af-south-1:000000000000:water-management-mail-events'
	},
	fetcher: { FEED_SOURCE: 'live', INGEST_RESULTS_QUEUE_URL: SQS('ingest-results') },
	renderer: {
		RENDER_SITE_URL: SITE,
		RENDER_API_URL: `${SITE}/api`,
		REPORT_RENDER_TIMEOUT_MS: '100000',
		STORAGE: 's3',
		REPORTS_BUCKET: 'water-management-reports-000000000000',
		RENDER_RESULTS_QUEUE_URL: SQS('render-results')
	},
	migrate: {
		DB_HOST: 'water-management.abc123.af-south-1.rds.amazonaws.com',
		DB_PORT: '5432',
		DB_NAME: 'water',
		MASTER_SECRET_ARN: 'arn:aws:secretsmanager:af-south-1:000000000000:secret:rds!db-0000-AbCdEf',
		WATER_APP_PASSWORD: 'a1'.repeat(16),
		NODE_EXTRA_CA_CERTS: CA
	}
};

const prod = (role: Role, patch: Record<string, string | undefined> = {}) => {
	const env: Record<string, string | undefined> = { ...PROD[role], AWS_LAMBDA_FUNCTION_NAME: `water-management-${role}`, ...patch };
	for (const [k, v] of Object.entries(patch)) if (v === undefined) delete env[k];
	return env;
};
const problemNames = (role: Role, env: Record<string, string | undefined>) => productionEnvProblems(role, env).map((p) => p.split(' ')[0]);

/** Whether `name` must be set for `role` (its check refuses unset). */
const requiredFor = (role: Role, name: string) => !!SETTINGS[name]?.checks?.[role]?.(undefined);

// --- Live inventories -----------------------------------------------------------------------

/** Env names read by the source modules each entry point reaches. */
const reachable = {} as Record<Role, Map<string, Set<string>>>;
beforeAll(async () => {
	const { build } = await import('esbuild');
	for (const role of ROLES) {
		const out = await build({
			entryPoints: [`${SRC}${ENTRY[role]}`],
			bundle: true,
			platform: 'node',
			format: 'esm',
			external: ['playwright-core'],
			write: false,
			metafile: true,
			logLevel: 'silent'
		});
		const names = new Map<string, Set<string>>();
		const files = Object.keys(out.metafile.inputs).filter((f) => !f.includes('node_modules') && f.endsWith('.ts'));
		for (const file of files) {
			const src = readFileSync(file.startsWith('/') ? file : `${BACKEND}${file}`, 'utf8');
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

function devEnv(): [string, string][] {
	return readFileSync(`${BACKEND}.env.development`, 'utf8')
		.split('\n')
		.map((l) => /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l.trim()))
		.filter((m): m is RegExpExecArray => !!m)
		.map((m) => [m[1]!, m[2]!]);
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
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

	it.each(ROLES)('%s: every required setting is in its environment block', (role) => {
		const missing = Object.keys(SETTINGS).filter((n) => requiredFor(role, n) && !tf[role].has(n));
		expect(missing).toEqual([]);
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
		REPORTS_BUCKET: 'a name only: each role’s IAM policy grants Terraform’s bucket alone, so a wrong one fails every put'
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
			['worker', 'JOB_TRANSPORT', 'memory'],
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
			['worker', 'PASSWORD_HASH_COST', '4'],
			['api', 'SIGNUP_THROTTLE', 'off'],
			['migrate', 'MASTER_SECRET_ARN', undefined],
			['migrate', 'DB_HOST', 'localhost'],
			['migrate', 'WATER_APP_PASSWORD', 'water_app'],
			['migrate', 'NODE_EXTRA_CA_CERTS', undefined]
		];
		for (const [role, name, value] of cases) expect(problemNames(role, prod(role, { [name]: value })), `${role} ${name}=${value}`).toContain(name);
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
	/** Stub the process env to `env` for a fresh import: blank every classified setting and placeholder first. */
	function stubProcessEnv(env: Record<string, string | undefined>) {
		for (const name of Object.keys(SETTINGS)) vi.stubEnv(name, '');
		for (const [name, value] of Object.entries(process.env)) if (value && /^(dev|test)-only-/.test(value)) vi.stubEnv(name, '');
		for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value ?? '');
	}

	const load: Record<Role, () => Promise<unknown>> = {
		api: () => import('../lambda.js'),
		worker: () => import('../lambda-worker.js'),
		fetcher: () => import('../lambda-fetcher.js'),
		renderer: () => import('../lambda-renderer.js'),
		migrate: () => import('../lambda-migrate.js')
	};

	it.each(ROLES)('%s: loads with the production env, and refuses to load without a required setting', async (role) => {
		stubProcessEnv(prod(role));
		await expect(load[role]()).resolves.toHaveProperty('handler');
		vi.resetModules();
		const name = Object.keys(SETTINGS).find((n) => requiredFor(role, n) && n !== 'CLOUDFRONT_SHARED_SECRET')!;
		stubProcessEnv(prod(role, { [name]: undefined }));
		await expect(load[role]()).rejects.toThrow(new RegExp(`refusing to start the ${role} Lambda: .*${name}`));
	}, 30_000);
});
