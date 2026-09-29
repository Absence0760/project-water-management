// preapply-check.sh against a fake `aws` on PATH (check-stubs/aws.mjs): every
// check passes and fails where it should, the reservations are summed from
// the real infra/variables.tf (overridden by a var file), and the script
// makes only read-only calls. Needs bash and jq. No AWS account.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const here = new URL('.', import.meta.url).pathname;
const script = join(here, 'preapply-check.sh');
const BUCKET = 'water-management-tfstate-000000000000';

function healthy() {
	return {
		'service-quotas get-service-quota': { Quota: { QuotaCode: 'L-B99A9384', Value: 1000.0 } },
		's3api get-bucket-location': { LocationConstraint: null },
		'kms describe-key': { KeyMetadata: { KeyId: 'k', KeyState: 'Enabled' } },
		'ec2 describe-vpc-endpoint-services': {
			ServiceNames: ['com.amazonaws.af-south-1.email'],
			ServiceDetails: [{ ServiceName: 'com.amazonaws.af-south-1.email' }],
		},
		'rds describe-orderable-db-instance-options': {
			OrderableDBInstanceOptions: [
				{ Engine: 'postgres', EngineVersion: '16.9', DBInstanceClass: 'db.t4g.micro' },
				{ Engine: 'postgres', EngineVersion: '17.5', DBInstanceClass: 'db.t4g.micro' },
				{ Engine: 'postgres', EngineVersion: '17.6', DBInstanceClass: 'db.t4g.micro' },
				{ Engine: 'postgres', EngineVersion: '17.6', DBInstanceClass: 'db.t4g.micro' },
			],
		},
	};
}

function run({ state = {}, args = ['--profile', 'water-management', '--region', 'af-south-1'], varFile, backendConfig = `bucket = "${BUCKET}"\n` } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'preapply-check-'));
	const aws = join(dir, 'aws');
	writeFileSync(aws, `#!/bin/sh\nexec node ${join(here, 'check-stubs/aws.mjs')} "$@"\n`);
	chmodSync(aws, 0o755);
	const files = { state: join(dir, 'state.json'), log: join(dir, 'aws.log'), backend: join(dir, 'backend.config'), vars: join(dir, 'prod.tfvars') };
	writeFileSync(files.state, JSON.stringify({ ...healthy(), ...state }));
	writeFileSync(files.log, '');
	writeFileSync(files.backend, backendConfig);
	const extra = ['--backend-config', files.backend];
	if (varFile !== undefined) {
		writeFileSync(files.vars, varFile);
		extra.push('--var-file', files.vars);
	}
	const r = spawnSync('bash', [script, ...args, ...extra], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_AWS_STATE: files.state, FAKE_AWS_LOG: files.log },
	});
	const calls = readFileSync(files.log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
	const line = (name) => r.stdout.split('\n').find((l) => new RegExp(`^(PASS|FAIL)  ${name} `).test(l)) ?? '';
	return { ...r, calls, line };
}

test('every check passes against a ready account, with read-only calls only', () => {
	const r = run();
	assert.equal(r.status, 0, r.stdout + r.stderr);
	for (const name of ['lambda-quota', 'state-bucket', 'sops-key', 'ses-endpoint', 'rds-orderable']) {
		assert.match(r.line(name), /^PASS/, `${name}:\n${r.stdout}`);
	}
	// The defaults in variables.tf: API 10 + migrate 1 + worker 8 + fetcher 2
	// + renderer 2 = 23, + 10 unreserved = 33 (infra/README.md step 3 says 33).
	assert.match(r.line('lambda-quota'), /quota 1000 >= 33 \(reservations 23 \+ 10 unreserved\)/);
	assert.match(r.line('lambda-quota'), /lambda=10 migrate=1 worker=8 fetcher=2 renderer=2/);
	assert.match(r.line('rds-orderable'), /db\.t4g\.micro offers PostgreSQL 17 in af-south-1 \(17\.5 17\.6\)/);
	assert.match(r.stdout, /All pre-apply checks passed/);

	assert.ok(r.calls.every((c) => /^(get|describe|list)-/.test(c.op)), 'read-only calls only');
	assert.ok(r.calls.every((c) => c.global['--profile'] === 'water-management'));
	const region = (op) => r.calls.find((c) => c.op === op).global['--region'];
	assert.equal(region('get-bucket-location'), 'us-east-1', 'the state bucket is looked up in us-east-1');
	assert.equal(region('describe-key'), 'us-east-1', 'the sops key is looked up in us-east-1');
	assert.equal(region('get-service-quota'), 'af-south-1');
	assert.equal(r.calls.find((c) => c.op === 'get-bucket-location').args['--bucket'], BUCKET);
	assert.equal(r.calls.find((c) => c.op === 'describe-key').args['--key-id'], 'alias/water-management-sops');
	assert.equal(r.calls.find((c) => c.op === 'get-service-quota').args['--quota-code'], 'L-B99A9384');
	assert.equal(r.calls.find((c) => c.op === 'describe-vpc-endpoint-services').args['--service-names'], 'com.amazonaws.af-south-1.email');
	const rds = r.calls.find((c) => c.op === 'describe-orderable-db-instance-options').args;
	assert.equal(rds['--engine'], 'postgres');
	assert.equal(rds['--db-instance-class'], 'db.t4g.micro');
});

test('a quota below the reservations + 10 fails; exactly enough passes', () => {
	const low = run({ state: { 'service-quotas get-service-quota': { Quota: { Value: 32.0 } } } });
	assert.equal(low.status, 1);
	assert.match(low.line('lambda-quota'), /^FAIL .*quota 32 < 33/);
	assert.match(low.stdout, /1 check\(s\) FAILED/);
	// A new account's quota of 10.
	assert.equal(run({ state: { 'service-quotas get-service-quota': { Quota: { Value: 10.0 } } } }).status, 1);
	const exact = run({ state: { 'service-quotas get-service-quota': { Quota: { Value: 33.0 } } } });
	assert.equal(exact.status, 0, exact.stdout);
});

test('the var file overrides the reservations, the region and the DB class', () => {
	const r = run({
		args: ['--profile', 'water-management'],
		varFile: [
			'aws_region = "af-south-1"',
			'lambda_reserved_concurrency  = 20 # more headroom',
			'# worker_reserved_concurrency = 50',
			'db_instance_class = "db.t4g.small"',
			'',
		].join('\n'),
		state: { 'service-quotas get-service-quota': { Quota: { Value: 40.0 } } },
	});
	assert.equal(r.status, 1);
	assert.match(r.line('lambda-quota'), /^FAIL .*quota 40 < 43 \(reservations 33/, 'lambda 20, a commented-out line ignored');
	assert.ok(r.calls.every((c) => c.op === 'get-bucket-location' || c.op === 'describe-key' || c.global['--region'] === 'af-south-1'));
	assert.equal(r.calls.find((c) => c.op === 'describe-orderable-db-instance-options').args['--db-instance-class'], 'db.t4g.small');
});

test('--reserved replaces the parsed sum; a reservation that is not a number fails with that hint', () => {
	const r = run({ args: ['--region', 'af-south-1', '--reserved', '5'], state: { 'service-quotas get-service-quota': { Quota: { Value: 15.0 } } } });
	assert.equal(r.status, 0, r.stdout);
	assert.match(r.line('lambda-quota'), /quota 15 >= 15 \(reservations 5 \+ 10/);
	assert.equal(r.calls[0].global['--profile'], undefined, 'no --profile: the environment picks it');

	const bad = run({ varFile: 'worker_reserved_concurrency = var.something\n' });
	assert.equal(bad.status, 1);
	assert.match(bad.line('lambda-quota'), /^FAIL .*can't read worker_reserved_concurrency.*--reserved/);
});

test('the state bucket must exist, be named, and be in us-east-1', () => {
	const elsewhere = run({ state: { 's3api get-bucket-location': { LocationConstraint: 'af-south-1' } } });
	assert.equal(elsewhere.status, 1);
	assert.match(elsewhere.line('state-bucket'), /^FAIL .*is in af-south-1, not us-east-1/);

	const missing = run({ state: { 's3api get-bucket-location': { error: '(NoSuchBucket) when calling the GetBucketLocation operation: The specified bucket does not exist' } } });
	assert.equal(missing.status, 1);
	assert.match(missing.line('state-bucket'), /^FAIL .*NoSuchBucket/);

	const placeholder = run({ backendConfig: 'bucket = "water-management-tfstate-PLACEHOLDER_ACCOUNT_ID"\n' });
	assert.equal(placeholder.status, 1);
	assert.match(placeholder.line('state-bucket'), /^FAIL .*placeholder/);
	assert.ok(!placeholder.calls.some((c) => c.op === 'get-bucket-location'));

	const none = run({ backendConfig: '# nothing yet\n' });
	assert.match(none.line('state-bucket'), /^FAIL .*no bucket in/);
});

test('the sops key must exist and be enabled', () => {
	const pending = run({ state: { 'kms describe-key': { KeyMetadata: { KeyState: 'PendingDeletion' } } } });
	assert.equal(pending.status, 1);
	assert.match(pending.line('sops-key'), /^FAIL .*PendingDeletion in us-east-1/);
	const missing = run({ state: { 'kms describe-key': { error: '(NotFoundException) when calling the DescribeKey operation: Alias not found' } } });
	assert.match(missing.line('sops-key'), /^FAIL .*NotFoundException/);
});

test('a region without the SES endpoint service fails', () => {
	const r = run({ state: { 'ec2 describe-vpc-endpoint-services': { error: '(InvalidServiceName) The Vpc Endpoint Service does not exist' } } });
	assert.equal(r.status, 1);
	assert.match(r.line('ses-endpoint'), /^FAIL .*com\.amazonaws\.af-south-1\.email is not offered.*InvalidServiceName/);
	const empty = run({ state: { 'ec2 describe-vpc-endpoint-services': { ServiceDetails: [] } } });
	assert.match(empty.line('ses-endpoint'), /^FAIL/);
});

test('an instance class without the pinned PostgreSQL major fails', () => {
	const r = run({ state: { 'rds describe-orderable-db-instance-options': { OrderableDBInstanceOptions: [{ EngineVersion: '16.9' }, { EngineVersion: '170.1' }] } } });
	assert.equal(r.status, 1);
	assert.match(r.line('rds-orderable'), /^FAIL .*offers no PostgreSQL 17 version/);
});

test('usage errors exit 2 before any AWS call', () => {
	const noRegion = run({ args: [] });
	assert.equal(noRegion.status, 2);
	assert.match(noRegion.stderr, /no --region/);
	assert.equal(noRegion.calls.length, 0);
	const unknown = run({ args: ['--region', 'af-south-1', '--apply'] });
	assert.equal(unknown.status, 2);
	assert.match(unknown.stderr, /unknown argument: --apply/);
});
