// preapply-check.sh against a fake `aws` on PATH (check-stubs/aws.mjs): every
// check passes and fails where it should (the CloudTrail trail the KMS key
// alarm needs, classic and advanced selectors), the reservations are summed from
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
// An Organization trail from the management account, as a member account sees it.
const ORG_TRAIL = 'arn:aws:cloudtrail:us-east-1:111111111111:trail/o-example/org-trail';
const LOCAL_TRAIL = 'arn:aws:cloudtrail:af-south-1:000000000000:trail/local';

// describe-trails / get-trail-status / get-event-selectors for the given trails.
function trails(list) {
	return {
		'cloudtrail describe-trails': { trailList: list.map((t) => t.trail) },
		'cloudtrail get-trail-status': { byArg: '--name', values: Object.fromEntries(list.map((t) => [t.trail.TrailARN, t.status ?? { IsLogging: true }])) },
		'cloudtrail get-event-selectors': { byArg: '--trail-name', values: Object.fromEntries(list.map((t) => [t.trail.TrailARN, t.selectors])) },
	};
}
const orgTrail = (over = {}) => ({
	trail: { Name: 'org-trail', TrailARN: ORG_TRAIL, HomeRegion: 'us-east-1', IsMultiRegionTrail: true, IsOrganizationTrail: true },
	selectors: { EventSelectors: [{ ReadWriteType: 'All', IncludeManagementEvents: true, DataResources: [] }] },
	...over,
});

function healthy() {
	return {
		'service-quotas get-service-quota': { Quota: { QuotaCode: 'L-B99A9384', Value: 1000.0 } },
		's3api get-bucket-location': { LocationConstraint: null },
		'kms describe-key': { KeyMetadata: { KeyId: 'k', KeyState: 'Enabled' } },
		'ec2 describe-vpc-endpoint-services': {
			ServiceNames: ['com.amazonaws.af-south-1.email'],
			ServiceDetails: [{ ServiceName: 'com.amazonaws.af-south-1.email' }],
		},
		...trails([orgTrail()]),
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
	for (const name of ['lambda-quota', 'state-bucket', 'sops-key', 'ses-endpoint', 'rds-orderable', 'cloudtrail']) {
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
	assert.match(r.line('cloudtrail'), new RegExp(`^PASS .*${ORG_TRAIL}.* in af-south-1`));
	assert.equal(r.calls.find((c) => c.op === 'describe-trails').args['--include-shadow-trails'], true, 'an Organization trail shows in a member account only as a shadow trail');
	assert.equal(region('describe-trails'), 'af-south-1');
	assert.equal(r.calls.find((c) => c.op === 'get-event-selectors').args['--trail-name'], ORG_TRAIL, 'a shadow trail is named by its ARN');
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

test('the key alarm needs a logging trail recording KMS write management events in the region', () => {
	const fails = (state, why) => {
		const r = run({ state });
		assert.equal(r.status, 1, why);
		assert.match(r.line('cloudtrail'), /^FAIL .*database KMS key alarm/, why);
		return r;
	};
	const none = fails(trails([]), 'no trail at all');
	assert.match(none.line('cloudtrail'), /no trail covers af-south-1.*Organization trail/);
	// A single-region trail elsewhere doesn't cover af-south-1, and isn't queried.
	const elsewhere = fails(trails([orgTrail({ trail: { TrailARN: ORG_TRAIL, HomeRegion: 'us-east-1', IsMultiRegionTrail: false } })]), 'single-region trail in another region');
	assert.ok(!elsewhere.calls.some((c) => c.op === 'get-trail-status'));
	const stopped = fails(trails([orgTrail({ status: { IsLogging: false } })]), 'trail not logging');
	assert.match(stopped.line('cloudtrail'), /org-trail: not logging/);
	fails(trails([orgTrail({ selectors: { EventSelectors: [{ ReadWriteType: 'ReadOnly', IncludeManagementEvents: true }] } })]), 'read-only management events');
	fails(trails([orgTrail({ selectors: { EventSelectors: [{ ReadWriteType: 'All', IncludeManagementEvents: false }] } })]), 'data events only');
	const noKms = fails(trails([orgTrail({ selectors: { EventSelectors: [{ ReadWriteType: 'All', IncludeManagementEvents: true, ExcludeManagementEventSources: ['kms.amazonaws.com'] }] } })]), 'KMS events excluded');
	assert.match(noKms.line('cloudtrail'), /no selector records KMS write management events/);
	const adv = (FieldSelectors) => trails([orgTrail({ selectors: { AdvancedEventSelectors: [{ Name: 'm', FieldSelectors }] } })]);
	fails(adv([{ Field: 'eventCategory', Equals: ['Management'] }, { Field: 'readOnly', Equals: ['true'] }]), 'advanced: reads only');
	fails(adv([{ Field: 'eventCategory', Equals: ['Management'] }, { Field: 'eventSource', NotEquals: ['kms.amazonaws.com'] }]), 'advanced: KMS excluded');
	fails(adv([{ Field: 'eventCategory', Equals: ['Management'] }, { Field: 'eventName', Equals: ['CreateBucket'] }]), 'advanced: narrowed by eventName');
	fails(adv([{ Field: 'eventCategory', Equals: ['Data'] }, { Field: 'resources.type', Equals: ['AWS::S3::Object'] }]), 'advanced: data events');
	const denied = fails({ 'cloudtrail get-event-selectors': { error: '(AccessDeniedException) not authorized' }, 'cloudtrail describe-trails': trails([orgTrail()])['cloudtrail describe-trails'] }, 'selectors unreadable');
	assert.match(denied.line('cloudtrail'), /get-event-selectors failed \(.*AccessDeniedException/);
	const broken = fails({ 'cloudtrail describe-trails': { error: '(AccessDeniedException) not authorized' } }, 'describe-trails denied');
	assert.match(broken.line('cloudtrail'), /describe-trails failed/);
});

test('any one covering trail passes: classic or advanced selectors, this account or the Organization', () => {
	const passes = (state, why) => {
		const r = run({ state });
		assert.equal(r.status, 0, `${why}\n${r.stdout}`);
		assert.match(r.line('cloudtrail'), /^PASS/, why);
		return r;
	};
	passes(trails([orgTrail({ selectors: { EventSelectors: [{ ReadWriteType: 'WriteOnly', IncludeManagementEvents: true, ExcludeManagementEventSources: ['rdsdata.amazonaws.com'] }] } })]), 'write-only, another source excluded');
	const adv = (FieldSelectors) => trails([orgTrail({ selectors: { AdvancedEventSelectors: [{ Name: 'data', FieldSelectors: [{ Field: 'eventCategory', Equals: ['Data'] }, { Field: 'resources.type', Equals: ['AWS::S3::Object'] }] }, { Name: 'm', FieldSelectors }] } })]);
	passes(adv([{ Field: 'eventCategory', Equals: ['Management'] }]), 'advanced: all management events');
	passes(adv([{ Field: 'eventCategory', Equals: ['Management'] }, { Field: 'readOnly', Equals: ['false'] }, { Field: 'eventSource', NotEquals: ['rdsdata.amazonaws.com'] }]), 'advanced: writes, another source excluded');
	// A stopped Organization trail and a logging single-region trail in this account.
	const local = {
		trail: { Name: 'local', TrailARN: LOCAL_TRAIL, HomeRegion: 'af-south-1', IsMultiRegionTrail: false },
		selectors: { EventSelectors: [{ ReadWriteType: 'All', IncludeManagementEvents: true }] },
	};
	const r = passes(trails([orgTrail({ status: { IsLogging: false } }), local]), 'the second trail covers');
	assert.match(r.line('cloudtrail'), new RegExp(`^PASS .*${LOCAL_TRAIL}`));
});

test('the trail check is skipped when the database uses the AWS-managed key', () => {
	const r = run({ varFile: 'rds_customer_managed_key = false\n', state: trails([]) });
	assert.equal(r.status, 0, r.stdout);
	assert.match(r.line('cloudtrail'), /^PASS .*not needed: rds_customer_managed_key = false/);
	assert.ok(!r.calls.some((c) => c.service === 'cloudtrail'));
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
