import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectFindings, isPiiColumn, piiColumnsInMigration, sdkDependenciesInDiff, unknownHostsInDiff } from './check_compliance_drift.mjs';

const piiMigration = `--- a/backend/migrations/006_x.sql
+++ b/backend/migrations/006_x.sql
@@ -0,0 +1,6 @@
+create table farm_contact (
+  id uuid primary key,
+  phone_number text,
+  mobile text not null,
+  created_at timestamptz not null default now()
+);
`;

test('a PII-shaped column in a new table is found', () => {
	assert.deepEqual(piiColumnsInMigration(piiMigration), ['mobile', 'phone_number']);
	assert.deepEqual(piiColumnsInMigration('+alter table app_user add column if not exists display_name text;'), ['display_name']);
});

test('PII is matched per snake_case token', () => {
	for (const c of ['email', 'email_verified_at', 'client_ip', 'first_name', 'display_name', 'user_agent', 'home_address']) assert.ok(isPiiColumn(c), c);
	for (const c of ['capacity_m3', 'pipeline', 'name', 'dam_name', 'skip_reason', 'ship_date']) assert.ok(!isPiiColumn(c), c);
});

test('non-PII columns, comments and non-schema diffs stay quiet', () => {
	assert.deepEqual(piiColumnsInMigration('+create table dam (\n+  id uuid,\n+  capacity_m3 numeric\n+);'), []);
	assert.deepEqual(piiColumnsInMigration('+-- email text\n+create table x (id uuid);'), []);
	assert.deepEqual(piiColumnsInMigration('+update app_user set email text;'), [], 'no create/alter table');
	assert.deepEqual(piiColumnsInMigration('-create table x (\n-  email text\n-);'), [], 'removed lines are not additions');
});

test('unknown outbound hosts are found; local, AWS, the site and comments are not', () => {
	const diff = [
		"+const a = 'https://api.segment.io/v1/track';",
		"+const b = 'http://localhost:3001';",
		"+const c = 'https://email.af-south-1.amazonaws.com';",
		"+const d = 'https://water-management.jaredhoward.com/verify';",
		'+// see https://docs.somewhere.io for details',
		" const e = 'https://unchanged.example.net';",
	].join('\n');
	assert.deepEqual(unknownHostsInDiff(diff), ['api.segment.io']);
});

test('SDK dependencies are found; ordinary deps are not', () => {
	const diff = '+    "@sentry/sveltekit": "^9.0.0",\n+    "uplot": "^1.6.0",\n+    "posthog-js": "1.0.0"';
	assert.deepEqual(sdkDependenciesInDiff(diff), ['@sentry/sveltekit', 'posthog-js']);
});

test('collectFindings fires without the companion doc and stays quiet with it', () => {
	const diffs = {
		'backend/migrations/006_x.sql': piiMigration,
		'frontend/src/lib/telemetry.ts': "+fetch('https://api.segment.io/v1/track')",
		'frontend/package.json': '+    "@sentry/sveltekit": "^9.0.0",',
	};
	const diffFor = (f) => diffs[f] ?? '';
	const bare = collectFindings({ files: Object.keys(diffs), diffFor });
	assert.deepEqual(bare.map((f) => f.rule), ['pii-column', 'outbound-host', 'sdk-dependency']);

	const withDocs = collectFindings({ files: [...Object.keys(diffs), 'docs/data-model.md', 'docs/security.md'], diffFor });
	assert.deepEqual(withDocs, []);
});

test('tests and non-source files are ignored', () => {
	const f = collectFindings({
		files: ['backend/src/mail/transport.test.ts', 'docs/api.md'],
		diffFor: () => "+const x = 'https://api.segment.io'",
	});
	assert.deepEqual(f, []);
});
