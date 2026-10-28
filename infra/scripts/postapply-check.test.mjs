// postapply-check.sh against a fake `aws` and `curl` on PATH
// (check-stubs/): every check passes and fails where it should, only
// read-only calls and plain GETs are made, the shared secret is never sent,
// and no email address, account ID or Function URL is printed. Needs bash
// and jq. No AWS account, no network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const here = new URL('.', import.meta.url).pathname;
const script = join(here, 'postapply-check.sh');
const ACCOUNT = '000000000000';
const SITE = 'https://water.example.test';
const FN_URL = 'https://abcdefghijklmnop.lambda-url.af-south-1.on.aws/';
const EMAIL = 'ops@example.test';
const CATEGORIES = ['availability', 'deletion', 'failover', 'failure', 'low storage', 'maintenance', 'notification', 'recovery', 'restoration', 'security patching'];

const subs = (region, arn) => ({
	Subscriptions: [{ Protocol: 'email', Endpoint: EMAIL, SubscriptionArn: arn, TopicArn: `arn:aws:sns:${region}:${ACCOUNT}:water-management-prod-alerts` }],
});
const confirmed = (region) => subs(region, `arn:aws:sns:${region}:${ACCOUNT}:water-management-prod-alerts:1111`);
const policy = (statements) => ({ repositoryName: 'water-management-renderer', policyText: JSON.stringify({ Version: '2012-10-17', Statement: statements }) });
const LAMBDA_STATEMENT = { Sid: 'LambdaECRImageRetrievalPolicy', Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'] };

const MODEL = 'global.anthropic.claude-sonnet-5-5';
const QUOTA = 'Global cross-Region model inference tokens per minute for Anthropic Claude Sonnet 5.5';
const assistantFn = (model = MODEL) => ({ FunctionName: 'water-management-assistant', Environment: { Variables: { ASSISTANT_PROVIDER: 'bedrock', ASSISTANT_MODEL: model } } });
const budget = (amount) => ({ Budget: { BudgetName: 'water-management-assistant', CalculatedSpend: { ActualSpend: { Amount: amount, Unit: 'USD' } } } });
const quotas = (names) => ({ Quotas: names.map(([QuotaName, Value]) => ({ ServiceCode: 'bedrock', QuotaName, Value })) });

function healthyAws() {
	return {
		'sts get-caller-identity': { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/Operator/test` },
		'sns list-subscriptions-by-topic': { byRegion: { 'af-south-1': confirmed('af-south-1'), 'us-east-1': confirmed('us-east-1') } },
		'rds describe-event-subscriptions': {
			EventSubscriptionsList: [{ CustSubscriptionId: 'water-management-db-events', Status: 'active', Enabled: true, SnsTopicArn: `arn:aws:sns:af-south-1:${ACCOUNT}:water-management-prod-alerts`, EventCategoriesList: CATEGORIES }],
		},
		'sesv2 get-account': { ProductionAccessEnabled: true, SendingEnabled: true },
		'ecr get-repository-policy': policy([LAMBDA_STATEMENT]),
		'lambda get-function-url-config': { FunctionUrl: FN_URL, AuthType: 'NONE' },
		'lambda get-function-configuration': assistantFn(),
		'bedrock get-model-invocation-logging-configuration': {},
		'budgets describe-budget': budget('3.21'),
		'service-quotas list-service-quotas': quotas([
			['Cross-region model inference tokens per minute for Anthropic Claude Sonnet 5.5', 2000000],
			[QUOTA, 4000000.0],
			['Global cross-Region model inference requests per minute for Anthropic Claude Sonnet 5.5', 200],
		]),
		'rds describe-events': { Events: [{ SourceIdentifier: 'water-management', EventCategories: ['availability'], Message: 'DB instance restarted' }] },
		'cloudwatch get-metric-statistics': {
			byArg: '--metric-name',
			values: { NumberOfMessagesPublished: { Datapoints: [{ Sum: 2.0 }, { Sum: 1.0 }] }, NumberOfNotificationsFailed: { Datapoints: [] } },
		},
	};
}

function healthyCurl() {
	return {
		[`${SITE}/wm-postapply-check-missing.pdf`]: { status: 404, body: 'Page not found' },
		[`${SITE}/_app/immutable/wm-postapply-check-missing.js`]: { status: 404, body: '<Error><Code>NoSuchKey</Code></Error>' },
		[`${FN_URL}health`]: { status: 403, body: '{"error":"forbidden"}' },
	};
}

function run({ aws = {}, curl = {}, args = ['--profile', 'water-management', '--region', 'af-south-1', '--domain', 'water.example.test'], varFile } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'postapply-check-'));
	for (const tool of ['aws', 'curl']) {
		const p = join(dir, tool);
		writeFileSync(p, `#!/bin/sh\nexec node ${join(here, `check-stubs/${tool}.mjs`)} "$@"\n`);
		chmodSync(p, 0o755);
	}
	const f = { aws: join(dir, 'aws.json'), awsLog: join(dir, 'aws.log'), curl: join(dir, 'curl.json'), curlLog: join(dir, 'curl.log'), vars: join(dir, 'prod.tfvars') };
	writeFileSync(f.aws, JSON.stringify({ ...healthyAws(), ...aws }));
	writeFileSync(f.curl, JSON.stringify({ ...healthyCurl(), ...curl }));
	writeFileSync(f.awsLog, '');
	writeFileSync(f.curlLog, '');
	const extra = [];
	if (varFile !== undefined) {
		writeFileSync(f.vars, varFile);
		extra.push('--var-file', f.vars);
	}
	const r = spawnSync('bash', [script, ...args, ...extra], {
		encoding: 'utf8',
		env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_AWS_STATE: f.aws, FAKE_AWS_LOG: f.awsLog, FAKE_CURL_STATE: f.curl, FAKE_CURL_LOG: f.curlLog },
	});
	const lines = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
	const out = r.stdout.split('\n');
	return {
		...r,
		aws: lines(f.awsLog),
		curl: lines(f.curlLog),
		line: (name, path = '') => out.find((l) => new RegExp(`^(PASS|WARN|FAIL)  ${name} `).test(l) && l.includes(path)) ?? '',
		count: (level) => out.filter((l) => l.startsWith(`${level}  `)).length,
	};
}

test('every check passes against a healthy stack, read-only, without leaking', () => {
	const r = run();
	assert.equal(r.status, 0, r.stdout + r.stderr);
	for (const name of ['sns-af-south-1', 'sns-us-east-1', 'rds-events', 'ses-production', 'ecr-policy', 'function-url', 'assistant-logging', 'assistant-budget', 'assistant-quota']) {
		assert.match(r.line(name), /^PASS/, `${name}:\n${r.stdout}`);
	}
	assert.equal(r.count('PASS'), 15, r.stdout);
	assert.equal(r.count('FAIL') + r.count('WARN'), 0);
	assert.ok(!r.stdout.includes('rds-delivery'), 'the delivery test is opt-in');
	assert.match(r.stdout, /All post-apply checks passed/);

	assert.ok(r.aws.every((c) => /^(get|describe|list)-/.test(c.op)), 'read-only calls only');
	assert.ok(r.aws.every((c) => c.global['--profile'] === 'water-management'));
	const topics = r.aws.filter((c) => c.op === 'list-subscriptions-by-topic').map((c) => [c.global['--region'], c.args['--topic-arn']]);
	assert.deepEqual(topics, [
		['af-south-1', `arn:aws:sns:af-south-1:${ACCOUNT}:water-management-prod-alerts`],
		['us-east-1', `arn:aws:sns:us-east-1:${ACCOUNT}:water-management-prod-alerts`],
	]);
	assert.equal(r.aws.find((c) => c.op === 'get-repository-policy').args['--repository-name'], 'water-management-renderer');
	assert.equal(r.aws.find((c) => c.op === 'get-function-url-config').args['--function-name'], 'water-management-backend');
	assert.equal(r.aws.find((c) => c.op === 'describe-event-subscriptions').args['--subscription-name'], 'water-management-db-events');
	assert.equal(r.aws.find((c) => c.op === 'get-function-configuration').args['--function-name'], 'water-management-assistant');
	assert.equal(r.aws.find((c) => c.op === 'get-model-invocation-logging-configuration').global['--region'], 'af-south-1');
	const b = r.aws.find((c) => c.op === 'describe-budget');
	assert.deepEqual([b.global['--region'], b.args['--budget-name']], ['us-east-1', 'water-management-assistant']);
	assert.equal(r.aws.find((c) => c.op === 'list-service-quotas').args['--service-code'], 'bedrock');
	assert.match(r.line('assistant-quota'), new RegExp(`^PASS .*${QUOTA} = 4000000 `));
	assert.ok(!r.line('assistant-quota').includes('requests per minute') && !r.line('assistant-quota').startsWith('PASS  assistant-quota    Cross'), 'only the global profile\'s tokens-per-minute quota');
	assert.match(r.line('assistant-budget'), /^PASS .*\$3\.21 of AWS Marketplace charges/);

	const urls = r.curl.map((a) => a.at(-1));
	assert.deepEqual(urls, [
		`${SITE}/wm-postapply-check-missing.pdf`,
		`${SITE}/_app/immutable/wm-postapply-check-missing.js`,
		`${SITE}/?list-type=2`,
		`${SITE}/?list-type=2&prefix=`,
		`${SITE}/_app/?list-type=2&prefix=_app/`,
		`${SITE}/_app/`,
		`${FN_URL}health`,
	]);
	assert.ok(r.curl.every((a) => !a.includes('-H') && !a.some((x) => /secret/i.test(x))), 'no header, no shared secret');
	for (const leak of [EMAIL, ACCOUNT, 'abcdefghijklmnop']) assert.ok(!r.stdout.includes(leak) && !r.stderr.includes(leak), `prints ${leak}`);
});

test('an unconfirmed subscription on either topic fails', () => {
	const r = run({
		aws: { 'sns list-subscriptions-by-topic': { byRegion: { 'af-south-1': confirmed('af-south-1'), 'us-east-1': subs('us-east-1', 'PendingConfirmation') } } },
	});
	assert.equal(r.status, 1);
	assert.match(r.line('sns-af-south-1'), /^PASS/);
	assert.match(r.line('sns-us-east-1'), /^FAIL .*no confirmed email subscription \(1 pending\)/);
	assert.ok(!r.stdout.includes(EMAIL));

	const missing = run({ aws: { 'sns list-subscriptions-by-topic': { byRegion: { 'af-south-1': { error: '(NotFound) Topic does not exist' }, 'us-east-1': confirmed('us-east-1') } } } });
	assert.match(missing.line('sns-af-south-1'), /^FAIL .*NotFound/);
});

test('in us-east-1 there is one topic to check', () => {
	const r = run({ args: ['--region', 'us-east-1', '--domain', 'water.example.test'] });
	assert.equal(r.aws.filter((c) => c.op === 'list-subscriptions-by-topic').length, 1);
	assert.equal(r.aws[0].global['--profile'], undefined, 'no --profile: the environment picks it');
});

test('SES in the sandbox is a warning, not a failure', () => {
	const r = run({ aws: { 'sesv2 get-account': { ProductionAccessEnabled: false } } });
	assert.equal(r.status, 0, r.stdout);
	assert.match(r.line('ses-production'), /^WARN .*sandbox/);
	assert.match(r.stdout, /No check failed; 1 warning\(s\)/);
});

test('an ECR policy with any other statement fails', () => {
	const extra = run({ aws: { 'ecr get-repository-policy': policy([LAMBDA_STATEMENT, { Sid: 'AddedByLambda', Effect: 'Allow' }]) } });
	assert.equal(extra.status, 1);
	assert.match(extra.line('ecr-policy'), /^FAIL .*\[LambdaECRImageRetrievalPolicy,AddedByLambda\]/);
	const renamed = run({ aws: { 'ecr get-repository-policy': policy({ ...LAMBDA_STATEMENT, Sid: 'Other' }) } });
	assert.match(renamed.line('ecr-policy'), /^FAIL .*\[Other\]/);
	const none = run({ aws: { 'ecr get-repository-policy': { error: '(RepositoryPolicyNotFoundException) no policy' } } });
	assert.match(none.line('ecr-policy'), /^FAIL .*RepositoryPolicyNotFoundException/);
});

test('a missing file served as anything but 404 fails', () => {
	const r = run({ curl: { [`${SITE}/wm-postapply-check-missing.pdf`]: { status: 200, body: '<!doctype html>' } } });
	assert.equal(r.status, 1);
	assert.match(r.line('edge-404', '.pdf'), /^FAIL .*answers 200, expected 404/);
	assert.match(r.line('edge-404', '.js'), /^PASS/);
	const down = run({ curl: { [`${SITE}/_app/immutable/wm-postapply-check-missing.js`]: { error: 'Failed to connect' } } });
	assert.match(down.line('edge-404', '.js'), /^FAIL .*answers 000.*Failed to connect/);
});

test('a bucket listing through the site fails, whatever its status', () => {
	const listing = '<?xml version="1.0"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name></ListBucketResult>';
	const r = run({ curl: { [`${SITE}/?list-type=2`]: { status: 200, body: listing }, [`${SITE}/_app/`]: { status: 200, body: listing } } });
	assert.equal(r.status, 1);
	assert.match(r.line('edge-no-listing', '/?list-type=2 '), /^FAIL .*returns an S3 bucket listing/);
	assert.match(r.line('edge-no-listing', '/_app/ '), /^FAIL/);
	assert.match(r.line('edge-no-listing', '/?list-type=2&prefix= '), /^PASS/);
	assert.match(r.stdout, /2 check\(s\) FAILED/);
});

test('a Function URL that answers without the shared secret fails', () => {
	const r = run({ curl: { [`${FN_URL}health`]: { status: 200, body: '{"ok":true}' } } });
	assert.equal(r.status, 1);
	assert.match(r.line('function-url'), /^FAIL .*answers 200, expected 403/);
	assert.ok(!r.stdout.includes('abcdefghijklmnop'), 'the Function URL is not printed');
});

test('an RDS event subscription that is not active, enabled and on the topic fails', () => {
	const sub = (over) => ({ 'rds describe-event-subscriptions': { EventSubscriptionsList: [{ ...healthyAws()['rds describe-event-subscriptions'].EventSubscriptionsList[0], ...over }] } });
	assert.match(run({ aws: sub({ Status: 'no-permission' }) }).line('rds-events'), /^FAIL .*status no-permission/);
	assert.match(run({ aws: sub({ Enabled: false }) }).line('rds-events'), /^FAIL .*enabled false/);
	assert.match(run({ aws: sub({ SnsTopicArn: `arn:aws:sns:af-south-1:${ACCOUNT}:other` }) }).line('rds-events'), /^FAIL .*topic 'other'/);
	const gone = run({ aws: { 'rds describe-event-subscriptions': { error: '(SubscriptionNotFound) not found' } } });
	assert.equal(gone.status, 1);
	assert.match(gone.line('rds-events'), /^FAIL .*SubscriptionNotFound/);
});

test('--rds-event-test: events that reached the topic pass; events with nothing published fail; no events warn', () => {
	const base = ['--region', 'af-south-1', '--domain', 'water.example.test', '--rds-event-test'];
	const ok = run({ args: base });
	assert.equal(ok.status, 0, ok.stdout);
	assert.match(ok.line('rds-delivery'), /^PASS .*1 RDS event\(s\) on water-management and 3 message\(s\) published/);
	const ev = ok.aws.find((c) => c.op === 'describe-events').args;
	assert.equal(ev['--source-identifier'], 'water-management');
	assert.equal(ev['--duration'], '1440');
	assert.ok(ok.aws.every((c) => !/reboot|publish/.test(c.op)), 'never reboots or publishes');

	const denied = run({ args: base, aws: { 'cloudwatch get-metric-statistics': { byArg: '--metric-name', values: { NumberOfMessagesPublished: { Datapoints: [] }, NumberOfNotificationsFailed: { Datapoints: [] } } } } });
	assert.equal(denied.status, 1);
	assert.match(denied.line('rds-delivery'), /^FAIL .*published nothing: the topic policy is denying RDS/);

	const failing = run({ args: base, aws: { 'cloudwatch get-metric-statistics': { byArg: '--metric-name', values: { NumberOfMessagesPublished: { Datapoints: [{ Sum: 1 }] }, NumberOfNotificationsFailed: { Datapoints: [{ Sum: 2 }] } } } } });
	assert.match(failing.line('rds-delivery'), /^FAIL .*2 notification\(s\) failed/);

	// Only the subscribed categories count: a backup event is not one of them.
	const quiet = run({ args: base, aws: { 'rds describe-events': { Events: [{ EventCategories: ['backup'] }] } } });
	assert.equal(quiet.status, 0);
	assert.match(quiet.line('rds-delivery'), /^WARN .*no subscribed RDS event/);
});

test('the domain and region come from the var file; usage errors exit 2 before any call', () => {
	const r = run({ args: [], varFile: 'aws_region = "af-south-1"\ndomain_name = "water.example.test" # the site\n' });
	assert.equal(r.status, 0, r.stdout + r.stderr);
	const none = run({ args: ['--region', 'af-south-1'] });
	assert.equal(none.status, 2);
	assert.match(none.stderr, /pass --domain/);
	assert.equal(none.aws.length + none.curl.length, 0);
	assert.equal(run({ args: ['--region', 'af-south-1', '--domain', 'x', '--fix'] }).status, 2);
});

test('--redirect-from: a former hostname 301s a page to the same path on the site, and its /api still answers', () => {
	const OLD = 'https://old.example.test';
	const probe = '/wm-postapply-check/page?probe=a%26b%20c&n=1&n=2';
	const args = ['--profile', 'water-management', '--region', 'af-south-1', '--domain', 'water.example.test', '--redirect-from', 'old.example.test'];
	const ok = run({ args, curl: { [`${OLD}${probe}`]: { status: 301, location: `${SITE}${probe}` }, [`${OLD}/api/health`]: { status: 200, body: '{"ok":true}' } } });
	assert.equal(ok.status, 0, ok.stdout);
	assert.match(ok.line('redirect-page'), /^PASS /);
	assert.match(ok.line('redirect-api'), /^PASS /);
	assert.ok(ok.curl.every((a) => !a.includes('-L')), 'never follows the redirect');

	// Not redirected (served as before), redirected elsewhere (a stale host), or the API redirected too.
	const served = run({ args, curl: { [`${OLD}/api/health`]: { status: 200 } } });
	assert.equal(served.status, 1);
	assert.match(served.line('redirect-page'), /^FAIL .*answers 200, expected 301/);
	const elsewhere = run({ args, curl: { [`${OLD}${probe}`]: { status: 301, location: `${OLD}/` }, [`${OLD}/api/health`]: { status: 200 } } });
	assert.match(elsewhere.line('redirect-page'), /^FAIL /);
	// The query rebuilt from CloudFront's parsed querystring, as spa_rewrite once
	// did: names reordered (seen live 2026-10-25). The check wants it byte for byte.
	const reordered = run({ args, curl: { [`${OLD}${probe}`]: { status: 301, location: `${SITE}/wm-postapply-check/page?n=1&n=2&probe=a%26b%20c` }, [`${OLD}/api/health`]: { status: 200 } } });
	assert.match(reordered.line('redirect-page'), /^FAIL .*answers 301 \S+\?n=1&n=2&probe=a%26b%20c, expected 301 to \S+\?probe=a%26b%20c&n=1&n=2$/);
	const apiMoved = run({ args, curl: { [`${OLD}${probe}`]: { status: 301, location: `${SITE}${probe}` }, [`${OLD}/api/health`]: { status: 301 } } });
	assert.match(apiMoved.line('redirect-api'), /^FAIL .*answers 301, expected 200/);

	// Without the flag no former hostname is called.
	const none = run();
	assert.ok(none.curl.every((a) => new URL(a.at(-1)).host !== new URL(OLD).host));
	assert.equal(none.line('redirect-page'), '');
});

test('assistant: off (no function) skips its checks; any other error reading it fails', () => {
	const off = run({ aws: { 'lambda get-function-configuration': { error: '(ResourceNotFoundException) Function not found: water-management-assistant' } } });
	assert.equal(off.status, 0, off.stdout);
	assert.equal(off.line('assistant'), '');
	assert.ok(!/assistant-/.test(off.stdout), off.stdout);
	assert.ok(off.aws.every((c) => !['bedrock', 'budgets', 'service-quotas'].includes(c.service)), 'no assistant call while it is off');

	const denied = run({ aws: { 'lambda get-function-configuration': { error: '(AccessDeniedException) not authorized' } } });
	assert.equal(denied.status, 1);
	assert.match(denied.line('assistant'), /^FAIL .*AccessDeniedException/);
});

test('assistant: Bedrock model invocation logging on fails, naming where it goes', () => {
	const on = run({
		aws: { 'bedrock get-model-invocation-logging-configuration': { loggingConfig: { cloudWatchConfig: { logGroupName: 'bedrock', roleArn: `arn:aws:iam::${ACCOUNT}:role/x` }, textDataDeliveryEnabled: true } } },
	});
	assert.equal(on.status, 1);
	assert.match(on.line('assistant-logging'), /^FAIL .*ON in af-south-1 \(to CloudWatch Logs\).*delete-model-invocation-logging-configuration/);
	assert.ok(!on.stdout.includes(ACCOUNT), 'the role ARN is not printed');
	const s3 = run({ aws: { 'bedrock get-model-invocation-logging-configuration': { loggingConfig: { s3Config: { bucketName: 'b' } } } } });
	assert.match(s3.line('assistant-logging'), /^FAIL .*to S3/);
	const err = run({ aws: { 'bedrock get-model-invocation-logging-configuration': { error: '(AccessDeniedException) no' } } });
	assert.match(err.line('assistant-logging'), /^FAIL .*AccessDeniedException/);
});

test('assistant: a budget with no charge yet, or no budget, warns; a failure to read it fails', () => {
	const zero = run({ aws: { 'budgets describe-budget': budget('0.0') } });
	assert.equal(zero.status, 0, zero.stdout);
	assert.match(zero.line('assistant-budget'), /^WARN .*\$0 this month.*re-run/);
	const none = run({ aws: { 'budgets describe-budget': { error: '(NotFoundException) Unable to get budget' } } });
	assert.match(none.line('assistant-budget'), /^WARN .*no water-management-assistant budget/);
	const denied = run({ aws: { 'budgets describe-budget': { error: '(AccessDeniedException) no' } } });
	assert.equal(denied.status, 1);
	assert.match(denied.line('assistant-budget'), /^FAIL .*AccessDeniedException/);
});

test('assistant: the quota follows the model route, and a missing one warns', () => {
	const geo = run({
		aws: {
			'lambda get-function-configuration': assistantFn('eu.anthropic.claude-sonnet-5-5'),
		},
	});
	assert.match(geo.line('assistant-quota'), /^PASS  assistant-quota    Cross-region model inference tokens per minute for Anthropic Claude Sonnet 5\.5 = 2000000 /);
	const missing = run({ aws: { 'service-quotas list-service-quotas': quotas([['Global cross-Region model inference tokens per minute for Anthropic Claude Opus 5', 1]]) } });
	assert.equal(missing.status, 0, missing.stdout);
	assert.match(missing.line('assistant-quota'), /^WARN .*claude sonnet 5\.5/);
});
