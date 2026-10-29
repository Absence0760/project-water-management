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

// `assistant` is the AI assistant's own Lambda (lambda-assistant.ts, issue
// #610): the API's bundle and app, serving only the assistant's routes, with a
// longer timeout and the one role that may call the model (infra/assistant.tf).
export const ROLES = ['api', 'worker', 'fetcher', 'renderer', 'migrate', 'assistant'] as const;
export type Role = (typeof ROLES)[number];

type Env = Record<string, string | undefined>;
/**
 * A problem with the value (unset included), or null when it is fine. `env`,
 * the whole environment, is for a check that depends on another setting
 * (MIRROR_URL on CHIRPS_SOURCE); without it (requiredFor in the guard test)
 * the check answers for the setting alone.
 */
type Check = (value: string | undefined, env?: Env) => string | null;

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

/** An S3 URL (s3://bucket/…): our copy of CHIRPS in its bucket, never the committed fixtures (a file path) or a local store. */
const s3Url: Check = (v) => (!set(v) ? 'is not set' : /^s3:\/\/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9](\/.*)?$/.test(v.trim()) ? null : 'is not an s3:// URL');

/**
 * MIRROR_URL on the worker: required when it reads the copy (CHIRPS_SOURCE=mirror), hands the weekly DWS pass its stations
 * (DWS_WEEKLY=on), runs the dams tick (DAM_OBSERVATIONS=on, which reads the passes' files from the bucket) or the observed ET tick
 * (ET_OBSERVATIONS=on, the same), else checked only when set.
 */
const mirrorUrlFor: Check = (v, env) =>
	env?.CHIRPS_SOURCE?.trim() === 'mirror' || env?.DWS_WEEKLY?.trim() === 'on' || env?.DAM_OBSERVATIONS?.trim() === 'on' || env?.ET_OBSERVATIONS?.trim() === 'on'
		? s3Url(v)
		: optional(s3Url)(v);

/**
 * Whether the worker's feeds all read our copy and store (CHIRPS_SOURCE=mirror
 * and DWS_SOURCE=store): then no fetch goes to the fetcher, and Terraform
 * creates no fetch-requests queue (infra/feeds.tf local.per_feed_fetching).
 */
const perFeedFetchingOff = (env?: Env) => env?.CHIRPS_SOURCE?.trim() === 'mirror' && env?.DWS_SOURCE?.trim() === 'store';

/** FEED_FETCHER on the worker: sqs while any feed still fetches through the fetcher; unset only once none does (it then never sends). */
const feedFetcherFor: Check = (v, env) =>
	set(v) ? oneOf('sqs')(v) : perFeedFetchingOff(env) ? null : 'is not set (production needs sqs while CHIRPS_SOURCE=chc or DWS_SOURCE=live)';

/** FETCH_REQUESTS_QUEUE_URL on the worker: required with FEED_FETCHER=sqs (a send to no queue fails every fetch), else checked only when set. */
const fetchRequestsUrlFor: Check = (v, env) => (env === undefined || env.FEED_FETCHER?.trim() === 'sqs' ? publicHttps(v) : optional(publicHttps)(v));

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

/** A pg pool size (DB_POOL_MAX): set, and a whole number of at least 1. */
const poolSize: Check = (v) => {
	if (!set(v)) return 'is not set';
	const n = Number(v.trim());
	return Number.isInteger(n) && n >= 1 ? null : 'must be a whole number of at least 1';
};

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

/**
 * An email address's shape (FEEDS_CONTACT): a plain local part, a dotted
 * domain of letters, digits and hyphens. Nothing that could break out of the
 * user agent it goes into (feeds/http.ts userAgent reads it with this too).
 */
export const FEEDS_CONTACT_RE = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
/** Domains no one reads mail at (RFC 2606 / 6761), refused as infra/variables.tf refuses them for budget_alert_email and feeds_contact. */
const RESERVED_MAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost|local)$/i;
/** A template's local part, left unedited: you@…, your-email@…, changeme@…. */
const PLACEHOLDER_LOCAL = /^(you|your|yourname|your[._-]?(e-?mail|name|address)|e-?mail|name|user|someone|somebody|changeme|change[._-]me|replace[._-]?me|todo|xxx+|foo|test)$/i;

/** A contact CHC can write to (feeds/http.ts userAgent): an address, not a reserved domain or a template's. */
const contactEmail: Check = (v) => {
	if (!set(v)) return 'is not set';
	const t = v.trim();
	if (!FEEDS_CONTACT_RE.test(t)) return 'is not an email address (name@domain.tld)';
	const [local, domain] = t.split('@') as [string, string];
	if (RESERVED_MAIL_DOMAIN.test(domain) || isLocalHost(domain)) return 'is at a reserved domain no one reads mail at';
	if (PLACEHOLDER_LOCAL.test(local)) return 'is a placeholder address';
	return null;
};

/** A whole number of at least 1 (the assistant's limits): the code falls back to its default on anything else, so production refuses it instead. */
const wholeNumber: Check = (v) => {
	if (!set(v)) return 'is not set';
	const n = Number(v.trim());
	return Number.isInteger(n) && n >= 1 ? null : 'must be a whole number of at least 1';
};

/** A whole number from `min` to `max` (the assistant's keepalive, against CloudFront's origin read timeout). */
const wholeNumberIn =
	(min: number, max: number): Check =>
	(v) => {
		if (!set(v)) return 'is not set';
		const n = Number(v.trim());
		return Number.isInteger(n) && n >= min && n <= max ? null : `must be a whole number from ${min} to ${max}`;
	};

/**
 * A Bedrock model id the assistant may name: Anthropic's, in-region
 * (anthropic.…) or through a system inference profile (global., us., eu., …),
 * or an inference profile's ARN. Never an Ollama tag or an Anthropic API id
 * (claude-…), which would only fail at the first message.
 */
const bedrockModelId: Check = (v) => {
	if (!set(v)) return 'is not set';
	const t = v.trim();
	if (/^((global|us|eu|apac|au|jp|ca)\.)?anthropic\.[A-Za-z0-9.:_-]+$/.test(t)) return null;
	if (/^arn:aws[a-z-]*:bedrock:[a-z0-9-]+:\d{12}:(application-)?inference-profile\/[A-Za-z0-9.:_-]+$/.test(t)) return null;
	return 'is not an Anthropic model id on Bedrock (anthropic.…, global.anthropic.…) or an inference profile ARN';
};

/**
 * The region the assistant calls Bedrock in: the Lambda's own (AWS_REGION, set
 * by the runtime), whose bedrock-runtime VPC endpoint it reaches. The VPC has
 * no route anywhere else, so another region would fail every message.
 */
const bedrockRegion: Check = (v, env) => {
	if (!set(v)) return 'is not set';
	const own = env?.AWS_REGION?.trim();
	return own && v.trim() !== own ? 'must be the Lambda’s own region (AWS_REGION): its bedrock-runtime VPC endpoint is there, and the VPC has no route to another' : null;
};

const ALL = (check: Check): Partial<Record<Role, Check>> => Object.fromEntries(ROLES.map((r) => [r, check]));

export const SETTINGS: Record<string, Setting> = {
	// --- The edge and the session ---------------------------------------------------------
	CLOUDFRONT_SHARED_SECRET: {
		why: 'CloudFront stamps it on every /api request (the assistant’s origin too); unset, app.ts skips the check (local dev). In Lambda it comes from the runtime secret.',
		checks: { api: secret(32), assistant: secret(32) }
	},
	AUTH_JWT_SECRET: {
		why: 'Signs sessions (the API, and the assistant, which checks the session of each message; the worker reaches session.ts through shared modules but never calls it), and keys the run stamps (runs/stamp.ts, 077): the API and the worker (a re-run job) store runs.',
		checks: { api: secret(32), worker: secret(32), assistant: secret(32) }
	},
	APP_ENCRYPTION_KEY: {
		why: 'Seals the TOTP secrets of two-step sign-in at rest (auth/secretBox.ts, 150_mfa): the API only, which enrols and checks codes.',
		checks: { api: secret(32) }
	},
	MFA_REQUIRED: {
		why: 'false turns off the second-factor requirement (auth/stepUp.ts: the actions that always need it, and owners\' and team admins\' where a project or team requires it) for the DB tests and the e2e server only; mfaRequired refuses it on Lambda too.',
		checks: { api: optional(oneOf('true')), worker: optional(oneOf('true')), assistant: optional(oneOf('true')) }
	},
	REGISTRATION_CHECK_REQUIRED: {
		why: 'false lets every project issue a pack without a recorded check of its specialist signers\' registrations, whatever the project\'s own setting (signoffs/registrationCheck.ts, 167_signers), for the DB tests and the e2e server only; registrationCheckRequired refuses it on Lambda too.',
		checks: { api: optional(oneOf('true')) }
	},
	COOKIE_SECURE: { why: 'Session cookie Secure flag; only "false" (local http) turns it off.', checks: { api: optional(oneOf('true')), assistant: optional(oneOf('true')) } },
	ALLOWED_ORIGINS: { why: 'CORS and CSRF allowlist; defaults to the dev site. The assistant’s messages are POSTs, so it checks it as the API does.', checks: { api: publicHttpsList, assistant: publicHttpsList } },
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
	AWS_REGION: {
		why: 'Set by the Lambda runtime (reserved): the function’s region. The assistant’s Bedrock region defaults to it (assistant/config.ts), and ASSISTANT_BEDROCK_REGION must equal it in production (its VPC endpoint is in that region).'
	},
	AWS_LAMBDA_LOG_FORMAT: {
		why: 'Set by the Lambda runtime from the function\'s logging_config (reserved; infra/lambda.tf local.lambda_logging): JSON makes logging/logEvent.ts log an object, so every alarm\'s filter ($.message.event) matches. Pinned to JSON on every Lambda by infra/tests/logging.tftest.hcl, not here: Terraform sets it through logging_config, not an environment block.'
	},

	// --- Runtime secrets (config/runtimeSecrets.ts) --------------------------------------
	RUNTIME_SECRET_ARN: {
		why: 'The Secrets Manager secret holding this Lambda’s secrets (RUNTIME_SECRETS), read at cold start; the secrets themselves never sit in the environment.',
		checks: { api: secretsManagerArn, worker: secretsManagerArn, migrate: secretsManagerArn, assistant: secretsManagerArn }
	},
	RUNTIME_SECRET_VERSION: {
		why: 'The secret version Terraform last wrote: pins what a cold start reads, and changing it cold-starts every instance onto a rotation.',
		checks: { api: required, worker: required, migrate: required, assistant: required }
	},

	// --- The database ---------------------------------------------------------------------
	DATABASE_URL: {
		why: 'The water_app (RLS-bound) connection; in Lambda, from the runtime secret (it holds the password).',
		checks: { api: postgresUrl, worker: postgresUrl, assistant: postgresUrl }
	},
	NODE_EXTRA_CA_CERTS: {
		why: 'Read by Node itself: the RDS CA bundle, without which sslmode=verify-full cannot connect.',
		checks: { api: required, worker: required, migrate: required, assistant: required }
	},
	DB_POOL_MAX: {
		why: 'The pg pool per container (db/pool.ts poolMax): Terraform sets 2 for the API and the worker and 1 for the assistant (one message per container, each holding at most one connection at a time), and each cap × its pool is what the database’s connections are sized on (infra/README.md § Connections, issue #541). Unset would be the local default of 5, past the sizing, so all three check it.',
		checks: { api: poolSize, worker: poolSize, assistant: poolSize }
	},
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
		why: 'inline (the default) fetches in the job from FEED_SOURCE; the worker has no internet, so production hands fetches to the fetcher while any feed fetches per feed (CHIRPS_SOURCE=chc or DWS_SOURCE=live). With both on our copy and store (mirror and store) no fetch leaves the job and Terraform sets it no more (infra/feeds.tf local.per_feed_fetching, issue #604 R3-C); a live request from the worker is refused anyway (feeds/http.ts assertLiveFeedRequestsAllowed). Other Lambdas reach it through jobs/transport.ts but run no fetch job.',
		checks: { worker: feedFetcherFor }
	},
	FETCH_REQUESTS_QUEUE_URL: { why: 'Where the worker sends fetch requests: required with FEED_FETCHER=sqs; Terraform sets it only while the queue exists.', checks: { worker: fetchRequestsUrlFor } },
	FEED_SOURCE: {
		why: 'fixtures (the default) is synthetic data. Only the fetcher fetches in production, but it is also which CHIRPS cell cache a process reads (feeds/cellCacheStore.ts cacheOrigin: live reads the chc rows the worker merges, fixtures a set production never fills), so a run started on the API with it unset reads no CHIRPS cell for its reference cell or rainfall stations, and the Data feeds panel calls live feeds sample data. Every Lambda that reaches it must say live (the assistant too: it carries the API’s modules, and its tools read the same runs and feeds).',
		checks: { api: oneOf('live'), worker: oneOf('live'), fetcher: oneOf('live'), assistant: oneOf('live') }
	},
	INGEST_RESULTS_QUEUE_URL: {
		why: 'Where the fetcher answers a per-feed fetch request. Terraform sets it only while the queues exist (infra/feeds.tf local.per_feed_fetching, issue #604 R3-C); without them the fetcher has no SQS trigger and runs only its scheduled modes, which never send, so it is checked only when set (a stray request with none still fails loudly: jobs/transport.ts sendToQueue).',
		checks: { fetcher: optional(publicHttps) }
	},
	CHIRPS_SOURCE: {
		why: 'Which CHIRPS a feed fetch reads (mirror/source.ts, issue #604): chc, CHC’s files through the fetcher, or mirror, our copy read in the worker’s own fetch job (feeds/fromMirror.ts). The API reads it too, only to know whether the Data feeds panel reports the copy (feeds/rainCopy.ts, from the mirror_copy rows the worker records; the API never reaches the copy). Unset follows FEED_SOURCE (chc when live, which production checks), so unset is today’s production behaviour: a release that reads it can go out before the terraform apply that sets it (from var.chirps_source, infra/jobs.tf, infra/lambda.tf) without refusing to start. A value set is checked.',
		checks: { api: optional(oneOf('chc', 'mirror')), worker: optional(oneOf('chc', 'mirror')) }
	},
	MIRROR_URL: {
		why: 'Where our copy of CHIRPS lives (mirror/source.ts mirrorUrl): s3://<the mirror bucket> (infra/ingest.tf). Unset off Lambda is the committed synthetic copy, which a live process refuses. The worker needs it when CHIRPS_SOURCE=mirror; the ingest Lambdas (the fetcher’s daily ingest, issue #604 R2-B) write it, and Terraform sets it on the fetcher always (infra/feeds.tf), so the fetcher must name the bucket.',
		checks: { worker: mirrorUrlFor, fetcher: s3Url }
	},
	DWS_SOURCE: {
		why: 'Where a DWS feed fetch reads its station’s days (feeds/fromGaugeRecord.ts, issue #604 R3-B): live, DWS’s site through the fetcher, or store, our gauge_record table in the worker’s own fetch job. Unset follows FEED_SOURCE (live when live), today’s production behaviour, so a release can go out before the apply that sets it. Terraform sets it from var.dws_source (infra/jobs.tf), live until the operator has DWS’s written answer and has loaded its reply. A value set is checked.',
		checks: { worker: optional(oneOf('store', 'live')) }
	},
	DWS_WEEKLY: {
		why: 'on: the worker hands the weekly DWS pass its stations and loads what it fetched (feeds/gaugeRecordLoad.ts), through the mirror bucket, so MIRROR_URL must name it. Terraform sets it from var.dws_weekly_enabled (infra/jobs.tf), with the schedule and the grants. Unset is off (gaugeRecordLoad.ts), today’s production behaviour, so a release can go out before that apply; a value set is checked.',
		checks: { worker: optional(oneOf('on', 'off')) }
	},
	FEEDS_CONTACT: {
		why: 'The contact address in the live feed client\'s user agent (feeds/http.ts userAgent), which CHC asked for (2026-10-27, issue #604): who they write to before blocking us. Only the fetcher asks a source in production (feeds/http.ts assertLiveFeedRequestsAllowed), for per-feed fetches and its scheduled modes alike, so only it must have one (Terraform var.feeds_contact); elsewhere it is optional and the agent goes without.',
		checks: { fetcher: contactEmail }
	},
	DAM_OBSERVATIONS: {
		why: 'on: the worker runs the dams tick (dams/observed/tick.ts, issue #604 R5): matches traced dams, writes the passes’ wanted list and loads what they fetched, through the mirror bucket, so MIRROR_URL must name it. Terraform is to set it from var.dam_observations_enabled (infra/jobs.tf; dam_observations.tf refuses the flag until it does). Unset is off (damObservationsOn), today’s production behaviour, so a release can go out before that apply; a value set is checked. The API reaches it through jobs/runner.ts but runs no tick.',
		checks: { worker: optional(oneOf('on', 'off')) }
	},
	DAM_OBSERVATIONS_S2: {
		why: 'on: the fetcher’s dams-weekly run adds the Sentinel-2 pass after WOfS (dams/observed/sentinel/pass.ts, issue #624; damSourceOn), still only while the dam observations are on. Terraform sets it from var.dam_s2_enabled, and only while dam_observations_enabled is (infra/feeds.tf, local.dam_s2_on). Unset is off, so a release can go out before that apply; a value set is checked.',
		checks: { fetcher: optional(oneOf('on', 'off')) }
	},
	DAM_OBSERVATIONS_S1: {
		why: 'on: the fetcher’s dams-weekly run adds the Sentinel-1 radar pass after Sentinel-2’s, and the S1/S2 agreement report (dams/observed/sentinel/pass.ts and agreement.ts, issue #624 step 5; damSourceOn), still only while the dam observations are on. Terraform sets it from var.dam_s1_enabled, and only while dam_observations_enabled is (infra/feeds.tf, local.dam_s1_on). Unset is off, so a release can go out before that apply; a value set is checked.',
		checks: { fetcher: optional(oneOf('on', 'off')) }
	},
	ET_OBSERVATIONS: {
		why: 'on: the worker runs the observed ET tick (water-use/observed/tick.ts, issue #623): writes the WaPOR pass’s wanted list (each unit’s parcels and their cropland) and loads what it fetched, through the mirror bucket, so MIRROR_URL must name it. Terraform sets it from var.et_observations_enabled (infra/jobs.tf; et_observations.tf refuses the flag without it), off until FAO confirms the licence (#618 8a). Unset is off (etObservationsOn), so a release can go out before that apply; a value set is checked. The API runs no tick: Terraform sets the same value there (infra/lambda.tf) so GET …/et-observed can say `enabled` (water-use/observed/routes.ts), and unset reads as off.',
		checks: { worker: optional(oneOf('on', 'off')), api: optional(oneOf('on', 'off')) }
	},
	FEED_FIXTURE_REWRITE: {
		why: 'Fixtures only (FEED_SOURCE=fixtures): 1 serves some synthetic CHIRPS finals rewritten in place, to watch the re-check locally. The live client never reads it, and the fetcher refuses the fixtures in production.'
	},

	// --- The assistant (issue #610) ----------------------------------------------------------
	// Two Lambdas reach assistant/config.ts: the assistant's own, which runs the
	// chat, and the API, which answers GET /projects/:id/assistant (whether the
	// chat is on, and the project's tokens left this month) and never calls a
	// model. Terraform gives both the same values (infra/assistant.tf), so the
	// status the page shows is what the assistant enforces. Unset on the API is
	// off (the chat hidden), today's behaviour, so an API release can go out
	// before the apply that sets them; a value set is checked.
	ASSISTANT_PROVIDER: {
		why: 'Which model the assistant talks to (assistant/config.ts). off (the default) hides the chat; mock (scripted answers, tests and e2e) and ollama (a local model) are dev only, and anthropic needs the internet, which no VPC Lambda has (the out-of-VPC proxy it would need is not built: docs/followups.md). Production runs bedrock, through the VPC endpoint with an IAM permission and no key (infra/assistant.tf).',
		checks: { api: optional(oneOf('off', 'bedrock')), assistant: oneOf('bedrock') }
	},
	ASSISTANT_MODEL: {
		why: 'The model id the provider asks for; empty takes the provider’s default. On Bedrock it is the one model or inference profile the assistant’s IAM policy and its endpoint policy allow (var.assistant_model_id), so the assistant must name it. The API never calls a model.',
		checks: { api: optional(bedrockModelId), assistant: bedrockModelId }
	},
	ASSISTANT_BEDROCK_REGION: {
		why: 'The region the Bedrock client calls; unset is AWS_REGION. Terraform sets the Lambda’s own, where its bedrock-runtime endpoint is (a global inference profile still routes the request on from there: docs/deployment.md § The assistant).',
		checks: { assistant: bedrockRegion }
	},
	OLLAMA_URL: {
		why: 'The ollama provider’s base URL (a local model), which production refuses (ASSISTANT_PROVIDER). Refused when set too, so a Lambda can never be pointed at another host’s model by an environment change alone.',
		checks: { api: unset, assistant: unset }
	},
	ANTHROPIC_BASE_URL: {
		why: 'Read by the Anthropic SDK itself (providers/anthropic.ts), so it would send a dev provider’s requests to another host. Production refuses the anthropic provider, and this with it: no Lambda may hold it.',
		checks: { api: unset, assistant: unset }
	},
	ANTHROPIC_API_KEY: {
		why: 'The anthropic provider’s key (providers/anthropic.ts). Production runs Bedrock (IAM, no key) and refuses the anthropic provider, so no Lambda may hold one: in the environment it is readable by any GetFunctionConfiguration caller, and a key belongs in a runtime secret if that route is ever built (docs/followups.md).',
		checks: { api: unset, assistant: unset }
	},
	// The caps, in weighted tokens (input + 5 × output, assistant/config.ts weightedTokens). Terraform sets every one
	// (infra/assistant.tf), validated to the same bounds (infra/variables.tf), so production refuses a value outside them.
	ASSISTANT_TOKENS_PER_MONTH: {
		why: 'Weighted tokens one project may use in a calendar month. The code falls back to its default (2 M) on a value it can’t read, so production refuses one; the API reads it for the budget the status shows. Terraform var.assistant_tokens_per_month.',
		checks: { api: optional(wholeNumberIn(1, 20_000_000)), assistant: wholeNumberIn(1, 20_000_000) }
	},
	ASSISTANT_TOKENS_PER_USER_MONTH: {
		why: 'Weighted tokens one person may use in a calendar month, across projects, so no one account spends the deployment’s month. Terraform var.assistant_tokens_per_user_month.',
		checks: { api: optional(wholeNumberIn(1, 20_000_000)), assistant: wholeNumberIn(1, 20_000_000) }
	},
	ASSISTANT_TOKENS_PER_MONTH_TOTAL: {
		why: 'Weighted tokens the whole deployment may use in a calendar month: the cap no number of projects or accounts gets past. Terraform derives it from var.assistant_budget_monthly_usd at the model’s input price (infra/assistant.tf).',
		checks: { api: optional(wholeNumberIn(1, 200_000_000)), assistant: wholeNumberIn(1, 200_000_000) }
	},
	ASSISTANT_MESSAGES_PER_HOUR: {
		why: 'Messages one user may send in an hour (the 429 with Retry-After). Terraform var.assistant_messages_per_hour; a value set is checked, as ASSISTANT_TOKENS_PER_MONTH.',
		checks: { api: optional(wholeNumberIn(1, 120)), assistant: wholeNumberIn(1, 120) }
	},
	ASSISTANT_MAX_HOPS: {
		why: 'Model calls in one turn (var.assistant_max_hops). Checked when set: the code default (6) is safe.',
		checks: { api: optional(wholeNumberIn(1, 12)), assistant: optional(wholeNumberIn(1, 12)) }
	},
	ASSISTANT_MAX_TURN_TOKENS: {
		why: 'Weighted tokens one turn may use, every hop together; the turn ends with an error event past it. Terraform var.assistant_max_turn_tokens.',
		checks: { api: optional(wholeNumberIn(10_000, 1_000_000)), assistant: wholeNumberIn(10_000, 1_000_000) }
	},
	ASSISTANT_MAX_TOOL_CALLS_PER_HOP: {
		why: 'Tool calls run from one model call; the rest get an error result. Terraform var.assistant_max_tool_calls_per_hop.',
		checks: { api: optional(wholeNumberIn(1, 10)), assistant: wholeNumberIn(1, 10) }
	},
	ASSISTANT_MAX_OUTPUT_TOKENS: { why: 'Output tokens per model call. Terraform sets it.', checks: { api: optional(wholeNumberIn(256, 8192)), assistant: wholeNumberIn(256, 8192) } },
	ASSISTANT_MAX_TOOL_RESULT_CHARS: {
		why: 'The cap on one tool result the model sees. Terraform sets it.',
		checks: { api: optional(wholeNumberIn(1000, 50_000)), assistant: wholeNumberIn(1000, 50_000) }
	},
	ASSISTANT_MAX_INPUT_CHARS: {
		why: 'The cap on the conversation the page sends. Terraform sets it.',
		checks: { api: optional(wholeNumberIn(1000, 200_000)), assistant: wholeNumberIn(1000, 200_000) }
	},
	ASSISTANT_KEEPALIVE_SECONDS: {
		why: 'Seconds between `: keepalive` comments on the stream. CloudFront cuts a response after its origin read timeout with nothing sent (60 s on the assistant’s origin, infra/s3_cloudfront.tf), so production keeps it from 1 to 30 s; unset is the code default (15).',
		checks: { assistant: optional(wholeNumberIn(1, 30)) }
	},
	ASSISTANT_TURN_SECONDS: {
		why: 'How long one turn may run before it ends with an error event. Terraform sets it below the assistant Lambda’s timeout (var.assistant_timeout_seconds less 15), so a long turn ends cleanly and is charged rather than cut off by the runtime. Checked when set.',
		checks: { assistant: optional(wholeNumber) }
	},

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
	FUTURE_YIELD: {
		why: 'The evidence pack’s § 8 Future yield (future/store.ts, issue #621): on or off, unset is off. The API reads it to queue the job and to put § 8 in a report; the worker (the job, a report it renders) and the assistant (which builds reports) reach it too. Unset in Terraform, so production stays off; set on only once the copy holds every model’s whole windows (deployment.md § NEX-GDDP-CMIP6).',
		checks: { api: optional(oneOf('on', 'off')), worker: optional(oneOf('on', 'off')), assistant: optional(oneOf('on', 'off')) }
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
		const p = check?.(env[name], env);
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
