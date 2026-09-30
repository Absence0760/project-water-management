// What an applicant (the contributor role, WP-3.3) must not be able to learn
// by probing (049_applicant_oracles; docs/security.md § Applicants,
// docs/followups.md § Applicants "Oracles"): whether an address or a user is
// a member of the project, whether a hidden farm or crop has a given name,
// whether a hidden application has a given name, and whether a hidden
// transfer, land-cover patch, borehole or crop has a given id, or what a
// hidden farm carries. Each probe is answered
// identically for the hidden case and the free one; each has its positive
// control (an owner or editor, who may know, still gets the real answer).
import { beforeAll, describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';
import { withUser } from '../db/tx.js';

type User = Awaited<ReturnType<typeof signUp>>;

let owner: User;
let assessor: User; // editor
let applicantA: User; // contributor, linked to Rooikloof, party "Rooikloof Trust"
let consultantA: User; // contributor, party "Rooikloof Trust"
let applicantB: User; // contributor, party "Bergvliet Boerdery"
let consultantB: User; // contributor, party "Bergvliet Boerdery"
let loner: User; // contributor, no party
let farmer: User;
let stranger: User; // not a member
let projectId: string;
let published: string;

const outlet = node('Gauge', null);
const rooikloof = node('Rooikloof', outlet.id);
const kalkoenkrans = node('Kalkoenkrans', outlet.id);
const bergvliet = node('Bergvliet', outlet.id);
const citrus = { id: crypto.randomUUID(), name: 'Citrus', cropFactor: monthly(0.7) };
const lucerne = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.9) };

// Hidden from applicantA (on neighbours' farms): a transfer, a land-cover patch and a borehole.
const T_HIDDEN = crypto.randomUUID();
const LC_HIDDEN = crypto.randomUUID();
const BH_HIDDEN = crypto.randomUUID();
const DO_HIDDEN = crypto.randomUUID();

const P = () => `/projects/${projectId}`;
const rename = (value: string) => ({ op: 'node.set', nodeId: rooikloof.id, field: 'name', value });
const NEW_CROP = crypto.randomUUID();
const addCrop = (name: string) => ({ op: 'crop.add', crop: { id: NEW_CROP, name, cropFactor: monthly(0.5) } });

async function application(u: User, name: string, ops: unknown[] = []) {
	const res = await u.call('POST', `${P()}/scenarios`, { name, baseRunId: published, ops });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body as { scenario: { id: string }; check: Record<string, unknown> };
}

beforeAll(async () => {
	[owner, assessor, applicantA, consultantA, applicantB, consultantB, loner, farmer, stranger] = (await Promise.all(
		['Oowner', 'Oassessor', 'Oapplicanta', 'Oconsultanta', 'Oapplicantb', 'Oconsultantb', 'Oloner', 'Ofarmer', 'Ostranger'].map((n) => signUp(n))
	)) as [User, User, User, User, User, User, User, User, User];
	projectId = (await owner.call('POST', '/projects', { name: 'Oracles' })).body.project.id;
	const model = {
		nodes: [outlet, rooikloof, kalkoenkrans, bergvliet],
		crops: [citrus, lucerne],
		cropAreas: [
			{ nodeId: rooikloof.id, cropId: citrus.id, areaM2: 50_000 },
			{ nodeId: kalkoenkrans.id, cropId: lucerne.id, areaM2: 30_000 }
		],
		transfers: [{ id: T_HIDDEN, fromNodeId: kalkoenkrans.id, toNodeId: bergvliet.id, months: [1], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0 }],
		landCover: [{ id: LC_HIDDEN, nodeId: kalkoenkrans.id, coverClass: 'pine', areaKm2: 1, densityPct: 0.5, factors: null }],
		boreholes: [{ id: BH_HIDDEN, nodeId: bergvliet.id, name: 'Bergvliet BH', capacityM3Day: 100, annualCapM3: null }],
		demandObjects: [{ id: DO_HIDDEN, nodeId: bergvliet.id, name: 'Bergvliet village', category: 'municipal', sizing: 'monthly', monthlyM3Day: monthly(50) }]
	};
	const put = await owner.call('PUT', `${P()}/model`, model);
	expect(put.status, JSON.stringify(put.body)).toBe(200);
	expect((await owner.call('PATCH', P(), { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 20 : 0));
	expect((await owner.call('PUT', `${P()}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	const run = await owner.call('POST', `${P()}/runs`, { label: 'Baseline' });
	expect(run.status, JSON.stringify(run.body)).toBe(201);
	published = run.body.run.id;
	expect((await owner.call('POST', `${P()}/publication`, { runId: published })).status).toBe(201);
	for (const [u, role] of [
		[assessor, 'editor'],
		[applicantA, 'contributor'],
		[consultantA, 'contributor'],
		[applicantB, 'contributor'],
		[consultantB, 'contributor'],
		[loner, 'contributor']
	] as const) {
		expect((await owner.call('POST', `${P()}/members`, { email: u.email, role })).status, u.email).toBe(201);
	}
	expect((await owner.call('POST', `${P()}/farmers`, { email: farmer.email, nodeIds: [kalkoenkrans.id] })).status).toBe(201);
	expect((await owner.call('PUT', `${P()}/farmers/${applicantA.id}`, { nodeIds: [rooikloof.id] })).status).toBe(200);
	for (const [u, party] of [
		[applicantA, 'Rooikloof Trust'],
		[consultantA, 'Rooikloof Trust'],
		[applicantB, 'Bergvliet Boerdery'],
		[consultantB, 'Bergvliet Boerdery']
	] as const) {
		expect((await owner.call('PATCH', `${P()}/members/${u.id}`, { party })).body.member.party).toBe(party);
	}
});

describe('sharing an application', () => {
	let sid: string;

	beforeAll(async () => {
		sid = (await application(applicantA, 'Share probe')).scenario.id;
	});

	it('lists each applicant only their own party (curated by the owner), and nobody for one without a party', async () => {
		const candidates = async (u: User, s: string) => (await u.call('GET', `${P()}/scenarios/${s}/share-candidates`)).body.candidates;
		expect(await candidates(applicantA, sid)).toEqual([{ userId: consultantA.id, displayName: 'Oconsultanta' }]);
		const theirs = (await application(applicantB, 'B share probe')).scenario.id;
		expect(await candidates(applicantB, theirs)).toEqual([{ userId: consultantB.id, displayName: 'Oconsultantb' }]);
		const lonely = (await application(loner, 'Loner probe')).scenario.id;
		expect(await candidates(loner, lonely)).toEqual([]);
		// Names only: no address in the list.
		expect(JSON.stringify(await candidates(applicantA, sid))).not.toContain('@');
	});

	it('answers every id outside the party identically: a member, a farmer, a stranger or nobody', async () => {
		const probes = [applicantB.id, consultantB.id, loner.id, assessor.id, owner.id, farmer.id, stranger.id, crypto.randomUUID()];
		const answers = await Promise.all(probes.map((u) => applicantA.call('POST', `${P()}/scenarios/${sid}/members`, { userId: u })));
		for (const a of answers) expect(a).toEqual({ status: 404, body: { error: 'not someone you can share this application with' } });
		// Positive control: the one candidate is shared with.
		expect((await applicantA.call('POST', `${P()}/scenarios/${sid}/members`, { userId: consultantA.id })).status).toBe(201);
	});

	it('refuses an applicant every address the same way, member or not', async () => {
		const probes = [consultantA.email, applicantB.email, assessor.email, owner.email, stranger.email, 'nobody@example.com'];
		const answers = await Promise.all(probes.map((email) => applicantA.call('POST', `${P()}/scenarios/${sid}/members`, { email })));
		const first = answers[0]!;
		expect(first.status).toBe(403);
		for (const a of answers) expect(a).toEqual(first);
	});

	it('holds the rule in the table too (scenario_member_check), with its positive control', async () => {
		await expect(
			withUser(applicantA.id, (db) => db.query('INSERT INTO scenario_member (scenario_id, project_id, user_id) VALUES ($1, $2, $3)', [sid, projectId, consultantB.id]))
		).rejects.toMatchObject({ code: '23514' });
		// consultantA was added above, through the same trigger.
		expect((await applicantA.call('GET', `${P()}/scenarios/${sid}`)).body.scenario.members).toEqual([{ userId: consultantA.id, displayName: 'Oconsultanta' }]);
	});

	it('ends shares when the owner moves someone out of the party, and matches parties ignoring case', async () => {
		expect((await consultantA.call('GET', `${P()}/scenarios/${sid}`)).status).toBe(200);
		expect((await owner.call('PATCH', `${P()}/members/${consultantA.id}`, { party: 'Elsewhere' })).status).toBe(200);
		expect((await consultantA.call('GET', `${P()}/scenarios/${sid}`)).status).toBe(404);
		expect((await applicantA.call('GET', `${P()}/scenarios/${sid}`)).body.scenario.members).toEqual([]);
		expect((await applicantA.call('GET', `${P()}/scenarios/${sid}/share-candidates`)).body.candidates).toEqual([]);
		// Back in (another case): a candidate again; the share itself is not restored.
		const back = await owner.call('PATCH', `${P()}/members/${consultantA.id}`, { party: 'rooikloof trust' });
		expect(back.body.member.party).toBe('rooikloof trust');
		expect((await applicantA.call('GET', `${P()}/scenarios/${sid}/share-candidates`)).body.candidates).toEqual([{ userId: consultantA.id, displayName: 'Oconsultanta' }]);
		expect((await consultantA.call('GET', `${P()}/scenarios/${sid}`)).status).toBe(404);
		// Only the owner sets a party; a contributor can't put themselves in one.
		expect((await applicantB.call('PATCH', `${P()}/members/${applicantB.id}`, { party: 'Rooikloof Trust' })).status).toBe(403);
		expect((await assessor.call('PATCH', `${P()}/members/${applicantB.id}`, { party: 'Rooikloof Trust' })).status).toBe(403);
		// '' clears it; a party of spaces is no party.
		expect((await owner.call('PATCH', `${P()}/members/${loner.id}`, { party: '   ' })).body.member.party).toBeNull();
	});

	it('keeps email sharing for an application owner who is a viewer or above (positive control)', async () => {
		const promoted = await signUp('Opromoted');
		expect((await owner.call('POST', `${P()}/members`, { email: promoted.email, role: 'contributor' })).status).toBe(201);
		const theirs = (await application(promoted, 'Promoted probe')).scenario.id;
		expect((await owner.call('PATCH', `${P()}/members/${promoted.id}`, { role: 'viewer' })).status).toBe(200);
		// They read the member list anyway: every contributor or above is a candidate.
		const ids = (await promoted.call('GET', `${P()}/scenarios/${theirs}/share-candidates`)).body.candidates.map((c: { userId: string }) => c.userId);
		expect(ids).toEqual(expect.arrayContaining([applicantB.id, loner.id, assessor.id]));
		expect(ids).not.toContain(farmer.id);
		expect((await promoted.call('POST', `${P()}/scenarios/${theirs}/members`, { email: applicantB.email })).status).toBe(201);
		expect((await promoted.call('POST', `${P()}/scenarios/${theirs}/members`, { email: 'nobody@example.com' })).body).toEqual({
			error: 'no contributor or above on this project has that address'
		});
	});
});

describe('renaming their own farm (or naming a crop) in an application', () => {
	const HIDDEN = 'KALKOENKRANS';
	const FREE = 'Nowhere Farm';

	it('answers a hidden neighbour’s name exactly as a free one, in the check and in the run', async () => {
		const hidden = await application(applicantA, 'Rename hidden', [rename(HIDDEN), addCrop('lucerne')]);
		const free = await application(applicantA, 'Rename free', [rename(FREE), addCrop('Pecans')]);
		const norm = (check: unknown, name: string, crop: string) => JSON.stringify(check).replaceAll(name, 'NAME').replaceAll(crop, 'CROP');
		expect(norm(hidden.check, HIDDEN, 'lucerne')).toBe(norm(free.check, FREE, 'Pecans'));
		expect(hidden.check).toMatchObject({ problems: [] });
		expect(hidden.check).not.toHaveProperty('renamed');
		for (const s of [hidden, free]) {
			const run = await applicantA.call('POST', `${P()}/scenarios/${s.scenario.id}/runs`, {});
			expect(run.status, JSON.stringify(run.body)).toBe(201);
			expect(run.body).not.toHaveProperty('renamed');
		}
		// The assessor, once it is submitted, sees what was renamed to make room.
		expect((await applicantA.call('POST', `${P()}/scenarios/${hidden.scenario.id}/submit`)).status).toBe(200);
		const seen = await assessor.call('GET', `${P()}/scenarios/${hidden.scenario.id}`);
		expect(seen.body.check.renamed).toEqual([
			{ kind: 'node', id: kalkoenkrans.id, name: 'Kalkoenkrans', as: 'Kalkoenkrans (2)' },
			{ kind: 'crop', id: lucerne.id, name: 'Lucerne', as: 'Lucerne (2)' }
		]);
		expect(seen.body.check.problems).toEqual([]);
	});

	it('still collides with the names the applicant can see', async () => {
		const res = await application(applicantA, 'Rename seen', [rename('farm 1'), addCrop('CITRUS')]);
		expect(res.check.problems).toEqual(['op 1 (node.set): duplicate node name "farm 1"', 'op 2 (crop.add): duplicate crop name "citrus"']);
	});

	it('keeps the duplicate-name problem for the team’s own scenarios (positive control)', async () => {
		const res = await owner.call('POST', `${P()}/scenarios`, { name: 'Team rename', baseRunId: published, ops: [rename(HIDDEN), addCrop('lucerne')] });
		expect(res.status).toBe(201);
		expect(res.body.check.problems).toEqual(['op 1 (node.set): duplicate node name "kalkoenkrans"', 'op 2 (crop.add): duplicate crop name "lucerne"']);
		expect(res.body.check.renamed).toEqual([]);
	});
});

describe('naming an application', () => {
	it('answers a hidden application’s or team scenario’s name as a free one', async () => {
		await application(applicantB, 'Raise the Bergvliet dam');
		expect((await owner.call('POST', `${P()}/scenarios`, { name: 'Team plan', baseRunId: published })).status).toBe(201);
		for (const name of ['Raise the Bergvliet dam', 'team PLAN', 'Something new']) {
			const res = await applicantA.call('POST', `${P()}/scenarios`, { name, baseRunId: published });
			expect(res.status, name).toBe(201);
		}
	});

	it('keeps a name unique among the applicant’s own applications and among team scenarios (positive controls)', async () => {
		expect(await applicantA.call('POST', `${P()}/scenarios`, { name: ' something NEW ', baseRunId: published })).toEqual({
			status: 409,
			body: { error: 'you already have an application with that name' }
		});
		expect(await owner.call('POST', `${P()}/scenarios`, { name: 'TEAM plan', baseRunId: published })).toEqual({
			status: 409,
			body: { error: 'this project already has a scenario with that name' }
		});
	});
});

describe('ids and counts of what the applicant can’t see', () => {
	const FREE = crypto.randomUUID();
	/** The check as the applicant gets it, the probed id written as ID. */
	const told = (body: unknown, id: string) => JSON.stringify(body).replaceAll(id, 'ID');
	let n = 0;
	const probe = (ops: unknown[]) => application(applicantA, `Id probe ${++n}`, ops);

	const targeting: [string, (id: string) => unknown][] = [
		[T_HIDDEN, (id) => ({ op: 'transfer.remove', transferId: id })],
		[LC_HIDDEN, (id) => ({ op: 'landCover.remove', patchId: id })],
		[BH_HIDDEN, (id) => ({ op: 'borehole.remove', boreholeId: id })],
		[DO_HIDDEN, (id) => ({ op: 'demandObject.remove', demandObjectId: id })],
		[DO_HIDDEN, (id) => ({ op: 'demandObject.set', demandObjectId: id, field: 'returnPct', value: 0.1 })],
		[lucerne.id, (id) => ({ op: 'cropArea.set', nodeId: rooikloof.id, cropId: id, areaM2: 10 })]
	];

	it('answers an op on a hidden item’s id exactly as on a free one, in the check and when run', async () => {
		for (const [hidden, op] of targeting) {
			const h = await probe([op(hidden)]);
			const f = await probe([op(FREE)]);
			expect(h.check.problems).toEqual([expect.stringMatching(/not found$/)]);
			expect(told(h.check, hidden)).toBe(told(f.check, FREE));
			const runs = await Promise.all([h, f].map((s) => applicantA.call('POST', `${P()}/scenarios/${s.scenario.id}/runs`, {})));
			expect(runs[0]!.status).toBe(422);
			expect(told(runs[0], hidden)).toBe(told(runs[1], FREE));
		}
	});

	it('applies an item added under a hidden id exactly as under a free one, and moves it to a fresh id the assessor sees', async () => {
		const add = (id: string) => ({ op: 'transfer.add', transfer: { id, fromNodeId: rooikloof.id, toNodeId: kalkoenkrans.id, months: [2], maxRateM3s: 0.02, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 1 } });
		const h = await probe([add(T_HIDDEN)]);
		const f = await probe([add(FREE)]);
		expect(h.check.problems).toEqual([]);
		expect(told(h.check, T_HIDDEN)).toBe(told(f.check, FREE));
		expect(h.check).not.toHaveProperty('reIds');
		const runs = await Promise.all([h, f].map((s) => applicantA.call('POST', `${P()}/scenarios/${s.scenario.id}/runs`, {})));
		for (const r of runs) {
			expect(r.status, JSON.stringify(r.body)).toBe(201);
			expect(r.body).not.toHaveProperty('reIds');
		}
		expect(told({ ...runs[0]!.body, run: undefined, removedRunIds: undefined }, T_HIDDEN)).toBe(told({ ...runs[1]!.body, run: undefined, removedRunIds: undefined }, FREE));
		// The assessor, once it is submitted, sees the move.
		expect((await applicantA.call('POST', `${P()}/scenarios/${h.scenario.id}/submit`)).status).toBe(200);
		const seen = await assessor.call('GET', `${P()}/scenarios/${h.scenario.id}`);
		expect(seen.body.check.reIds).toEqual([{ kind: 'transfer', id: T_HIDDEN, as: `${T_HIDDEN}-2` }]);
		// Positive control: a team scenario meets the hidden transfer.
		const team = await owner.call('POST', `${P()}/scenarios`, { name: 'Team id probe', baseRunId: published, ops: [add(T_HIDDEN), targeting[0]![1](T_HIDDEN)] });
		expect(team.body.check.problems).toEqual([`op 1 (transfer.add): transfer id ${T_HIDDEN} is already in use`]);
		expect(team.body.check.applied.map((a: { index: number }) => a.index)).toEqual([1]);
		expect(team.body.check.reIds).toEqual([]);
	});

	it('counts nothing a hidden farm carries when an application removes it', async () => {
		// Kalkoenkrans carries a crop area, a transfer and land cover; Bergvliet the transfer's other end, a borehole and a demand object.
		const k = await probe([{ op: 'node.remove', nodeId: kalkoenkrans.id }]);
		const b = await probe([{ op: 'node.remove', nodeId: bergvliet.id }]);
		expect(k.check.applied).toEqual([{ index: 0, op: { op: 'node.remove', nodeId: kalkoenkrans.id }, notes: [] }]);
		expect(b.check.applied).toEqual([{ index: 0, op: { op: 'node.remove', nodeId: bergvliet.id }, notes: [] }]);
		// Positive control: the team's scenario counts what it drops.
		const team = await owner.call('POST', `${P()}/scenarios`, { name: 'Team remove probe', baseRunId: published, ops: [{ op: 'node.remove', nodeId: kalkoenkrans.id }] });
		expect(team.body.check.applied[0].notes).toEqual(['dropped 1 crop area(s)', 'dropped 1 transfer(s)', 'dropped 1 land-cover patch(es)']);
	});
});
