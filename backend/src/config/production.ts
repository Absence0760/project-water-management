// Production config fails closed (docs/security.md § Production configuration).
//
// Every setting the code reads falls back to the local stack when it is unset:
// STORAGE=local (MinIO and its minioadmin login), FEED_SOURCE=fixtures
// (synthetic data), MAIL_TRANSPORT=log (sends nothing), JOB_TRANSPORT=inprocess
// (no worker is ever woken), http://localhost URLs in every link, and so on.
// That is what lets a fresh clone run with no setup, and it means a Lambda
// deployed with a setting missing would not fail: it would quietly serve
// synthetic data, email localhost links, or never send mail. So each Lambda
// entry point checks its environment at init and refuses to start (throws)
// when anything it needs in production is missing or still a local default.
//
// SETTINGS classifies every variable a Lambda can reach. The guard test
// (production.security.test.ts) bundles each entry point, collects every
// process.env read in the modules it reaches, and fails on one that isn't
// listed here, so a new setting has to be classified: checked in production
// for the Lambdas that need it, or listed with the reason it needs no check.
// The same test checks Terraform sets each required one (infra/*.tf): in the
// function's environment, or, for a secret, in its runtime secret
// (config/runtimeSecrets.ts, loaded into process.env before this check runs).
//
// Problems name the setting, never its value: the value may be a secret.
// This module imports nothing, so every Lambda bundle can carry it.

export const ROLES = ['api', 'worker', 'fetcher', 'renderer', 'migrate'] as const;
export type Role = (typeof ROLES)[number];

type Env = Record<string, string | undefined>;
/** A problem with the value (unset included), or null when it is fine. */
type Check = (value: string | undefined) => string | null;

interface Setting {
	/** What it is, and why a Lambda that reaches it but has no check needs none. */
	why: string;
	/** The production check, per Lambda. A role not listed doesn't check it. */
	checks?: Partial<Record<Role, Check>>;
}

/** Placeholders the committed dev and test env use (scripts/guards/check_env_isolation.mjs keeps them so). */
const PLACEHOLDER = /^(dev|test)-only-/;

const LOCAL_HOSTS = /^(localhost|.*\.localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|::1?|host\.docker\.internal|minio|mailpit|postgres)$/i;
const isLocalHost = (host: string) => LOCAL_HOSTS.test(host);

const set = (v: string | undefined): v is string => v !== undefined && v.trim() !== '';

const required: Check = (v) => (set(v) ? null : 'is not set');

const oneOf =
	(...allowed: string[]): Check =>
	(v) =>
		!set(v) ? `is not set (production needs ${allowed.join(' or ')})` : allowed.includes(v.trim()) ? null : `must be ${allowed.join(' or ')} in production`;

const secret =
	(min: number): Check =>
	(v) =>
		!set(v) ? 'is not set' : v.length < min ? `must be at least ${min} characters` : PLACEHOLDER.test(v) ? 'is a committed dev/test placeholder' : null;

const publicHttps: Check = (v) => {
	if (!set(v)) return 'is not set';
	const url = URL.parse(v.trim());
	if (!url) return 'is not a URL';
	if (url.protocol !== 'https:') return 'must be an https URL';
	if (isLocalHost(url.hostname)) return 'points at a local host';
	return null;
};

const publicHttpsList: Check = (v) => {
	const items = (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
	if (!items.length) return 'is not set';
	return items.some((item) => publicHttps(item)) ? 'has an origin that is not a public https URL' : null;
};

const optional =
	(check: Check): Check =>
	(v) =>
		set(v) ? check(v) : null;

const secretsManagerArn: Check = (v) => (!set(v) ? 'is not set' : /^arn:aws[a-z-]*:secretsmanager:/.test(v.trim()) ? null : 'is not a Secrets Manager ARN');

const arn: Check = (v) => (!set(v) ? 'is not set' : /^arn:aws[a-z-]*:[a-z0-9-]+:/.test(v.trim()) ? null : 'is not an ARN');

/** The RLS-bound app connection: RDS over verified TLS, with a generated password (infra/lambda.tf). */
const postgresUrl: Check = (v) => {
	if (!set(v)) return 'is not set';
	const url = URL.parse(v.trim());
	if (!url || !/^postgres(ql)?:$/.test(url.protocol)) return 'is not a postgresql:// URL';
	if (isLocalHost(url.hostname)) return 'points at a local host';
	if (url.searchParams.get('sslmode') !== 'verify-full') return 'must use sslmode=verify-full';
	if (decodeURIComponent(url.password).length < 24) return 'has a password shorter than 24 characters (a dev login?)';
	return null;
};

/** The sender: a real domain, not the dev default's no-reply@localhost. */
const mailFrom: Check = (v) => {
	if (!set(v)) return 'is not set';
	const domain = /@([^\s>]+)>?\s*$/.exec(v)?.[1];
	if (!domain || !domain.includes('.') || isLocalHost(domain)) return 'must be an address on a real domain';
	return null;
};

/** An explicit decision, not the code default. */
const decision: Check = (v) => (v === 'true' || v === 'false' ? null : 'must be set to true or false (an explicit decision)');

const host: Check = (v) => (!set(v) ? 'is not set' : isLocalHost(v.trim()) ? 'points at a local host' : null);

const port: Check = (v) => {
	const n = Number(v);
	return Number.isInteger(n) && n > 0 && n < 65536 ? null : 'is not a port number';
};

const appPassword: Check = (v) => (set(v) && /^[A-Za-z0-9]{24,}$/.test(v) ? null : 'must be 24+ alphanumeric characters');

/** A CloudFront public key id (the signed URL's Key-Pair-Id), as Terraform's aws_cloudfront_public_key returns it. */
const cloudFrontKeyId: Check = (v) => (!set(v) ? 'is not set' : /^K[A-Z0-9]{8,}$/.test(v.trim()) ? null : 'is not a CloudFront public key id');

/** A PEM private key (openssl genpkey writes PKCS#8; PKCS#1 is accepted too). */
const pemPrivateKey: Check = (v) =>
	!set(v) ? 'is not set' : /^-----BEGIN (RSA )?PRIVATE KEY-----\r?\n[\s\S]{200,}\r?\n-----END (RSA )?PRIVATE KEY-----\s*$/.test(v.trim()) ? null : 'is not a PEM private key';

/** A PEM public key (SubjectPublicKeyInfo, as openssl pkey -pubout writes it). */
const pemPublicKey: Check = (v) =>
	!set(v) ? 'is not set' : /^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]{200,}\r?\n-----END PUBLIC KEY-----\s*$/.test(v.trim()) ? null : 'is not a PEM public key';

const unset: Check = (v) => (set(v) ? 'must not be set in production' : null);

/** The delineation DEM (delineation/dem.ts): empty (off) or an S3 object; never a local file or host, which a Lambda doesn't have. */
const demUrl: Check = (v) => {
	if (!set(v)) return null;
	const t = v.trim();
	if (/^s3:\/\/[^/]+\/.+/.test(t)) return null;
	if (/^https:\/\//.test(t)) {
		try {
			return isLocalHost(new URL(t).hostname) ? 'points at a local host' : null;
		} catch {
			return 'is not a URL';
		}
	}
	return 'must be empty (off) or s3://<bucket>/<key> (or https://)';
};

const ALL = (check: Check): Partial<Record<Role, Check>> => Object.fromEntries(ROLES.map((r) => [r, check]));

export const SETTINGS: Record<string, Setting> = {
	// --- The edge and the session ---------------------------------------------------------
	CLOUDFRONT_SHARED_SECRET: {
		why: 'CloudFront stamps it on every /api request; unset, app.ts skips the check (local dev). In Lambda it comes from the runtime secret.',
		checks: { api: secret(32) }
	},
	AUTH_JWT_SECRET: {
		why: 'Signs sessions (the API only; the worker reaches session.ts through shared modules but never calls it), and keys the run stamps (runs/stamp.ts, 077): the API and the worker (a re-run job) store runs.',
		checks: { api: secret(32), worker: secret(32) }
	},
	APP_ENCRYPTION_KEY: {
		why: 'Seals the TOTP secrets of two-step sign-in at rest (auth/secretBox.ts, 150_mfa): the API only, which enrols and checks codes.',
		checks: { api: secret(32) }
	},
	MFA_REQUIRED: {
		why: 'false turns off the second-factor requirement for owners, team admins and assessors (auth/stepUp.ts) for the DB tests and the e2e server only; mfaRequired refuses it on Lambda too.',
		checks: { api: optional(oneOf('true')), worker: optional(oneOf('true')) }
	},
	REGISTRATION_CHECK_REQUIRED: {
		why: 'false lets every project issue a pack without a recorded check of its specialist signers\' registrations, whatever the project\'s own setting (signoffs/registrationCheck.ts, 167_signers), for the DB tests and the e2e server only; registrationCheckRequired refuses it on Lambda too.',
		checks: { api: optional(oneOf('true')) }
	},
	COOKIE_SECURE: { why: 'Session cookie Secure flag; only "false" (local http) turns it off.', checks: { api: optional(oneOf('true')) } },
	ALLOWED_ORIGINS: { why: 'CORS and CSRF allowlist; defaults to the dev site.', checks: { api: publicHttpsList } },
	PASSWORD_HASH_FAST: { why: '1 hashes new passwords with the smallest Argon2id parameters, for the local e2e server only; auth/password.ts refuses it in Lambda.', checks: { api: unset, worker: unset } },
	SIGNUP_OPEN: {
		why: 'true opens sign-up to anyone; false (and unset, on Lambda) admits only the holder of a live invite for that address (auth/signupOpen.ts). Terraform var.signup_open; closed until docs/legal-status.md Gates A and C are done.',
		checks: { api: optional(oneOf('true', 'false')) }
	},
	SIGNUP_THROTTLE: {
		why: 'off turns the sign-up throttle off for the backend tests and the e2e server only (auth/signupThrottle.ts); Lambda ignores it too.',
		checks: { api: unset }
	},
	VITEST: { why: 'Set by the test runner; new password hashes use the smallest Argon2id parameters.', checks: ALL(unset) },
	AWS_LAMBDA_FUNCTION_NAME: { why: 'Set by the Lambda runtime (reserved, Terraform cannot override it): the signal that this is production.' },
	AWS_LAMBDA_LOG_FORMAT: {
		why: 'Set by the Lambda runtime from the function\'s logging_config (reserved; infra/lambda.tf local.lambda_logging): JSON makes logging/logEvent.ts log an object, so every alarm\'s filter ($.message.event) matches. Pinned to JSON on every Lambda by infra/tests/logging.tftest.hcl, not here: Terraform sets it through logging_config, not an environment block.'
	},

	// --- Runtime secrets (config/runtimeSecrets.ts) --------------------------------------
	RUNTIME_SECRET_ARN: {
		why: 'The Secrets Manager secret holding this Lambda’s secrets (RUNTIME_SECRETS), read at cold start; the secrets themselves never sit in the environment.',
		checks: { api: secretsManagerArn, worker: secretsManagerArn, migrate: secretsManagerArn }
	},
	RUNTIME_SECRET_VERSION: {
		why: 'The secret version Terraform last wrote: pins what a cold start reads, and changing it cold-starts every instance onto a rotation.',
		checks: { api: required, worker: required, migrate: required }
	},

	// --- The database ---------------------------------------------------------------------
	DATABASE_URL: { why: 'The water_app (RLS-bound) connection; in Lambda, from the runtime secret (it holds the password).', checks: { api: postgresUrl, worker: postgresUrl } },
	NODE_EXTRA_CA_CERTS: {
		why: 'Read by Node itself: the RDS CA bundle, without which sslmode=verify-full cannot connect.',
		checks: { api: required, worker: required, migrate: required }
	},
	DB_POOL_MAX: { why: 'Pool size tuning; the code default (5) is safe.' },
	DB_HOST: { why: 'The migrate Lambda builds the owner URL from these.', checks: { migrate: host } },
	DB_PORT: { why: 'Defaults to 5432.', checks: { migrate: optional(port) } },
	DB_NAME: { why: 'The database to migrate.', checks: { migrate: required } },
	MASTER_SECRET_ARN: { why: 'The RDS-managed owner credentials in Secrets Manager.', checks: { migrate: arn } },
	NODE_OPTIONS: { why: 'Read by Node itself: the migrate Lambda’s V8 heap size (infra/lambda.tf), sized for a reference load. Flags, never a credential.' },
	REFERENCE_BUCKET: {
		why: 'The private bucket a reference-dataset load reads its one file from (infra/map_data.tf, geo/referenceLoad.ts, docs/deployment.md § Reference datasets).',
		checks: { migrate: required }
	},
	WATER_APP_PASSWORD: {
		why: 'The runtime role password the migrate Lambda sets (sops db_app_password), from its runtime secret.',
		checks: { migrate: appPassword }
	},

	// --- Email -----------------------------------------------------------------------------
	MAIL_TRANSPORT: { why: 'log (the default) sends nothing; smtp is Mailpit.', checks: { api: oneOf('ses'), worker: oneOf('ses') } },
	MAIL_FROM: { why: 'The sender; the default is no-reply@localhost.', checks: { api: mailFrom, worker: mailFrom } },
	SITE_URL: { why: 'Every link in an email or share page; the default is the dev site.', checks: { api: publicHttps, worker: publicHttps } },
	SES_CONFIGURATION_SET: {
		why: 'Routes SES bounce and complaint events to the mail-events queue; without it suppression never hears of one.',
		checks: { api: required, worker: required }
	},
	SES_REGION: { why: 'Optional; the SDK uses the Lambda region.' },
	SMTP_HOST: { why: 'SMTP transport only, which production refuses (MAIL_TRANSPORT=ses).' },
	SMTP_PORT: { why: 'SMTP transport only.' },
	SMTP_SECURE: { why: 'SMTP transport only.' },
	SMTP_USER: { why: 'SMTP transport only.' },
	SMTP_PASSWORD: { why: 'SMTP transport only.' },
	MAIL_EVENTS_QUEUE_ARN: { why: 'Only records from this queue are read as SES events (lambda-worker.ts).', checks: { worker: arn } },
	OPERATOR_EMAIL: {
		why: 'The operator’s copy of the licence-record notices (licence/record.ts, 161); unset sends none and the owners still get theirs. Terraform sets it to budget_alert_email on the worker (infra/jobs.tf).'
	},

	// --- Alerts ----------------------------------------------------------------------------
	ALERTS_TOKEN_SECRET: { why: 'Signs unsubscribe and “Was this useful?” links; only the worker signs (the API checks a link by its hash). From the worker’s runtime secret.', checks: { worker: secret(32) } },
	ALERTS_ENABLED: { why: 'The alert-email kill switch: the worker must be told explicitly (Terraform var.alerts_enabled).', checks: { worker: decision } },
	ALERTS_DAILY_CAP: { why: 'Per-person immediate mails a day; the code default (5) is safe.' },
	API_PUBLIC_URL: {
		why: 'Where a mail client posts the one-click unsubscribe; defaults to SITE_URL/api.',
		checks: { api: optional(publicHttps), worker: optional(publicHttps) }
	},

	// --- Background jobs -------------------------------------------------------------------
	// The API only: wakeWorker (jobs/wake.ts) is the one reader, and the worker
	// never wakes itself (no send on the jobs queue, infra/jobs.tf; lambda-worker.test.ts).
	JOB_TRANSPORT: { why: 'inprocess (the default) wakes no Lambda worker.', checks: { api: oneOf('sqs') } },
	JOBS_QUEUE_URL: { why: 'The wake-up queue.', checks: { api: publicHttps } },
	JOB_LEASE_SECONDS: { why: 'Tick tuning; the code default is safe.' },
	JOB_MAX_PER_TICK: { why: 'Tick tuning; the code default is safe.' },
	RUNS_KEPT_PER_PROJECT: { why: 'Run retention; the code default is safe.' },

	// --- Data feeds ------------------------------------------------------------------------
	FEED_FETCHER: {
		why: 'inline (the default) fetches in the job from FEED_SOURCE; the worker has no internet, so production hands fetches to the fetcher. Other Lambdas reach it through jobs/transport.ts but run no fetch job.',
		checks: { worker: oneOf('sqs') }
	},
	FETCH_REQUESTS_QUEUE_URL: { why: 'Where the worker sends fetch requests.', checks: { worker: publicHttps } },
	FEED_SOURCE: {
		why: 'fixtures (the default) is synthetic data. Only the fetcher fetches in production; the API and worker never call feedHttp there.',
		checks: { fetcher: oneOf('live') }
	},
	INGEST_RESULTS_QUEUE_URL: { why: 'Where the fetcher answers.', checks: { fetcher: publicHttps } },

	// --- Reports ---------------------------------------------------------------------------
	REPORT_RENDERER: {
		why: 'inline (the default) renders in the job; the worker has no Chromium, so production hands renders to the renderer. Other Lambdas reach it through jobs/transport.ts but run no render job.',
		checks: { worker: oneOf('sqs') }
	},
	RENDER_REQUESTS_QUEUE_URL: { why: 'Where the worker sends render requests.', checks: { worker: publicHttps } },
	RENDER_RESULTS_QUEUE_URL: { why: 'Where the renderer answers.', checks: { renderer: publicHttps } },
	RENDER_SITE_URL: {
		why: 'The site the renderer prints; the default is the dev site. Only the renderer renders in production.',
		checks: { renderer: publicHttps, api: optional(publicHttps), worker: optional(publicHttps) }
	},
	RENDER_API_URL: {
		why: 'The API the renderer signs in to; the default is the dev API.',
		checks: { renderer: publicHttps, api: optional(publicHttps), worker: optional(publicHttps) }
	},
	REPORT_RENDER_TIMEOUT_MS: { why: 'Render time limit; out-of-range values fall back to the safe default.' },
	CHROMIUM_PATH: { why: 'A Chromium other than Playwright’s own; the renderer image uses the bundled one.' },
	STORAGE: { why: 'local (the default) is MinIO with its public dev login.', checks: { api: oneOf('s3'), worker: oneOf('s3'), renderer: oneOf('s3') } },
	REPORT_DOWNLOADS: {
		why: 'presigned (the default) signs S3 GETs, which reach the bucket outside CloudFront and the WAF; production signs CloudFront URLs on the site’s /reports/* path (reports/storage.ts). The worker and renderer reach storage.ts but never sign a download.',
		checks: { api: oneOf('cloudfront') }
	},
	CLOUDFRONT_KEY_PAIR_ID: { why: 'The distribution’s trusted public key that verifies download signatures (infra/reports.tf).', checks: { api: cloudFrontKeyId } },
	CLOUDFRONT_PUBLIC_KEY: {
		why: 'The public half of the signing key (report_download_public_keys[report_download_signing_key]); lambda.ts refuses to start unless CLOUDFRONT_PRIVATE_KEY pairs with it.',
		checks: { api: pemPublicKey }
	},
	CLOUDFRONT_PRIVATE_KEY: {
		why: 'Signs report downloads (its public half is in the distribution’s key group). From the API’s runtime secret.',
		checks: { api: pemPrivateKey }
	},
	DEM_URL: {
		why: 'The DEM catchment delineation reads (delineation/dem.ts, issue #326 B-delineate): empty turns it off. The API delineates around a click; the worker delineates a catchment too large for the request (the delineate job, 191). The other Lambdas never call configuredDem.',
		checks: { api: demUrl, worker: demUrl }
	},
	DEM_LABEL: { why: 'The DEM’s name on each proposal; empty takes the archive’s own. A label, never a credential or a switch.' },
	WATER_URL: {
		why: 'The water occurrence raster tracing a dam reads (delineation/damTrace.ts, issue #326 C2): empty turns it off. The same forms and checks as DEM_URL; only the API traces.',
		checks: { api: demUrl }
	},
	WATER_LABEL: { why: 'The water occurrence dataset’s name on each traced outline; empty takes the archive’s own. A label, never a credential or a switch.' },
	REPORTS_BUCKET: { why: 'The private reports bucket.', checks: { api: required, worker: required, renderer: required } },
	PACKS_BUCKET: {
		why: 'The evidence packs bucket (Object Lock; infra/packs.tf). The renderer stores a pack PDF; the worker HEADs it before recording the hash the renderer answered with (jobs/handlers/pack-render.ts); the API stores a pack’s reproduction bundle when it issues the pack (evidence/bundle.ts) and signs both downloads as CloudFront URLs on /packs/*.',
		checks: { api: required, worker: required, renderer: required }
	},
	S3_ENDPOINT: { why: 'MinIO only (STORAGE=local), which production refuses; STORAGE=s3 ignores it.' },
	S3_REGION: { why: 'MinIO only.' },
	S3_ACCESS_KEY_ID: { why: 'MinIO only.' },
	S3_SECRET_ACCESS_KEY: { why: 'MinIO only.' }
};

/** What is wrong with `env` for `role` in production: one line per setting, naming it but never its value. */
export function productionEnvProblems(role: Role, env: Env): string[] {
	const problems: string[] = [];
	for (const [name, setting] of Object.entries(SETTINGS)) {
		const check = setting.checks?.[role];
		const p = check?.(env[name]);
		if (p) problems.push(`${name} ${p}`);
	}
	// A committed placeholder in any setting at all (dev-only-…, test-only-…).
	for (const [name, value] of Object.entries(env)) {
		if (value && PLACEHOLDER.test(value) && !problems.some((p) => p.startsWith(`${name} `))) problems.push(`${name} is a committed dev/test placeholder`);
	}
	return problems;
}

/** Throw unless `env` is production-shaped for `role`. */
export function assertProductionEnv(role: Role, env: Env = process.env): void {
	const problems = productionEnvProblems(role, env);
	if (problems.length) throw new Error(`refusing to start the ${role} Lambda: ${problems.join('; ')}`);
}

/**
 * The entry points' init check: in Lambda (the runtime always sets
 * AWS_LAMBDA_FUNCTION_NAME), refuse to start with a local default. Off Lambda
 * (tests, a local call of a handler) it does nothing.
 */
export function assertLambdaEnv(role: Role, env: Env = process.env): void {
	if (env.AWS_LAMBDA_FUNCTION_NAME) assertProductionEnv(role, env);
}
