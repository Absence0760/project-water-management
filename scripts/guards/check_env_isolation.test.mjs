import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEnvFile, checkTrackedFiles, hostsIn, isLocalHost, parseEnv } from './check_env_isolation.mjs';

test('tracked-file allowlist: dev defaults, examples and the production build default only', () => {
	const ok = [
		'backend/.env.development',
		'frontend/.env.development',
		'frontend/.env.production',
		'backend/.env.example',
		'infra/prod.sops.yaml.example',
		'README.md',
		'frontend/src/lib/env.ts',
	];
	assert.deepEqual(checkTrackedFiles(ok), []);

	const bad = checkTrackedFiles(['.env', 'backend/.env.local', 'backend/.env.production', 'backend/.env.development.local']);
	assert.deepEqual(
		bad.map((f) => f.file),
		['.env', 'backend/.env.local', 'backend/.env.production', 'backend/.env.development.local'],
	);
});

test('sops payloads and sops config are refused, key-list examples are not', () => {
	const bad = checkTrackedFiles(['.sops.yaml', 'infra/prod.sops.yaml', 'x/secrets.sops.json', 'y/a.sops']);
	assert.equal(bad.length, 4);
	assert.ok(bad.every((f) => /sops/.test(f.rule)));
	assert.deepEqual(checkTrackedFiles(['infra/prod.sops.yaml.example']), []);
});

test('parseEnv skips comments and blanks, strips quotes, keeps line numbers', () => {
	const e = parseEnv('# c\n\nA=1\nB="two"\n  # indented comment\nexport C=3\nnot a pair\n');
	assert.deepEqual(e, [
		{ line: 3, key: 'A', value: '1' },
		{ line: 4, key: 'B', value: 'two' },
		{ line: 6, key: 'C', value: '3' },
	]);
});

test('hostsIn finds every scheme host, credentials and ports stripped', () => {
	assert.deepEqual(hostsIn('postgresql://u:p@127.0.0.1:5434/db'), ['127.0.0.1']);
	assert.deepEqual(hostsIn('http://localhost:7777,https://example.com/x'), ['localhost', 'example.com']);
	assert.deepEqual(hostsIn('http://[::1]:3000'), ['::1']);
	assert.deepEqual(hostsIn('/api'), []);
	assert.ok(isLocalHost('app.localhost'));
	assert.ok(!isLocalHost('localhost.evil.com'));
});

const devOk = [
	'ALLOWED_ORIGINS=http://localhost:7777',
	'DATABASE_URL=postgresql://water_app:water_app@127.0.0.1:5434/water',
	'SMTP_HOST=127.0.0.1',
	'AUTH_JWT_SECRET=dev-only-jwt-secret-change-me-0000000000',
	'CLOUDFRONT_SHARED_SECRET=',
	'# SITE_URL=https://water-management.example.com (comments may name real hosts)',
].join('\n');

test('a local-only backend dev default passes (positive control)', () => {
	assert.deepEqual(checkEnvFile('backend/.env.development', devOk), []);
});

test('a non-local host in a dev default fails, and the value is not echoed', () => {
	const f = checkEnvFile('backend/.env.development', 'DATABASE_URL=postgresql://u:hunter2@db.prod.internal:5432/water\n');
	assert.equal(f.length, 1);
	assert.equal(f[0].line, 1);
	assert.doesNotMatch(f[0].rule, /hunter2|prod\.internal/);
	assert.equal(checkEnvFile('backend/.env.development', 'SMTP_HOST=email-smtp.eu-west-1.amazonaws.com').length, 1);
});

test('placeholders must stay placeholders', () => {
	assert.match(checkEnvFile('backend/.env.development', 'AUTH_JWT_SECRET=4f9c0e...real').map((f) => f.rule).join(), /dev-only-/);
	// The alert unsubscribe-token key (WP-2.13): the same rule (positive control first).
	assert.deepEqual(checkEnvFile('backend/.env.development', 'ALERTS_TOKEN_SECRET=dev-only-alerts-token-secret-000000000\n'), []);
	assert.match(checkEnvFile('backend/.env.development', 'ALERTS_TOKEN_SECRET=9d1e...real').map((f) => f.rule).join(), /ALERTS_TOKEN_SECRET is no longer the dev-only-/);
	// The TOTP sealing key (two-step sign-in, issue #282).
	assert.deepEqual(checkEnvFile('backend/.env.development', 'APP_ENCRYPTION_KEY=dev-only-app-encryption-key-0000000000000000\n'), []);
	assert.match(checkEnvFile('backend/.env.development', 'APP_ENCRYPTION_KEY=0a1b...real').map((f) => f.rule).join(), /APP_ENCRYPTION_KEY is no longer the dev-only-/);
	assert.match(checkEnvFile('backend/.env.development', 'CLOUDFRONT_SHARED_SECRET=abc').map((f) => f.rule).join(), /empty/);
	// Object storage: MinIO's local default login passes (positive control); anything else fails.
	assert.deepEqual(checkEnvFile('backend/.env.development', 'STORAGE=local\nS3_ACCESS_KEY_ID=minioadmin\nS3_SECRET_ACCESS_KEY=minioadmin\n'), []);
	assert.match(checkEnvFile('backend/.env.development', 'S3_ACCESS_KEY_ID=someone-elses-key').map((f) => f.rule).join(), /minioadmin/);
	assert.match(checkEnvFile('backend/.env.development', 'S3_SECRET_ACCESS_KEY=not-the-default').map((f) => f.rule).join(), /minioadmin/);
	assert.deepEqual(checkEnvFile('backend/.env.development', 'REPORT_DOWNLOADS=presigned\n'), []);
	assert.match(checkEnvFile('backend/.env.development', 'REPORT_DOWNLOADS=cloudfront').map((f) => f.rule).join(), /REPORT_DOWNLOADS must be presigned/);
	assert.match(checkEnvFile('backend/.env.development', 'CLOUDFRONT_PRIVATE_KEY=-----BEGIN').map((f) => f.rule).join(), /CLOUDFRONT_PRIVATE_KEY must stay unset/);
	assert.match(checkEnvFile('backend/.env.development', 'CLOUDFRONT_KEY_PAIR_ID=K2JCJMDEHXQW5F').map((f) => f.rule).join(), /CLOUDFRONT_KEY_PAIR_ID must stay unset/);
	assert.match(checkEnvFile('backend/.env.development', 'STORAGE=s3').map((f) => f.rule).join(), /local/);
});

test('frontend env files hold PUBLIC_* keys only', () => {
	assert.deepEqual(checkEnvFile('frontend/.env.development', 'PUBLIC_API_URL=http://localhost:3001\n'), []);
	const f = checkEnvFile('frontend/.env.development', 'PUBLIC_API_URL=http://localhost:3001\nAUTH_JWT_SECRET=dev-only-x\n');
	assert.equal(f.length, 1);
	assert.match(f[0].rule, /not a PUBLIC_\* key/);
});

test('the production build default must be same-origin /api', () => {
	assert.deepEqual(checkEnvFile('frontend/.env.production', 'PUBLIC_API_URL=/api\n'), []);
	assert.equal(checkEnvFile('frontend/.env.production', 'PUBLIC_OTHER=\n').length, 1, 'missing PUBLIC_API_URL');
	const abs = checkEnvFile('frontend/.env.production', 'PUBLIC_API_URL=https://abc.lambda-url.af-south-1.on.aws\n');
	assert.equal(abs.length, 2, 'not /api, and absolute');
});
