// Account deletion blanks the person's partly hidden address in invitation
// entries (160_pseudonymise_invites.sql, decision D12; docs/security.md
// § Personal information (POPIA)). The trigger finds the entries by the
// masked text, so app_mask_email must mask exactly as history/record.ts
// maskEmail does: the pairing test below keeps them from drifting.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, signUp } from '../__tests__/helpers.js';
import { maskEmail } from './record.js';

describe('app_mask_email', () => {
	it('masks every address exactly as maskEmail does', async () => {
		const samples = [
			'jane@example.com',
			'J.van.Rooyen@Boerdery.co.za',
			'a@b',
			'x@y@z.example',
			'@leading.example',
			'@two@ats.example',
			'nope',
			'',
			'trailing@',
			'ü-mlaut@exämple.de'
		];
		const rows = (await asOwner('SELECT s, app_mask_email(s) AS m FROM unnest($1::text[]) s', [samples])) as { s: string; m: string }[];
		for (const r of rows) expect(r.m, r.s).toBe(maskEmail(r.s));
	});
});

describe('deleting an account blanks its address in invitation entries', () => {
	const domain = `${crypto.randomUUID()}.example`;
	let projectId: string;
	let goneId: string;

	const emails = async () =>
		((await asOwner(`SELECT kind, subject->>'email' AS email FROM audit_event WHERE project_id = $1 ORDER BY id`, [projectId])) as { kind: string; email: string }[]).map(
			(r) => `${r.kind} ${r.email}`
		);

	beforeAll(async () => {
		const owner = await signUp('Inviter');
		const gone = await signUp('Gone');
		goneId = gone.id;
		// A personal domain the test owns, so nothing else in the shared database matches.
		await asOwner('UPDATE app_user SET email = $2 WHERE id = $1', [goneId, `Jan@${domain}`]);
		projectId = (await owner.call('POST', '/projects', { name: 'Invites' })).body.project.id;
		const sent = [`jan@${domain}`, `JAN@${domain.toUpperCase()}`, `kim@${domain}`, `jan@other-${domain}`];
		for (const [i, email] of sent.entries())
			await asOwner(`INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject) VALUES ($1, $2, 'Inviter', $3, $4)`, [
				projectId,
				owner.id,
				i === 1 ? 'invite.revoked' : 'invite.sent',
				JSON.stringify({ inviteId: crypto.randomUUID(), email: maskEmail(email), role: 'viewer' })
			]);
		// A declined invite, written as app_decline_invite writes it (109).
		await asOwner(`INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject) VALUES ($1, NULL, '', 'invite.declined', $2)`, [
			projectId,
			JSON.stringify({ inviteId: crypto.randomUUID(), email: maskEmail(`jan@${domain}`), role: 'viewer' })
		]);
		// Not an invitation entry: a masked address elsewhere is left alone.
		await asOwner(`INSERT INTO audit_event (project_id, actor_user_id, actor_label, kind, subject) VALUES ($1, $2, 'Inviter', 'project.changed', $3)`, [
			projectId,
			owner.id,
			JSON.stringify({ email: maskEmail(`jan@${domain}`) })
		]);
		expect(await emails()).toEqual([
			`invite.sent j•••@${domain}`,
			`invite.revoked J•••@${domain.toUpperCase()}`,
			`invite.sent k•••@${domain}`,
			`invite.sent j•••@other-${domain}`,
			`invite.declined j•••@${domain}`,
			`project.changed j•••@${domain}`
		]);
		await asOwner('DELETE FROM app_user WHERE id = $1', [goneId]);
	});

	it('blanks the masked address in invite.sent, invite.revoked and invite.declined, ignoring case', async () => {
		const after = await emails();
		expect(after.filter((e) => e.startsWith('invite.') && e.includes(`@${domain}`) && !e.includes('other-'))).toEqual([`invite.sent k•••@${domain}`]);
		expect(after).toContain('invite.sent •••');
		expect(after).toContain('invite.revoked •••');
		expect(after).toContain('invite.declined •••');
	});

	it('keeps other people’s masked addresses (positive control) and other kinds of entry', async () => {
		const after = await emails();
		expect(after).toContain(`invite.sent k•••@${domain}`);
		expect(after).toContain(`invite.sent j•••@other-${domain}`);
		expect(after).toContain(`project.changed j•••@${domain}`);
		// The entries themselves stay.
		expect(after).toHaveLength(6);
	});
});
