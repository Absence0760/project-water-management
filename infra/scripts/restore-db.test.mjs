// restore-db.sh against a fake `aws` and `terraform` on PATH
// (restore-db-stubs/): the dry run prints the right commands and changes
// nothing; --execute restores into the stack's network and settings, turns on
// the managed master secret, swaps identifiers, moves Terraform state and
// never applies or deletes; the guard rails refuse what they should.
// Needs bash and jq (both on the CI runners). No AWS account.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const here = new URL('.', import.meta.url).pathname;
const script = join(here, 'restore-db.sh');
const TS = '20260928120000';
const PG = 'water-management-pg17-20260928000000000000000001';

function fixture() {
	return {
		instances: {
			'water-management': {
				DBInstanceIdentifier: 'water-management',
				DBInstanceStatus: 'available',
				DbiResourceId: 'db-ORIGINAL',
				DBInstanceClass: 'db.t4g.micro',
				DBSubnetGroup: { DBSubnetGroupName: 'water-management-db' },
				VpcSecurityGroups: [{ VpcSecurityGroupId: 'sg-0rds', Status: 'active' }],
				DBParameterGroups: [{ DBParameterGroupName: PG }],
				StorageEncrypted: true,
				KmsKeyId: 'arn:aws:kms:af-south-1:000000000000:key/aws-rds',
				DeletionProtection: true,
				PubliclyAccessible: false,
				CACertificateIdentifier: 'rds-ca-rsa2048-g1',
				BackupRetentionPeriod: 7,
				PreferredBackupWindow: '00:00-01:00',
				PreferredMaintenanceWindow: 'sun:01:30-sun:02:30',
				MonitoringInterval: 0,
				MultiAZ: false,
				AutoMinorVersionUpgrade: true,
				MaxAllocatedStorage: 100,
				EnabledCloudwatchLogsExports: ['postgresql'],
				LatestRestorableTime: '2026-09-28T10:00:00+00:00',
				MasterUserSecret: { SecretArn: 'arn:aws:secretsmanager:af-south-1:000000000000:secret:rds!db-ORIGINAL', SecretStatus: 'active' },
				TagList: [
					{ Key: 'Name', Value: 'water-management-db' },
					{ Key: 'project', Value: 'water-management' },
				],
			},
		},
		automatedBackups: {
			'db-ORIGINAL': {
				DBInstanceAutomatedBackups: [{ RestoreWindow: { EarliestTime: '2026-09-21T10:00:00.123Z', LatestTime: '2026-09-28T10:00:00Z' } }],
			},
		},
		snapshots: {
			'manual-1': {
				DBSnapshotIdentifier: 'manual-1',
				DBInstanceIdentifier: 'water-management',
				Status: 'available',
				Encrypted: true,
				SnapshotCreateTime: '2026-09-27T00:00:00Z',
			},
		},
	};
}

const OUTPUTS = {
	aws_region: 'af-south-1',
	db_instance_identifier: 'water-management',
	db_subnet_group_name: 'water-management-db',
	db_security_group_id: 'sg-0rds',
	db_parameter_group_name: PG,
	migrate_function_name: 'water-management-migrate',
};

function setup({ outputs = OUTPUTS, state = fixture() } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'restore-db-'));
	for (const [tool, stub] of [
		['aws', 'restore-db-stubs/aws.mjs'],
		['terraform', 'restore-db-stubs/terraform.mjs'],
		// tf.sh's sops (synthetic values), for the import and plan.
		['sops', 'tf-stubs/sops.mjs'],
	]) {
		const p = join(dir, tool);
		writeFileSync(p, `#!/bin/sh\nexec node ${join(here, stub)} "$@"\n`);
		chmodSync(p, 0o755);
	}
	const files = {
		state: join(dir, 'state.json'),
		awsLog: join(dir, 'aws.log'),
		tfLog: join(dir, 'tf.log'),
		outputs: join(dir, 'outputs.json'),
		secrets: join(dir, 'prod.sops.yaml'),
	};
	writeFileSync(files.secrets, 'synthetic: not read by the fake sops\n');
	writeFileSync(files.state, JSON.stringify(state));
	writeFileSync(files.outputs, JSON.stringify(outputs));
	writeFileSync(files.awsLog, '');
	writeFileSync(files.tfLog, '');
	return { dir, files };
}

function run(ctx, args, env = {}) {
	const r = spawnSync('bash', [script, ...args], {
		encoding: 'utf8',
		env: {
			...process.env,
			PATH: `${ctx.dir}:${process.env.PATH}`,
			FAKE_AWS_STATE: ctx.files.state,
			FAKE_AWS_LOG: ctx.files.awsLog,
			FAKE_TF_LOG: ctx.files.tfLog,
			FAKE_TF_OUTPUTS: ctx.files.outputs,
			WM_SECRETS_FILE: ctx.files.secrets,
			RESTORE_DB_TIMESTAMP: TS,
			RESTORE_DB_POLL_SECONDS: '0',
			RESTORE_DB_TIMEOUT_SECONDS: '5',
			...env,
		},
	});
	const lines = (f) =>
		readFileSync(f, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	return {
		...r,
		aws: lines(ctx.files.awsLog),
		tf: lines(ctx.files.tfLog),
		state: JSON.parse(readFileSync(ctx.files.state, 'utf8')),
	};
}

// The tfvars must exist; the fakes never read it.
const VAR_FILE = join(mkdtempSync(join(tmpdir(), 'restore-db-vars-')), 'prod.tfvars');
writeFileSync(VAR_FILE, '');
const BASE = ['--region', 'af-south-1', '--profile', 'water-management', '--var-file', VAR_FILE];
const READ_ONLY = new Set(['get-caller-identity', 'describe-db-instances', 'describe-db-instance-automated-backups', 'describe-db-snapshots']);

/** The printed command lines, with their shell quoting removed. */
function printed(stdout) {
	return stdout
		.split('\n')
		.filter((l) => l.startsWith('+ '))
		.map((l) => l.replace(/\\(.)/g, '$1'));
}

test('a dry run prints the restore into the stack, the swap and the state move, and changes nothing', () => {
	const ctx = setup();
	const r = run(ctx, [...BASE, '--restore-time', '2026-09-27T08:15:00Z']);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /DRY RUN/);

	const cmds = printed(r.stdout);
	const restore = cmds.find((c) => c.includes('restore-db-instance-to-point-in-time'));
	assert.ok(restore, r.stdout);
	for (const part of [
		'aws --region af-south-1 --profile water-management',
		'--source-db-instance-identifier water-management',
		`--target-db-instance-identifier water-management-restore-${TS}`,
		'--restore-time 2026-09-27T08:15:00Z',
		'--db-subnet-group-name water-management-db',
		'--vpc-security-group-ids sg-0rds',
		`--db-parameter-group-name ${PG}`,
		'--no-publicly-accessible',
		'--deletion-protection',
		'--copy-tags-to-snapshot',
		'--db-instance-class db.t4g.micro',
		'--ca-certificate-identifier rds-ca-rsa2048-g1',
		'--backup-retention-period 7',
		'--preferred-backup-window 00:00-01:00',
		'--tags [{"Key":"Name","Value":"water-management-db"},{"Key":"project","Value":"water-management"}]',
		'--no-multi-az',
		'--auto-minor-version-upgrade',
		'--max-allocated-storage 100',
	]) {
		assert.ok(restore.includes(part), `restore command lacks ${part}:\n${restore}`);
	}
	assert.ok(!restore.includes('--enable-cloudwatch-logs-exports'), 'log export is turned on only after the swap');

	const order = cmds.map((c) =>
		c.includes('restore-db-instance') ? 'restore'
		: c.includes('--manage-master-user-password') ? 'secret'
		: c.includes('DisableLogTypes') ? 'logs-off'
		: c.includes(`--new-db-instance-identifier water-management-old-${TS}`) ? 'rename-old'
		: c.includes(`--db-instance-identifier water-management-restore-${TS} --new-db-instance-identifier water-management `) ? 'rename-new'
		: c.includes('EnableLogTypes') ? 'logs-on'
		: c.includes(' state rm aws_db_instance.main') ? 'state-rm'
		: c.includes(` import -input=false -var-file=${VAR_FILE} aws_db_instance.main water-management`) ? 'import'
		: c.includes(' plan ') ? 'plan'
		: c,
	);
	assert.deepEqual(order, ['restore', 'secret', 'logs-off', 'rename-old', 'rename-new', 'logs-on', 'state-rm', 'import', 'plan']);
	assert.ok(cmds.every((c) => !/ apply| delete-db-instance/.test(c)), 'never applies or deletes');
	assert.match(r.stdout, /delete-db-instance --db-instance-identifier water-management-old-/, 'tells the operator how to delete the old instance');

	assert.deepEqual(r.aws.filter((c) => !READ_ONLY.has(c.op)), [], 'a dry run makes no changing AWS call');
	assert.ok(r.aws.every((c) => c.global['--region'] === 'af-south-1' && c.global['--profile'] === 'water-management'));
	assert.deepEqual(r.tf.map((c) => c.args[0]), Array(r.tf.length).fill('output'), 'a dry run only reads Terraform outputs');
	assert.deepEqual(r.state, fixture(), 'state untouched');
});

test('a snapshot dry run restores from the snapshot and sets the autoscaling ceiling afterwards', () => {
	const ctx = setup();
	const r = run(ctx, [...BASE, '--snapshot', 'manual-1']);
	assert.equal(r.status, 0, r.stderr);
	const cmds = printed(r.stdout);
	const restore = cmds.find((c) => c.includes('restore-db-instance-from-db-snapshot'));
	assert.ok(restore?.includes(`--db-snapshot-identifier manual-1 --db-instance-identifier water-management-restore-${TS}`), restore);
	assert.ok(restore.includes(`--db-parameter-group-name ${PG}`));
	assert.ok(!restore.includes('--max-allocated-storage'), 'the snapshot restore API has no such parameter');
	const secret = cmds.find((c) => c.includes('--manage-master-user-password'));
	assert.ok(secret.includes('--max-allocated-storage 100'), secret);
});

test('--execute restores, verifies, swaps, moves Terraform state and stops short of apply', () => {
	const ctx = setup();
	const r = run(ctx, [...BASE, '--restore-time', '2026-09-27T08:15:00Z', '--execute', '--yes']);
	assert.equal(r.status, 0, r.stderr);

	const live = r.state.instances['water-management'];
	assert.equal(live.DbiResourceId, 'db-RESTORED', 'the original identifier now names the restored instance');
	assert.equal(live.restoredFrom, '2026-09-27T08:15:00Z');
	assert.equal(live.DBParameterGroups[0].DBParameterGroupName, PG);
	assert.equal(live.DeletionProtection, true);
	assert.equal(live.MasterUserSecret.SecretStatus, 'active');
	assert.match(live.MasterUserSecret.SecretArn, /rds!db-RESTORED$/, 'a new master secret');
	assert.equal(live.PreferredMaintenanceWindow, 'sun:01:30-sun:02:30');
	assert.deepEqual(live.EnabledCloudwatchLogsExports, ['postgresql']);

	const old = r.state.instances[`water-management-old-${TS}`];
	assert.equal(old.DbiResourceId, 'db-ORIGINAL', 'the old instance is kept');
	assert.equal(old.DeletionProtection, true);
	assert.equal(old.EnabledCloudwatchLogsExports, undefined, 'the renamed old instance exports no logs');
	assert.equal(r.state.instances[`water-management-restore-${TS}`], undefined);

	assert.ok(r.aws.every((c) => c.op !== 'delete-db-instance'));
	const tf = r.tf.filter((c) => c.args[0] !== 'output').map((c) => c.args.join(' '));
	assert.deepEqual(tf, [
		'state rm aws_db_instance.main',
		`import -input=false -var-file=${VAR_FILE} aws_db_instance.main water-management`,
		`plan -input=false -no-color -var-file=${VAR_FILE}`,
	]);
	assert.ok(r.tf.every((c) => c.profile === 'water-management'), 'Terraform runs under the given profile');
	// Import and plan evaluate the configuration, so they get the runtime
	// secrets (tf.sh, sops → ephemeral TF_VAR_*); reading state needs none.
	const RUNTIME = ['TF_VAR_alerts_token_secret', 'TF_VAR_auth_jwt_secret', 'TF_VAR_db_app_password'];
	assert.deepEqual(
		r.tf.map((c) => [c.args[0], c.tfvars]),
		r.tf.map((c) => [c.args[0], ['import', 'plan'].includes(c.args[0]) ? RUNTIME : []]),
	);
	assert.ok(r.stdout.includes(`tf.sh -chdir=`) && r.stdout.includes(` apply -var-file=${VAR_FILE}`), r.stdout);
	assert.match(r.stdout, /--function-name water-management-migrate --cli-binary-format/);
});

test('--execute stops before touching production when the restored instance does not match', () => {
	const ctx = setup();
	const r = run(ctx, [...BASE, '--latest', '--execute', '--yes'], { FAKE_RESTORE_DEFAULT_PG: '1' });
	assert.equal(r.status, 1);
	assert.match(r.stderr, /parameter group default\.postgres17, want water-management-pg17-/);
	assert.match(r.stderr, /production is untouched/);
	assert.equal(r.state.instances['water-management'].DbiResourceId, 'db-ORIGINAL');
	assert.ok(r.state.instances[`water-management-restore-${TS}`], 'the bad copy is left for inspection');
	assert.ok(r.aws.every((c) => !c.args['--new-db-instance-identifier']), 'no rename');
	assert.ok(r.tf.every((c) => c.args[0] === 'output'), 'no Terraform change');
});

test('--execute stops on an AWS error mid-wait instead of reading it as "no such instance"', () => {
	const ctx = setup();
	const r = run(ctx, [...BASE, '--latest', '--execute', '--yes'], { FAKE_EXPIRE_AFTER_RESTORE: '1' });
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /ExpiredTokenException/);
	assert.ok(r.aws.every((c) => !c.args['--new-db-instance-identifier']), 'no rename');
	assert.equal(r.state.instances['water-management'].DbiResourceId, 'db-ORIGINAL');
});

test('--execute refuses a plan that replaces or destroys', () => {
	const ctx = setup();
	const r = run(ctx, [...BASE, '--latest', '--execute', '--yes'], {
		FAKE_TF_PLAN: '  # aws_db_instance.main must be replaced\nPlan: 1 to add, 0 to change, 1 to destroy.',
	});
	assert.equal(r.status, 2);
	assert.match(r.stderr, /Do NOT apply it/);
});

test('guard rails', () => {
	const cases = [
		[['--profile', 'p', '--var-file', 'f', '--latest'], /--region is required/],
		[['--region', 'af-south-1', '--var-file', 'f', '--latest'], /--profile is required/],
		[['--region', 'af-south-1', '--profile', 'p', '--latest'], /--var-file is required/],
		[['--region', 'af-south-1', '--profile', 'p', '--var-file', '/nonexistent/prod.tfvars', '--latest'], /no such file/],
		[[...BASE], /exactly one of/],
		[[...BASE, '--latest', '--snapshot', 'manual-1'], /exactly one of/],
		[[...BASE, '--restore-time', '2026-09-27 08:15'], /must be UTC/],
		[[...BASE, '--restore-time', '2026-09-20T08:15:00Z'], /before the earliest restorable time/],
		[[...BASE, '--restore-time', '2026-09-28T10:05:00Z'], /after the latest restorable time/],
		[[...BASE, '--snapshot', 'nope'], /no snapshot nope/],
		[[...BASE, '--latest', '--bogus'], /unknown argument/],
	];
	for (const [args, why] of cases) {
		const ctx = setup();
		const r = run(ctx, args);
		assert.notEqual(r.status, 0, args.join(' '));
		assert.match(r.stderr, why, args.join(' '));
		assert.deepEqual(r.aws.filter((c) => !READ_ONLY.has(c.op)), [], args.join(' '));
	}
});

test('refuses to start without the sops secrets file that step 6 needs, before any AWS change', () => {
	const ctx = setup();
	const r = run(ctx, [...BASE, '--latest', '--execute', '--yes'], { WM_SECRETS_FILE: join(ctx.dir, 'missing.sops.yaml') });
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /no sops file at .*missing\.sops\.yaml/);
	assert.match(r.stderr, /needs the runtime secrets from sops/);
	assert.deepEqual(r.aws, [], 'not even a read');
	assert.deepEqual(r.tf, []);
});

test('refuses a region other than the stack\'s, and a stack without the database outputs', () => {
	let r = run(setup({ outputs: { ...OUTPUTS, aws_region: 'us-east-1' } }), [...BASE, '--latest']);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /not the stack's region \(us-east-1\)/);

	const { db_parameter_group_name: _, ...missing } = OUTPUTS;
	r = run(setup({ outputs: missing }), [...BASE, '--latest']);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr, /terraform output db_parameter_group_name is missing/);
});
