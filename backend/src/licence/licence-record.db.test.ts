// The licence record (159_licence_record.sql; provisional position, pre-counsel
// research 2026-10-01): the outcome owners record and the dates it gives, who
// may write it, the review the first nomination starts, the tick's notices,
// and a team that keeps public records (NARSSA): names stay in its projects'
// history and its projects and the team are kept until the client confirms
// their disposal. Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import { asOwner, mailCount, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';
import { outbox } from '../mail/transport.js';
import { sendLicenceRecordNotices } from './record.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let editor: User;
let projectId: string;
const at = () => `/projects/${projectId}/licence-record`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusYears = (s: string, n: number) => `${Number(s.slice(0, 4)) + n}${s.slice(4)}`;
const today = () => iso(new Date());

async function runnable(u: User, pid: string) {
	const outlet = node('Weir', null);
	const farm = node('Farm A', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 100_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${pid}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${pid}`, { settings: { apanMm: monthly(200), ewrPragmaticM3PerDay: monthly(4000) } })).status).toBe(200);
	const rain = Array.from({ length: 400 }, (_, i) => (i % 9 === 0 ? 25 : i % 4 === 0 ? 3 : 0));
	expect((await u.call('PUT', `/projects/${pid}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
}

beforeAll(async () => {
	[owner, editor] = (await Promise.all(['Lrowner', 'Lreditor'].map((n) => signUp(n)))) as [User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Licence record' })).body.project.id;
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: editor.email, role: 'editor' })).status).toBe(201);
}, 60_000);

describe('the licence record', () => {
	it('starts empty, with no review until the first nomination or issued pack', async () => {
		const res = await editor.call('GET', at());
		expect(res.status).toBe(200);
		expect(res.body.licenceRecord).toEqual({ outcome: null, outcomeOn: null, expiresOn: null, reason: '', closesOn: null, reviewDueOn: null });
	});

	it('starts the 5-yearly review when a run is first nominated as evidence', async () => {
		await runnable(owner, projectId);
		const runId = (await owner.call('POST', `/projects/${projectId}/runs`, { label: 'r' })).body.run.id;
		expect((await owner.call('POST', `/projects/${projectId}/evidence`, { runId, reason: 'the calibrated run' })).status).toBe(201);
		expect((await editor.call('GET', at())).body.licenceRecord.reviewDueOn).toBe(plusYears(today(), 5));
	});

	it('lets an owner, not an editor, record the outcome; a grant closes 3 years after it expires', async () => {
		const grant = { outcome: 'granted', outcomeOn: '2026-03-01', expiresOn: '2046-02-28', reason: 'DWS letter 16/2/7/A' };
		expect((await editor.call('PUT', at(), grant)).status).toBe(403);
		const res = await owner.call('PUT', at(), grant);
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.licenceRecord).toEqual({ ...grant, closesOn: '2049-02-28', reviewDueOn: null });
		const events = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'licence.outcome'`, [projectId]);
		expect(events.at(-1)?.subject).toMatchObject({ outcome: 'granted', closesOn: '2049-02-28', previous: null, reason: grant.reason });
	});

	it('closes a refused or withdrawn application 3 years after the decision', async () => {
		const res = await owner.call('PUT', at(), { outcome: 'refused', outcomeOn: '2026-03-01', reason: 'refused on appeal' });
		expect(res.body.licenceRecord).toMatchObject({ outcome: 'refused', expiresOn: null, closesOn: '2029-03-01' });
	});

	it('refuses a grant without an expiry, or expiring before it was granted', async () => {
		expect((await owner.call('PUT', at(), { outcome: 'granted', outcomeOn: '2026-03-01', reason: 'x' })).status).toBe(400);
		expect((await owner.call('PUT', at(), { outcome: 'granted', outcomeOn: '2026-03-01', expiresOn: '2026-02-01', reason: 'x' })).status).toBe(400);
		expect((await owner.call('PUT', at(), { outcome: 'refused', outcomeOn: '2026-03-01', reason: '' })).status).toBe(400);
	});

	it('refuses the app writing the dates itself, even as an owner (licence_record_guard)', async () => {
		for (const u of [owner, editor])
			await expect(
				withUser(u.id, (db) => db.query(`UPDATE project SET licence_outcome = NULL, licence_outcome_on = NULL, record_review_due_on = '2099-01-01' WHERE id = $1`, [projectId]))
			).rejects.toMatchObject({ code: '42501' });
		// Positive control: an editor still updates the rest of the row.
		expect((await editor.call('PATCH', `/projects/${projectId}`, { description: 'still editable' })).status).toBe(200);
	});

	it('confirms a review only while no outcome is recorded, setting the next one 5 years on', async () => {
		expect((await owner.call('POST', `${at()}/confirm`)).status).toBe(409);
		expect((await owner.call('PUT', at(), { outcome: null, reason: 'recorded on the wrong project' })).body.licenceRecord).toMatchObject({ outcome: null, closesOn: null });
		await asOwner(`UPDATE project SET record_review_due_on = '2020-01-01' WHERE id = $1`, [projectId]);
		expect((await editor.call('POST', `${at()}/confirm`)).status).toBe(403);
		const res = await owner.call('POST', `${at()}/confirm`);
		expect(res.status).toBe(200);
		expect(res.body.licenceRecord.reviewDueOn).toBe(plusYears(today(), 5));
		const events = await asOwner(`SELECT subject FROM audit_event WHERE project_id = $1 AND kind = 'licence.confirmed'`, [projectId]);
		expect(events.at(-1)?.subject).toMatchObject({ previousDueOn: '2020-01-01', reviewDueOn: plusYears(today(), 5) });
	});
});

describe('the tick’s notices', () => {
	let p: string;
	let o: User;
	const operatorEmail = `operator-${crypto.randomUUID()}@ops.example`;
	const ownMail = () => outbox.filter((m) => m.to === o.email && m.kind === 'licence_record');

	beforeAll(async () => {
		o = await signUp('Lrtick');
		p = (await o.call('POST', '/projects', { name: 'Due record' })).body.project.id;
		await asOwner(`UPDATE project SET record_review_due_on = current_date - 1 WHERE id = $1`, [p]);
	});

	it('asks the owners and the operator to record the outcome when the review is due, a month apart, three times in all', async () => {
		const first = await sendLicenceRecordNotices({ operatorEmail });
		expect(first.due).toBeGreaterThanOrEqual(1);
		expect(ownMail()).toHaveLength(1);
		expect(ownMail()[0]!.subject).toContain('Record the licence outcome for Due record');
		expect(outbox.filter((m) => m.to === operatorEmail && m.text.includes(p))).toHaveLength(1);
		// Not again the same month.
		await sendLicenceRecordNotices({ operatorEmail });
		expect(ownMail()).toHaveLength(1);
		for (let i = 2; i <= 4; i++) {
			await asOwner(`UPDATE project SET record_reminded_at = now() - interval '32 days' WHERE id = $1`, [p]);
			await sendLicenceRecordNotices({ operatorEmail });
			expect(ownMail()).toHaveLength(Math.min(i, 3));
		}
	});

	it('tells them once that the record can now be deleted when its closing date passes', async () => {
		const res = await o.call('PUT', `/projects/${p}/licence-record`, { outcome: 'withdrawn', outcomeOn: plusYears(today(), -4), reason: 'withdrawn by the applicant' });
		expect(res.body.licenceRecord.closesOn < today()).toBe(true);
		await sendLicenceRecordNotices({ operatorEmail });
		await sendLicenceRecordNotices({ operatorEmail });
		const closing = ownMail().filter((m) => m.subject.includes('can now be deleted'));
		expect(closing).toHaveLength(1);
		expect(closing[0]!.text).toContain('Nothing is deleted automatically');
		expect(outbox.filter((m) => m.to === operatorEmail && m.subject.includes('can now be deleted') && m.text.includes(p))).toHaveLength(1);
		// Still there: the app never deletes a licence record.
		expect(await asOwner('SELECT 1 FROM project WHERE id = $1', [p])).toHaveLength(1);
	});

	it('sends no operator copy without OPERATOR_EMAIL', async () => {
		const q = (await o.call('POST', '/projects', { name: 'No operator' })).body.project.id;
		await asOwner(`UPDATE project SET record_review_due_on = current_date WHERE id = $1`, [q]);
		const before = outbox.length;
		await sendLicenceRecordNotices({ operatorEmail: '' });
		const sent = outbox.slice(before).filter((m) => m.kind === 'licence_record');
		expect(sent.some((m) => m.to === o.email && m.subject.includes('No operator'))).toBe(true);
		expect(sent.every((m) => m.to !== operatorEmail)).toBe(true);
		expect(mailCount(o.email)).toBeGreaterThan(0);
	});
});

describe('a team that keeps public records', () => {
	let admin: User;
	let leaver: User;
	let teamId: string;
	let kept: string; // the public-records team's project
	let plain: string; // an ordinary project: the positive control

	beforeAll(async () => {
		[admin, leaver] = (await Promise.all(['Pradmin', 'Prleaver'].map((n) => signUp(n)))) as [User, User];
		teamId = (await admin.call('POST', '/teams', { name: 'Regional office' })).body.team.id;
		kept = (await admin.call('POST', '/projects', { name: 'Public', teamId })).body.project.id;
		plain = (await admin.call('POST', '/projects', { name: 'Plain' })).body.project.id;
		for (const pid of [kept, plain]) {
			expect((await admin.call('POST', `/projects/${pid}/members`, { email: leaver.email, role: 'editor' })).status).toBe(201);
			expect((await leaver.call('PATCH', `/projects/${pid}`, { description: 'edited by the leaver' })).status).toBe(200);
		}
	});

	it('is set only by the operator, never by the app', async () => {
		await expect(withUser(admin.id, (db) => db.query('UPDATE team SET public_records = true WHERE id = $1', [teamId]))).rejects.toMatchObject({ code: '42501' });
		await asOwner('UPDATE team SET public_records = true WHERE id = $1', [teamId]);
		// Positive control: an admin still renames it.
		expect((await admin.call('PATCH', `/teams/${teamId}`, { name: 'Regional office (DWS)' })).status).toBe(200);
	});

	it('keeps the deleted person’s name in its projects’ history; an ordinary project still pseudonymises', async () => {
		await asOwner('DELETE FROM app_user WHERE id = $1', [leaver.id]);
		const labels = async (pid: string) =>
			((await asOwner(`SELECT actor_label FROM audit_event WHERE project_id = $1 AND kind = 'project.changed' ORDER BY id`, [pid])) as { actor_label: string }[]).map(
				(r) => r.actor_label
			);
		expect(await labels(kept)).toContain('Prleaver');
		expect(await labels(plain)).toContain('Deleted user');
		expect(await labels(plain)).not.toContain('Prleaver');
	});

	it('keeps its projects and the team, and keeps a project in the team, until the disposal is confirmed', async () => {
		const del = await admin.call('DELETE', `/projects/${kept}`);
		expect(del.status).toBe(409);
		expect(del.body.error).toContain('public records');
		expect((await admin.call('PATCH', `/projects/${kept}`, { teamId: null })).status).toBe(409);
		expect((await admin.call('DELETE', `/teams/${teamId}`)).status).toBe(409);
		// The trigger holds whoever deletes.
		await expect(withUser(admin.id, (db) => db.query('DELETE FROM project WHERE id = $1', [kept]))).rejects.toMatchObject({ code: '23001' });
		// Positive control: the ordinary project goes.
		expect((await admin.call('DELETE', `/projects/${plain}`)).status).toBe(204);
		await asOwner('UPDATE team SET records_disposal_confirmed_on = current_date WHERE id = $1', [teamId]);
		expect((await admin.call('DELETE', `/projects/${kept}`)).status).toBe(204);
		expect((await admin.call('DELETE', `/teams/${teamId}`)).status).toBe(204);
	});
});
