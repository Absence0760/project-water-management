#!/usr/bin/env node
// A fake `aws` CLI for restore-db.test.mjs: just the RDS and STS calls
// restore-db.sh makes, against a JSON state file (FAKE_AWS_STATE). Every call
// is appended to FAKE_AWS_LOG as a JSON line. Any other call fails loudly, so
// a delete or an unexpected command can't pass unnoticed.
//
// FAKE_RESTORE_DEFAULT_PG=1 makes a restore ignore --db-parameter-group-name
// (the API's default-group behaviour), to test the verification step.
// FAKE_EXPIRE_AFTER_RESTORE=1 fails every describe after the restore as an
// expired session would, to test that the waits don't read that as "gone".
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const global = {};
while (argv[0]?.startsWith('--')) {
	global[argv.shift()] = argv.shift();
}
const [service, op, ...rest] = argv;
const args = {};
for (let i = 0; i < rest.length; i++) {
	const k = rest[i];
	const next = rest[i + 1];
	if (next === undefined || next.startsWith('--')) args[k] = true;
	else args[k] = rest[++i];
}
appendFileSync(process.env.FAKE_AWS_LOG, JSON.stringify({ service, op, args, global }) + '\n');

const statePath = process.env.FAKE_AWS_STATE;
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const fail = (code, msg) => {
	process.stderr.write(`An error occurred (${code}): ${msg}\n`);
	process.exit(254);
};
const instance = (id) => state.instances[id] ?? fail('DBInstanceNotFound', `DBInstance ${id} not found.`);

const ops = {
	'sts get-caller-identity': () =>
		out({ Account: '000000000000', Arn: 'arn:aws:sts::000000000000:assumed-role/Operator/test' }),
	'rds describe-db-instances': () => {
		if (process.env.FAKE_EXPIRE_AFTER_RESTORE === '1' && state.restored) {
			fail('ExpiredTokenException', 'The security token included in the request is expired');
		}
		out({ DBInstances: [instance(args['--db-instance-identifier'])] });
	},
	'rds describe-db-instance-automated-backups': () =>
		out(state.automatedBackups[args['--dbi-resource-id']] ?? { DBInstanceAutomatedBackups: [] }),
	'rds describe-db-snapshots': () => {
		const s = state.snapshots[args['--db-snapshot-identifier']];
		if (!s) fail('DBSnapshotNotFound', 'not found');
		out({ DBSnapshots: [s] });
	},
	'rds restore-db-instance-to-point-in-time': () =>
		restore(args['--target-db-instance-identifier'], instance(args['--source-db-instance-identifier']), {
			restoredFrom: args['--restore-time'] ?? (args['--use-latest-restorable-time'] === true ? 'latest' : '?'),
			MaxAllocatedStorage: args['--max-allocated-storage'] ? Number(args['--max-allocated-storage']) : undefined,
		}),
	'rds restore-db-instance-from-db-snapshot': () => {
		const snap = state.snapshots[args['--db-snapshot-identifier']];
		restore(args['--db-instance-identifier'], instance(snap.DBInstanceIdentifier), {
			restoredFrom: `snapshot:${args['--db-snapshot-identifier']}`,
		});
	},
	'rds modify-db-instance': () => {
		let id = args['--db-instance-identifier'];
		const inst = instance(id);
		if (args['--new-db-instance-identifier']) {
			delete state.instances[id];
			id = args['--new-db-instance-identifier'];
			if (state.instances[id]) fail('DBInstanceAlreadyExists', id);
			inst.DBInstanceIdentifier = id;
			state.instances[id] = inst;
		}
		if (args['--manage-master-user-password'] === true) {
			inst.MasterUserSecret = {
				SecretArn: `arn:aws:secretsmanager:${global['--region']}:000000000000:secret:rds!${inst.DbiResourceId}`,
				SecretStatus: 'active',
			};
		}
		if (args['--cloudwatch-logs-export-configuration']) {
			const c = JSON.parse(args['--cloudwatch-logs-export-configuration']);
			const now = new Set(inst.EnabledCloudwatchLogsExports ?? []);
			for (const t of c.EnableLogTypes ?? []) now.add(t);
			for (const t of c.DisableLogTypes ?? []) now.delete(t);
			inst.EnabledCloudwatchLogsExports = now.size ? [...now] : undefined;
		}
		if (args['--preferred-maintenance-window']) inst.PreferredMaintenanceWindow = args['--preferred-maintenance-window'];
		if (args['--max-allocated-storage']) inst.MaxAllocatedStorage = Number(args['--max-allocated-storage']);
		if (args['--no-deletion-protection'] === true) inst.DeletionProtection = false;
		save();
		out({ DBInstance: inst });
	},
};

function restore(target, src, extra) {
	if (state.instances[target]) fail('DBInstanceAlreadyExists', target);
	const sgs = String(args['--vpc-security-group-ids'] ?? 'sg-default').split(',');
	const pg =
		process.env.FAKE_RESTORE_DEFAULT_PG === '1'
			? 'default.postgres17'
			: (args['--db-parameter-group-name'] ?? 'default.postgres17');
	const inst = {
		DBInstanceIdentifier: target,
		DBInstanceStatus: 'available',
		DbiResourceId: 'db-RESTORED',
		DBSubnetGroup: { DBSubnetGroupName: args['--db-subnet-group-name'] ?? 'default' },
		VpcSecurityGroups: sgs.map((VpcSecurityGroupId) => ({ VpcSecurityGroupId, Status: 'active' })),
		DBParameterGroups: [{ DBParameterGroupName: pg }],
		StorageEncrypted: true,
		KmsKeyId: src.KmsKeyId,
		DeletionProtection: args['--deletion-protection'] === true,
		PubliclyAccessible: args['--no-publicly-accessible'] !== true,
		CACertificateIdentifier: args['--ca-certificate-identifier'] ?? 'rds-ca-rsa2048-g1',
		BackupRetentionPeriod: Number(args['--backup-retention-period'] ?? 1),
		PreferredBackupWindow: args['--preferred-backup-window'],
		MonitoringInterval: 0,
		MultiAZ: args['--multi-az'] === true,
		AutoMinorVersionUpgrade: args['--auto-minor-version-upgrade'] === true,
		CopyTagsToSnapshot: args['--copy-tags-to-snapshot'] === true,
		DBInstanceClass: args['--db-instance-class'] ?? src.DBInstanceClass,
		TagList: JSON.parse(args['--tags'] ?? '[]'),
		...extra,
	};
	state.instances[target] = inst;
	state.restored = true;
	save();
	out({ DBInstance: inst });
}

const fn = ops[`${service} ${op}`];
if (!fn) {
	process.stderr.write(`fake aws: unexpected call: ${service} ${op}\n`);
	process.exit(99);
}
fn();
