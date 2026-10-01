// What deleting an account does to the Step 2 records that name the person
// (roadmap WP-2.16, decision D12; 048_account_deletion.sql; docs/security.md
// § Personal information (POPIA)). There is no self-service account deletion
// yet: on a POPIA request the operator deletes the app_user row as the schema
// owner, which is what these tests do. Every foreign key to app_user decides
// what happens to its rows (catalogue.db.test.ts classifies each one); this
// checks the outcome end to end for a farmer, a co-owner, an assessor, and a
// modeller and an applicant who made evidence (138, issue #112: keep the
// evidence, remove the name), with the project's other members as the
// positive control.
import { beforeAll, describe, expect, it } from 'vitest';
import { runEnsemble } from '@water-management/engine';
import { FARMER_NOTICE_VERSION } from '@water-management/engine/legal';
import { asOwner, monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let coOwner: User;
let farmer: User;
let other: User; // a farmer who stays: the positive control
let projectId: string;
const outlet = node('Outlet', null);
const farmA = node('Farm A', outlet.id);
const farmB = node('Farm B', outlet.id);

type Item = { type: string; actor: string | null; kind: string; subject: Record<string, unknown> | null };
/** The project's audit events, as its owner reads the History (one page is plenty here). */
const events = async () => {
	const res = await owner.call('GET', `/projects/${projectId}/history?limit=100`);
	expect(res.status).toBe(200);
	expect(res.body.next).toBeNull();
	return (res.body.items as Item[]).filter((i) => i.type === 'event').map((i) => ({ ...i, subject: i.subject ?? {} }));
};
let runId: string;

beforeAll(async () => {
	[owner, coOwner, farmer, other] = (await Promise.all(['Downer', 'Dcoowner', 'Dfarmer', 'Dother'].map((n) => signUp(n)))) as [User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Deletion' })).body.project.id;
	const model = { nodes: [outlet, farmA, farmB], crops: [], cropAreas: [], transfers: [], landCover: [] };
	expect((await owner.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await owner.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), ewrPragmaticM3PerDay: monthly(300) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? 12 : 0));
	expect((await owner.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2022-10-01', values: rain })).status).toBe(200);
	expect((await owner.call('POST', `/projects/${projectId}/members`, { email: coOwner.email, role: 'owner' })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: farmer.email, nodeIds: [farmA.id] })).status).toBe(201);
	expect((await owner.call('POST', `/projects/${projectId}/farmers`, { email: other.email, nodeIds: [farmB.id] })).status).toBe(201);
	// The run is the owner's (the owner stays; a run whose maker is deleted keeps it with no name, 138), the publication the co-owner's.
	runId = (await owner.call('POST', `/projects/${projectId}/runs`, { label: 'r' })).body.run.id;
	expect((await coOwner.call('POST', `/projects/${projectId}/publication`, { runId })).status).toBe(201);
	expect((await coOwner.call('PATCH', `/projects/${projectId}/runs/${runId}`, { notes: 'checked against the gauge' })).status).toBe(200);
	expect((await coOwner.call('POST', `/projects/${projectId}/api-keys`, { name: 'logger' })).status).toBe(201);
	expect((await coOwner.call('POST', `/projects/${projectId}/share-links`, { label: 'WUA', expiresInDays: 30 })).status).toBe(201);
	for (const u of [farmer, other]) {
		const nodeId = u === farmer ? farmA.id : farmB.id;
		expect((await u.call('POST', `/projects/${projectId}/notes`, { body: u === farmer ? 'first note' : 'other note', nodeId, visibility: 'farm' })).status).toBe(201);
	}
}, 60_000);

describe('deleting a farmer’s account', () => {
	beforeAll(async () => {
		// The farmer acts in the log too: deleting their own note records note.deleted as them.
		const mine = (await farmer.call('GET', `/projects/${projectId}/notes`)).body.notes[0];
		expect((await farmer.call('DELETE', `/projects/${projectId}/notes/${mine.id}`)).status).toBe(204);
		expect((await farmer.call('POST', `/projects/${projectId}/notes`, { body: 'kept note', nodeId: farmA.id, visibility: 'farm' })).status).toBe(201);
		// Both farmers acknowledged the farm view's notice (093): the record is on the account row.
		for (const u of [farmer, other]) expect((await u.call('POST', '/auth/me/farm-notice', { version: FARMER_NOTICE_VERSION })).status).toBe(200);
		await asOwner('DELETE FROM app_user WHERE id = $1', [farmer.id]);
	});

	it('removes the membership and the farm links with the account', async () => {
		expect(await asOwner('SELECT 1 FROM project_member WHERE user_id = $1', [farmer.id])).toEqual([]);
		expect(await asOwner('SELECT 1 FROM farm_link WHERE user_id = $1', [farmer.id])).toEqual([]);
		// Positive control: the other farmer keeps theirs.
		expect(await asOwner('SELECT node_id FROM farm_link WHERE user_id = $1', [other.id])).toEqual([{ node_id: farmB.id }]);
	});

	it('takes their farm notice acknowledgement with the account row, like the terms record', async () => {
		expect(await asOwner('SELECT 1 FROM app_user WHERE id = $1', [farmer.id])).toEqual([]);
		// Positive control: the farmer who stays keeps theirs.
		expect(await asOwner('SELECT farm_notice_version FROM app_user WHERE id = $1', [other.id])).toEqual([{ farm_notice_version: FARMER_NOTICE_VERSION }]);
	});

	it('pseudonymises the audit log: "Deleted user" as actor and as subject, the events kept', async () => {
		const log = await events();
		const about = log.filter((e) => e.subject.userId === farmer.id);
		expect(about.map((e) => e.kind).sort()).toEqual(['farmer.linked', 'member.added']);
		for (const e of about) expect(e.subject.displayName).toBe('Deleted user');
		const acted = log.filter((e) => e.kind === 'note.deleted');
		expect(acted).toHaveLength(1);
		expect(acted[0]!.actor).toBe('Deleted user');
		expect(JSON.stringify(log)).not.toContain('Dfarmer');
		// Positive control: the farmer who stays is still named.
		expect(log.filter((e) => e.subject.userId === other.id).map((e) => e.subject.displayName)).toEqual(['Dother', 'Dother']);
		expect(await asOwner('SELECT count(*)::int AS n FROM audit_event WHERE actor_user_id = $1', [farmer.id])).toEqual([{ n: 0 }]);
	});

	it('keeps their notes as the project’s, with no author (shown as a former member)', async () => {
		const notes = (await owner.call('GET', `/projects/${projectId}/notes`)).body.notes as { body: string; author: string | null }[];
		expect(notes.find((n) => n.body === 'kept note')).toMatchObject({ author: null });
		expect(notes.find((n) => n.body === 'other note')).toMatchObject({ author: 'Dother' });
	});
});

describe('deleting a co-owner’s account', () => {
	beforeAll(async () => {
		// A pending invite they sent goes with them (invite.invited_by ON DELETE CASCADE).
		expect((await coOwner.call('POST', `/projects/${projectId}/members`, { email: `pending-${crypto.randomUUID()}@example.com`, role: 'viewer' })).status).toBe(201);
		await asOwner('DELETE FROM app_user WHERE id = $1', [coOwner.id]);
	});

	it('keeps the publication, the key and the share link, with no creator; the farm view names no one (the page words it)', async () => {
		expect(await asOwner('SELECT published_by FROM run_publication WHERE project_id = $1', [projectId])).toEqual([{ published_by: null }]);
		expect(await asOwner('SELECT created_by, revoked_at FROM api_key WHERE project_id = $1', [projectId])).toEqual([{ created_by: null, revoked_at: null }]);
		expect(await asOwner('SELECT created_by FROM share_link WHERE project_id = $1', [projectId])).toEqual([{ created_by: null }]);
		// The run note they last edited keeps its text, with no editor (model_run_stamp_notes must not put the id back).
		expect(await asOwner('SELECT notes, notes_updated_by FROM model_run WHERE id = $1', [runId])).toEqual([{ notes: 'checked against the gauge', notes_updated_by: null }]);
		const view = await other.call('GET', `/projects/${projectId}/farm/${farmB.id}`);
		expect(view.status).toBe(200);
		// null, not English words: the farm page says “A former member” in the reader's language (issue #51).
		expect(view.body.publication.publishedBy).toBeNull();
	});

	it('pseudonymises every event they made, and drops their pending invites', async () => {
		const log = await events();
		const theirs = log.filter((e) => ['publication.published', 'api_key.created', 'share_link.created', 'invite.sent'].includes(e.kind) && e.actor !== 'Downer');
		expect(theirs.map((e) => e.kind).sort()).toEqual(['api_key.created', 'invite.sent', 'publication.published', 'share_link.created']);
		for (const e of theirs) expect(e.actor).toBe('Deleted user');
		expect(JSON.stringify(log)).not.toContain('Dcoowner');
		// Positive control: the owner's own events keep the owner's name.
		expect(log.some((e) => e.actor === 'Downer')).toBe(true);
		expect(await asOwner('SELECT 1 FROM invite WHERE invited_by = $1', [coOwner.id])).toEqual([]);
	});
});

// An assessor who decided an application (045, WP-3.3): scenario.decided_by is
// ON DELETE SET NULL, and the foreign key's update has to get through
// scenario_guard, which refuses every other change to a decision (052).
describe('deleting an assessor’s account', () => {
	let assessor: User;
	let applicant: User;
	let sid: string;
	const decision = async () =>
		(await asOwner('SELECT status, outcome, decision_note, decided_at IS NOT NULL AS dated, decided_by, updated_at FROM scenario WHERE id = $1', [sid]))[0];

	beforeAll(async () => {
		[assessor, applicant] = (await Promise.all(['Dassessor', 'Dapplicant'].map((n) => signUp(n)))) as [User, User];
		for (const [u, role] of [
			[assessor, 'editor'],
			[applicant, 'contributor']
		] as const) {
			expect((await owner.call('POST', `/projects/${projectId}/members`, { email: u.email, role })).status).toBe(201);
		}
		const made = await applicant.call('POST', `/projects/${projectId}/scenarios`, { name: 'Raise the weir', baseRunId: runId, ops: [] });
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		sid = made.body.scenario.id;
		expect((await applicant.call('POST', `/projects/${projectId}/scenarios/${sid}/submit`)).status).toBe(200);
		const decided = await assessor.call('POST', `/projects/${projectId}/scenarios/${sid}/decide`, { outcome: 'refused', note: 'Too little left in dry years.' });
		expect(decided.status, JSON.stringify(decided.body)).toBe(200);
	});

	it('is refused to water_app while the account exists: a decision’s assessor never changes (positive control)', async () => {
		const before = await decision();
		expect(before).toMatchObject({ status: 'decided', decided_by: assessor.id });
		// Clearing who decided, or naming someone else, is still refused: the applicant is the app user the
		// update policy lets write a decided application (the guard, not RLS, stops them).
		for (const to of [null, owner.id]) {
			await expect(withUser(applicant.id, (db) => db.query('UPDATE scenario SET decided_by = $2 WHERE id = $1', [sid, to]))).rejects.toMatchObject({ code: '23514' });
		}
		// …and so is clearing it together with anything else.
		await expect(
			withUser(applicant.id, (db) => db.query(`UPDATE scenario SET decided_by = NULL, outcome = 'approved', decision_note = '' WHERE id = $1`, [sid]))
		).rejects.toMatchObject({ code: '23514' });
		expect(await decision()).toEqual(before);
	});

	it('goes through, keeping the decision with no assessor, and the scenario otherwise untouched', async () => {
		const before = await decision();
		await asOwner('DELETE FROM app_user WHERE id = $1', [assessor.id]);
		expect(await decision()).toEqual({ ...before, decided_by: null });
		const read = await owner.call('GET', `/projects/${projectId}/scenarios/${sid}`);
		expect(read.status).toBe(200);
		expect(read.body.scenario).toMatchObject({ status: 'decided', outcome: 'refused', decisionNote: 'Too little left in dry years.' });
		expect(JSON.stringify(await events())).not.toContain('Dassessor');
	});
});

// Evidence that names its maker (138_account_evidence_deletion, issue #112):
// a project, team, run, nomination, ensemble, scenario and import made by a
// modeller, and an applicant's applications. The rule is "keep the evidence,
// remove the name": every row stays with its maker cleared, except what only
// the person could ever finish or see (a started ensemble, a draft
// application and its runs). The positive controls: an editor still reads
// each row, with no name.
describe('deleting the account of a modeller who made evidence, and of an applicant', () => {
	let modeller: User;
	let applicant: User;
	let ownProject: string; // the modeller's own project, made by importing a project file
	let teamId: string;
	let modRun: string;
	let complete: string; // a completed ensemble on modRun
	let started: string; // a started one, never completed
	let teamScenario: string;
	let submitted: string; // the applicant's submitted application
	let draft: string; // their draft, with a run
	let draftRun: string;
	let keptDraft: string; // a draft whose run the project keeps (pinned)
	let keptRun: string;
	const P = () => `/projects/${projectId}`;
	const ok = async (res: Promise<{ status: number; body: any }>, status = 200) => {
		const r = await res;
		expect(r.status, JSON.stringify(r.body)).toBe(status);
		return r.body;
	};
	const ensemble = async () => (await ok(modeller.call('POST', `${P()}/runs/${modRun}/uncertainty`, { request: { members: 30, thresholds: { minSkill: -10, maxLowFlowBiasPct: null, wr2012MaxLevel: 'unusable' } } }), 201)).ensemble;

	beforeAll(async () => {
		[modeller, applicant] = (await Promise.all(['Dmodeller', 'Dapplicant2'].map((n) => signUp(n)))) as [User, User];
		await ok(owner.call('POST', `${P()}/members`, { email: modeller.email, role: 'owner' }), 201);
		await ok(owner.call('POST', `${P()}/members`, { email: applicant.email, role: 'contributor' }), 201);
		// A project they imported (project.created_by, project_import.imported_by), handed to a co-owner so they aren't its only owner.
		ownProject = (
			await ok(
				modeller.call('POST', '/projects/import', {
					format: 'water-management.project',
					version: 1,
					name: 'Imported by the modeller',
					description: '',
					settings: {},
					model: { nodes: [], crops: [], cropAreas: [], transfers: [] },
					series: [],
					importReport: { source: 'project-file', fileName: 'catchment.json', importerVersion: 'test' }
				}),
				201
			)
		).project.id;
		await ok(modeller.call('POST', `/projects/${ownProject}/members`, { email: owner.email, role: 'owner' }), 201);
		// A team they made (team.created_by), with a second admin.
		teamId = (await ok(modeller.call('POST', '/teams', { name: 'Modeller team' }), 201)).team.id;
		await ok(modeller.call('POST', `/teams/${teamId}/members`, { email: owner.email, role: 'admin' }), 201);
		// A gauge record, which an ensemble needs.
		const flow = Array.from({ length: 60 }, (_, i) => 0.02 * (1 + 0.5 * Math.sin(i / 7)));
		await ok(modeller.call('PUT', `${P()}/series`, { kind: 'flow_observed_m3s', unit: 'm3/s', startDate: '2022-10-01', values: flow }));
		// A run, nominated as evidence (model_run.created_by, run_nomination.nominated_by).
		modRun = (await ok(modeller.call('POST', `${P()}/runs`, { label: 'modeller run' }), 201)).run.id;
		await ok(modeller.call('POST', `${P()}/evidence`, { runId: modRun, reason: 'the calibrated run' }), 201);
		// Two ensembles (run_uncertainty.created_by): one completed, one left started.
		const e = await ensemble();
		const input = (await ok(modeller.call('GET', `${P()}/runs/${modRun}/model-input`))).input;
		const { members, coverage } = runEnsemble(input, e.options);
		await ok(modeller.call('POST', `${P()}/runs/${modRun}/uncertainty/${e.id}/result`, { members, coverage }));
		complete = e.id;
		started = (await ensemble()).id;
		// A team scenario (scenario.owner_user_id, origin team).
		teamScenario = (await ok(modeller.call('POST', `${P()}/scenarios`, { name: 'Team option', baseRunId: runId, ops: [] }), 201)).scenario.id;
		// The applicant: one application submitted (the project's record), one still a draft, with a run.
		submitted = (await ok(applicant.call('POST', `${P()}/scenarios`, { name: 'New dam', baseRunId: runId, ops: [] }), 201)).scenario.id;
		await ok(applicant.call('POST', `${P()}/scenarios/${submitted}/submit`));
		draft = (await ok(applicant.call('POST', `${P()}/scenarios`, { name: 'Bigger dam', baseRunId: runId, ops: [] }), 201)).scenario.id;
		draftRun = (await ok(applicant.call('POST', `${P()}/scenarios/${draft}/runs`, { label: 'draft run' }), 201)).run.id;
		// A draft whose run the project keeps: pinned (as the schema owner; an applicant can't pin), so the draft stays.
		keptDraft = (await ok(applicant.call('POST', `${P()}/scenarios`, { name: 'Weir option', baseRunId: runId, ops: [] }), 201)).scenario.id;
		keptRun = (await ok(applicant.call('POST', `${P()}/scenarios/${keptDraft}/runs`, { label: 'kept run' }), 201)).run.id;
		await asOwner('UPDATE model_run SET pinned = true WHERE id = $1', [keptRun]);
	}, 120_000);

	it('refuses anyone a change to who made a row while the account exists (negative controls)', async () => {
		// An editor (the owner) can update the project and team rows, but not their maker: clearing it or naming someone else.
		for (const to of [null, owner.id]) {
			await expect(withUser(owner.id, (db) => db.query('UPDATE project SET created_by = $2 WHERE id = $1', [ownProject, to]))).rejects.toMatchObject({ code: '23514' });
			await expect(withUser(owner.id, (db) => db.query('UPDATE team SET created_by = $2 WHERE id = $1', [teamId, to]))).rejects.toMatchObject({ code: '23514' });
		}
		// Nor a scenario's owner, or a completed ensemble's starter (not even the schema owner, while the account exists).
		await expect(withUser(modeller.id, (db) => db.query('UPDATE scenario SET owner_user_id = NULL WHERE id = $1', [teamScenario]))).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner('UPDATE run_uncertainty SET created_by = NULL WHERE id = $1', [complete])).rejects.toMatchObject({ code: '23514' });
		await expect(asOwner('UPDATE model_run SET created_by = NULL WHERE id = $1', [modRun])).rejects.toMatchObject({ code: '23514' });
		// A new project, team or run needs its maker, though the columns are nullable now.
		await expect(asOwner(`INSERT INTO project (name, created_by) VALUES ('No maker', NULL)`)).rejects.toMatchObject({ code: '23502' });
		await expect(asOwner(`INSERT INTO team (name, created_by) VALUES ('No maker', NULL)`)).rejects.toMatchObject({ code: '23502' });
		expect(await asOwner('SELECT created_by FROM project WHERE id = $1', [ownProject])).toEqual([{ created_by: modeller.id }]);
		expect(await asOwner('SELECT created_by FROM team WHERE id = $1', [teamId])).toEqual([{ created_by: modeller.id }]);
	});

	it('refuses an account that is a project’s only owner, until it is handed over', async () => {
		const alone = await signUp('Dalone');
		await ok(alone.call('POST', '/projects', { name: 'Only mine' }), 201);
		await expect(asOwner('DELETE FROM app_user WHERE id = $1', [alone.id])).rejects.toMatchObject({ code: '23514' });
		expect(await asOwner('SELECT 1 FROM app_user WHERE id = $1', [alone.id])).toHaveLength(1);
	});

	describe('once both accounts are deleted', () => {
		beforeAll(async () => {
			await asOwner('DELETE FROM app_user WHERE id = $1', [modeller.id]);
			await asOwner('DELETE FROM app_user WHERE id = $1', [applicant.id]);
		});

		it('keeps every row of evidence with its maker cleared', async () => {
			expect(await asOwner('SELECT created_by FROM project WHERE id = $1', [ownProject])).toEqual([{ created_by: null }]);
			expect(await asOwner('SELECT imported_by FROM project_import WHERE project_id = $1', [ownProject])).toEqual([{ imported_by: null }]);
			expect(await asOwner('SELECT created_by FROM team WHERE id = $1', [teamId])).toEqual([{ created_by: null }]);
			expect(await asOwner('SELECT created_by FROM model_run WHERE id = $1', [modRun])).toEqual([{ created_by: null }]);
			expect(await asOwner('SELECT nominated_by FROM run_nomination WHERE run_id = $1', [modRun])).toEqual([{ nominated_by: null }]);
			expect(await asOwner(`SELECT status, created_by FROM run_uncertainty WHERE id = $1`, [complete])).toEqual([{ status: 'complete', created_by: null }]);
			expect(await asOwner('SELECT owner_user_id, origin FROM scenario WHERE id = $1', [teamScenario])).toEqual([{ owner_user_id: null, origin: 'team' }]);
			expect(await asOwner('SELECT owner_user_id, status FROM scenario WHERE id = $1', [submitted])).toEqual([{ owner_user_id: null, status: 'submitted' }]);
			// Nothing else names either of them by id.
			for (const u of [modeller, applicant]) {
				for (const [t, c] of [
					['project', 'created_by'],
					['team', 'created_by'],
					['model_run', 'created_by'],
					['run_uncertainty', 'created_by'],
					['run_nomination', 'nominated_by'],
					['project_import', 'imported_by'],
					['scenario', 'owner_user_id']
				]) {
					expect(await asOwner(`SELECT 1 FROM ${t} WHERE ${c} = $1`, [u.id])).toEqual([]);
				}
			}
		});

		it('drops what only they could finish or see: the started ensemble, the draft application and its run', async () => {
			expect(await asOwner('SELECT 1 FROM run_uncertainty WHERE id = $1', [started])).toEqual([]);
			expect(await asOwner('SELECT 1 FROM scenario WHERE id = $1', [draft])).toEqual([]);
			// The run went with it, not left behind as a run of the model (scenario_id cleared).
			expect(await asOwner('SELECT 1 FROM model_run WHERE id = $1', [draftRun])).toEqual([]);
		});

		it('keeps a draft the project relies on (a kept run), its applicant cleared, so no run is left without its scenario', async () => {
			expect(await asOwner('SELECT owner_user_id, status FROM scenario WHERE id = $1', [keptDraft])).toEqual([{ owner_user_id: null, status: 'draft' }]);
			expect(await asOwner('SELECT scenario_id, created_by FROM model_run WHERE id = $1', [keptRun])).toEqual([{ scenario_id: keptDraft, created_by: null }]);
		});

		it('still shows an editor the run, the nomination history, the ensemble and the scenarios, with no name (positive controls)', async () => {
			const runs = (await ok(owner.call('GET', `${P()}/runs`))).runs as { id: string; createdBy: string | null }[];
			expect(runs.find((r) => r.id === modRun)).toMatchObject({ createdBy: null });
			expect(runs.some((r) => r.id === draftRun)).toBe(false);
			expect((await ok(owner.call('GET', `${P()}/runs/${modRun}`))).run).toMatchObject({ id: modRun, createdBy: null });
			const nominations = (await ok(owner.call('GET', `${P()}/evidence`))).nominations as { runId: string; nominatedBy: string | null }[];
			expect(nominations.find((n) => n.runId === modRun)).toMatchObject({ nominatedBy: null });
			const ensembles = (await ok(owner.call('GET', `${P()}/runs/${modRun}/uncertainty`))).ensembles as { id: string; createdBy: string | null; createdById: string | null }[];
			expect(ensembles).toEqual([expect.objectContaining({ id: complete, createdBy: null, createdById: null })]);
			const compared = await ok(owner.call('GET', '/compare/runs?' + new URLSearchParams({ a: `${projectId}:${runId}`, b: `${projectId}:${modRun}` })));
			expect(compared.b.run).toMatchObject({ id: modRun, createdBy: null });
			for (const sid of [teamScenario, submitted]) {
				expect((await ok(owner.call('GET', `${P()}/scenarios/${sid}`))).scenario).toMatchObject({ id: sid, owner: null, ownerUserId: null });
			}
			expect((await ok(owner.call('GET', `/projects/${ownProject}/import-report`))).report).toMatchObject({ importedBy: null });
			const teams = (await ok(owner.call('GET', '/teams'))).teams as { id: string }[];
			expect(teams.map((t) => t.id)).toContain(teamId);
			// Their names are gone from the project's history too (048).
			expect(JSON.stringify(await events())).not.toMatch(/Dmodeller|Dapplicant2/);
		});
	});
});
