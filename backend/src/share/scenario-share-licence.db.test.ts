// A decided application's share link prints the licence's granted terms and
// what followed the decision (291_share_licence_terms; 227_licence_terms,
// 228_decision_events; issue #523 G3/G4; docs/security.md § Scenario links).
// Every "cannot see" has its positive control (CLAUDE.md rule 5):
//
//   - a submitted application's link shows no terms, events or standing; once
//     decided, the granted terms, their conditions and the standing;
//   - an `allocation.set` on another unit is left out of the terms (its
//     volume never leaves through the link), the own unit's change shown;
//   - each appeal event with its forum, date, reference, note and a
//     variation's terms, never who recorded it (an assessor reads that);
//   - app_share_terms isn't callable by water_app.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actForAuthority, anon, DECISION, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
import { parseToken } from '../auth/tokens.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let assessor: User; // editor acting for the authority
let applicant: User; // contributor linked to Own dam
let projectId: string;
let published: string;
let sid: string;
let token: string;

const outlet = node('Gauge', null);
const own = node('Own dam farm', outlet.id, { damCapacityM3: 100_000 });
const neighbour = node('Neighbour Secret Farm', outlet.id, { damCapacityM3: 50_000 });
// A registered volume no link may carry.
const CANARY = 987_654;
const P = () => `/projects/${projectId}`;
const dam = (nodeId: string, value: number) => ({ op: 'node.set', nodeId, field: 'damCapacityM3', value });
const neighbourVolume = { op: 'allocation.set', allocation: { id: crypto.randomUUID(), nodeId: neighbour.id, waterSource: 'surface', volumeM3PerYear: CANARY } };
const tokenOf = (url: string) => new URLSearchParams(new URL(url).hash.slice(1)).get('t')!;
const open = async () => {
	const res = await anon('POST', '/share/scenario', { token });
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body;
};
const appeal = async (body: Record<string, unknown>) => {
	const res = await assessor.call('POST', `${P()}/scenarios/${sid}/appeals`, body);
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.scenario;
};

beforeAll(async () => {
	[owner, assessor, applicant] = (await Promise.all(['Tlowner', 'Tlassessor', 'Tlapplicant'].map((n) => signUp(n)))) as [User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Shared licences' })).body.project.id;
	expect((await owner.call('PUT', `${P()}/model`, { nodes: [outlet, own, neighbour], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const base = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(base.status, JSON.stringify(base.body)).toBe(201);
	published = base.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	for (const [u, role] of [
		[assessor, 'editor'],
		[applicant, 'contributor']
	] as const)
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status, u.email).toBe(201);
	await actForAuthority(owner, projectId, assessor.id);
	expect((await owner.call('PUT', `${P()}/farmers/${applicant.id}`, { nodeIds: [own.id] })).status).toBe(200);
	const created = await applicant.call('POST', `${P()}/scenarios`, { name: 'Raise my dam', baseRunId: published, ops: [dam(own.id, 150_000)] });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	sid = created.body.scenario.id;
	expect((await applicant.call('POST', `${P()}/scenarios/${sid}/submit`, {})).status).toBe(200);
	const made = await applicant.call('POST', `${P()}/share-links`, { label: 'Forum', expiresInDays: 30, targetKind: 'scenario', targetId: sid });
	expect(made.status, JSON.stringify(made.body)).toBe(201);
	token = tokenOf(made.body.link.url);
}, 120_000);

afterAll(async () => {
	await retirePendingJobs(projectId);
});

describe("a decided application's link: the licence's terms and what followed (291)", () => {
	it('shows no terms, events or standing while the application is only submitted', async () => {
		const v = await open();
		expect(v.scenario).toMatchObject({ status: 'submitted', grantedTerms: null, decisionEvents: [], licence: null, withheldOps: 0 });
	});

	it('shows the granted terms and their conditions once issued, without another unit’s registered volume', async () => {
		const decided = await assessor.call('POST', `${P()}/scenarios/${sid}/decide`, {
			...DECISION,
			outcome: 'licence_issued',
			note: 'Issued on a smaller dam.',
			granted: { ops: [dam(own.id, 120_000), neighbourVolume], conditions: 'Release 5 % of inflow in dry months.' }
		});
		expect(decided.status, JSON.stringify(decided.body)).toBe(200);
		// Positive control: the assessor reads the volume in the terms.
		expect(decided.body.scenario.grantedTerms.ops).toHaveLength(2);
		const v = await open();
		expect(v.scenario.outcome).toBe('licence_issued');
		expect(v.scenario.grantedTerms).toEqual({
			ops: [dam(own.id, 120_000)],
			opsSha256: decided.body.scenario.grantedTerms.opsSha256,
			opNames: [{ id: own.id, name: 'Own dam farm' }],
			conditions: 'Release 5 % of inflow in dry months.',
			asApplied: false,
			withheldOps: 1
		});
		expect(v.scenario.licence).toEqual({ inForce: true, from: 'decision', eventPosition: null, appealPending: false });
		expect(v.scenario.decisionEvents).toEqual([]);
		const text = JSON.stringify(v);
		expect(text).not.toContain(String(CANARY));
		expect(text).not.toContain('Neighbour Secret Farm');
	});

	it('shows each appeal event and a variation’s terms, never who recorded them', async () => {
		const lodged = await appeal({ kind: 'lodged', forum: 'water_tribunal', eventDate: '2026-10-02', reference: 'WT 12/2026', note: 'Lodged by the neighbour.' });
		// Positive control: an assessor reads who recorded it.
		expect(lodged.decisionEvents[0].recordedBy).toBeTruthy();
		const pending = await open();
		expect(pending.scenario.licence).toEqual({ inForce: true, from: 'decision', eventPosition: null, appealPending: true });
		expect(pending.scenario.decisionEvents).toEqual([
			{ position: 1, kind: 'lodged', forum: 'water_tribunal', eventDate: '2026-10-02', reference: 'WT 12/2026', note: 'Lodged by the neighbour.', terms: null }
		]);

		await appeal({ kind: 'varied', forum: 'water_tribunal', eventDate: '2026-10-08', terms: { ops: [dam(own.id, 110_000), neighbourVolume], conditions: 'As the Tribunal ordered.' } });
		const v = await open();
		expect(v.scenario.licence).toEqual({ inForce: true, from: 'event', eventPosition: 2, appealPending: false });
		expect(v.scenario.decisionEvents[1]).toMatchObject({
			position: 2,
			kind: 'varied',
			terms: { ops: [dam(own.id, 110_000)], conditions: 'As the Tribunal ordered.', asApplied: false, withheldOps: 1 }
		});
		// The granted terms still print as the decision recorded them.
		expect(v.scenario.grantedTerms.ops).toEqual([dam(own.id, 120_000)]);
		const text = JSON.stringify(v);
		for (const leak of [String(CANARY), 'Neighbour Secret Farm', assessor.id, assessor.email, 'Tlassessor', 'recordedBy', 'recordedAt']) expect(text, leak).not.toContain(leak);
	});

	it('leaves who recorded an event out of the database projection too, and keeps its helper from water_app', async () => {
		const hash = parseToken(token);
		const rows = await withUser(applicant.id, async (db) => (await db.query<{ scenario: Record<string, unknown> }>('SELECT scenario FROM app_share_scenario($1)', [hash])).rows);
		expect(rows).toHaveLength(1);
		const events = rows[0]!.scenario.decisionEvents as Record<string, unknown>[];
		expect(events).toHaveLength(2);
		for (const e of events) expect(Object.keys(e).sort()).toEqual(['eventDate', 'forum', 'kind', 'note', 'position', 'reference', 'terms']);
		const code = await withUser(applicant.id, (db) => db.query(`SELECT app_share_terms('[]'::jsonb, NULL, '[]'::jsonb, '', NULL, '{}')`)).then(
			() => 'ran',
			(e: { code?: string }) => e.code
		);
		expect(code).toBe('42501');
	});
});
