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
//   - app_share_terms isn't callable by water_app;
//   - the WULA reference (294) once submitted: its number and the works as
//     applied for in the applicant's words, each op's `works` tag in its ops;
//     none for an application that gave none;
//   - app_share_scenario itself, called as the share path calls it, leaves
//     another unit's `allocation.set` out of every list of ops (its own,
//     the granted terms', a variation's) and counts it, the applicant's own
//     unit's shown: no caller has to filter (291 app_share_kept).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actForAuthority, anon, asOwner, DECISION, monthly, node, retirePendingJobs, signUp } from '../__tests__/helpers.js';
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
const ownVolume = (v: number) => ({ op: 'allocation.set', allocation: { id: crypto.randomUUID(), nodeId: own.id, waterSource: 'surface', volumeM3PerYear: v } });
const WULA_NUMBER = 'WU-2026-0042';
const WULA_WORKS = [
	{ ref: 'W1', text: 'Raise the dam wall by 2 m' },
	{ ref: 'W2', text: 'A pipeline to the lower lands' }
];
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
	const created = await applicant.call('POST', `${P()}/scenarios`, { name: 'Raise my dam', baseRunId: published, ops: [{ ...dam(own.id, 150_000), works: 'W1' }] });
	expect(created.status, JSON.stringify(created.body)).toBe(201);
	sid = created.body.scenario.id;
	// The WULA it models (294), given while a draft.
	const wula = await applicant.call('PATCH', `${P()}/scenarios/${sid}`, { wulaNumber: WULA_NUMBER, wulaWorks: WULA_WORKS });
	expect(wula.status, JSON.stringify(wula.body)).toBe(200);
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

	it('shows the WULA reference once submitted: its number, the works as applied for and each op’s works tag', async () => {
		const v = await open();
		expect(v.scenario.wula).toEqual({ number: WULA_NUMBER, works: WULA_WORKS });
		expect(v.scenario.ops).toEqual([{ ...dam(own.id, 150_000), works: 'W1' }]);
		// The database projection carries exactly those two keys.
		const rows = await withUser(applicant.id, async (db) => (await db.query<{ scenario: Record<string, unknown> }>('SELECT scenario FROM app_share_scenario($1)', [parseToken(token)])).rows);
		expect(Object.keys(rows[0]!.scenario.wula as object).sort()).toEqual(['number', 'works']);
	});

	it('shows no WULA reference for an application that gave none (positive control: the one above)', async () => {
		const other = await applicant.call('POST', `${P()}/scenarios`, { name: 'Without a WULA', baseRunId: published, ops: [dam(own.id, 130_000)] });
		expect(other.status, JSON.stringify(other.body)).toBe(201);
		const oid = other.body.scenario.id as string;
		expect((await applicant.call('POST', `${P()}/scenarios/${oid}/submit`, {})).status).toBe(200);
		const made = await applicant.call('POST', `${P()}/share-links`, { label: 'Forum 2', expiresInDays: 30, targetKind: 'scenario', targetId: oid });
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		const res = await anon('POST', '/share/scenario', { token: tokenOf(made.body.link.url) });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.scenario.wula).toBeNull();
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

	it('leaves another unit’s registered volume out of every list of ops in the SQL itself, the own unit’s shown', async () => {
		const OWN_VOLUME = 123_456;
		const mine = ownVolume(OWN_VOLUME);
		const created = await applicant.call('POST', `${P()}/scenarios`, { name: 'Register my volume', baseRunId: published, ops: [mine, neighbourVolume, dam(own.id, 140_000)] });
		expect(created.status, JSON.stringify(created.body)).toBe(201);
		const id = created.body.scenario.id as string;
		expect((await applicant.call('POST', `${P()}/scenarios/${id}/submit`, {})).status).toBe(200);
		const decided = await assessor.call('POST', `${P()}/scenarios/${id}/decide`, {
			...DECISION,
			outcome: 'licence_issued',
			note: 'Issued.',
			granted: { ops: [mine, neighbourVolume], conditions: '' }
		});
		expect(decided.status, JSON.stringify(decided.body)).toBe(200);
		const lodged = await assessor.call('POST', `${P()}/scenarios/${id}/appeals`, { kind: 'lodged', forum: 'court', eventDate: '2026-10-05' });
		expect(lodged.status, JSON.stringify(lodged.body)).toBe(201);
		const varied = await assessor.call('POST', `${P()}/scenarios/${id}/appeals`, { kind: 'varied', forum: 'court', eventDate: '2026-10-09', terms: { ops: [neighbourVolume, mine], conditions: '' } });
		expect(varied.status, JSON.stringify(varied.body)).toBe(201);
		const made = await applicant.call('POST', `${P()}/share-links`, { label: 'SQL', expiresInDays: 30, targetKind: 'scenario', targetId: id });
		expect(made.status, JSON.stringify(made.body)).toBe(201);

		// As the share path calls it: water_app, through withUser.
		const hash = parseToken(tokenOf(made.body.link.url));
		const rows = await withUser(applicant.id, async (db) => (await db.query<{ scenario: Record<string, unknown> }>('SELECT scenario FROM app_share_scenario($1)', [hash])).rows);
		expect(rows).toHaveLength(1);
		const sc = rows[0]!.scenario as {
			ops: unknown[];
			withheldOps: number;
			grantedTerms: { ops: unknown[]; withheldOps: number };
			decisionEvents: { terms: { ops: unknown[]; withheldOps: number } | null }[];
		};
		const lists = [sc.ops, sc.grantedTerms.ops, ...sc.decisionEvents.filter((e) => e.terms).map((e) => e.terms!.ops)];
		expect(lists).toHaveLength(3);
		for (const ops of lists) {
			// None of another unit's allocation.set, in any list.
			const others = (ops as { op: string; allocation?: { nodeId?: string } }[]).filter((o) => o.op === 'allocation.set' && o.allocation?.nodeId !== own.id);
			expect(others).toEqual([]);
			// Positive control: the applicant's own unit's allocation.set stays.
			expect(ops).toContainEqual(mine);
		}
		expect(sc.ops).toEqual([mine, dam(own.id, 140_000)]);
		expect(sc.withheldOps).toBe(1);
		expect(sc.grantedTerms).toMatchObject({ ops: [mine], withheldOps: 1 });
		expect(sc.decisionEvents[1]!.terms).toMatchObject({ ops: [mine], withheldOps: 1 });
		const text = JSON.stringify(rows[0]);
		expect(text).not.toContain(String(CANARY));
		expect(text).toContain(String(OWN_VOLUME));

		// The API's answer agrees (its second line drops nothing more, and the counts aren't doubled).
		const v = (await anon('POST', '/share/scenario', { token: tokenOf(made.body.link.url) })).body;
		expect(v.scenario).toMatchObject({ ops: [mine, dam(own.id, 140_000)], withheldOps: 1, grantedTerms: { ops: [mine], withheldOps: 1 } });
		expect(v.scenario.decisionEvents[1].terms).toMatchObject({ ops: [mine], withheldOps: 1 });
	});

	it('keeps a run’s per-op classes at the positions of the ops shown (app_share_kept, as the schema owner)', async () => {
		const ops = [ownVolume(1), neighbourVolume, dam(own.id, 1), { op: 'allocation.set', allocation: { id: 'x', waterSource: 'surface', volumeM3PerYear: 2 } }];
		const [r] = await asOwner('SELECT app_share_kept($1::jsonb, $2::jsonb, $3::text[]) AS kept, app_share_kept(NULL, $2::jsonb, $3::text[]) AS none', [
			JSON.stringify(['a', 'b', 'c', 'd']),
			JSON.stringify(ops),
			[own.id]
		]);
		// Another unit's and a unit-less allocation.set dropped; the own unit's and every other op kept.
		expect(r).toEqual({ kept: ['a', 'c'], none: null });
		const code = await withUser(applicant.id, (db) => db.query(`SELECT app_share_kept('[]'::jsonb, '[]'::jsonb, '{}')`)).then(
			() => 'ran',
			(e: { code?: string }) => e.code
		);
		expect(code).toBe('42501');
	});
});
