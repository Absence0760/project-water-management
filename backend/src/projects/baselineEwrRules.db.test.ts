// In the baseline the EWR is assessed and reported, never applied (issue
// #523 B4, projects/ewrRules.ts): the rules that keep water for it (a
// pass-inflow release without amounts, a unit's or an off-take's
// handsOffEwr, the drought restriction's ewrTrigger) are a scenario's.
//   - PUT …/model and PATCH /projects/:id refuse one (400
//     ewr_rule_scenario_only), and accept the set flows beside them
//     (positive controls);
//   - a project file, a copy and a restore bring them in switched off, the
//     revision saying so;
//   - the input a baseline run reads drops any the store still holds, so it
//     is the same with or without them.
// Synthetic data only.
import { beforeAll, describe, expect, it } from 'vitest';
import { app, asOwner, monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;
const ORIGIN = 'http://localhost:7777';
const NOTE = /rules? keeping the EWR switched off \(.*\): in the baseline the EWR is assessed and reported, never applied; a scenario keeps it/;
const RESTRICTION = { reviewDates: ['10-01'], levels: [{ belowPct: 0.4, cuts: { crops: 0.2 } }] };
const TRIGGER = { siteNodeId: null, level: 1 };

let owner: User;

beforeAll(async () => {
	owner = await signUp('Ewrbase');
});

/** A fresh two-farm model: Farm A (a dam) above Farm B above the outlet gauge, and a river off-take A → B. */
function model() {
	const outlet = node('Outlet gauge', null);
	const b = node('Farm B', outlet.id);
	const a = node('Farm A', b.id);
	const offtake = { id: crypto.randomUUID(), fromNodeId: a.id, toNodeId: b.id, months: [1, 2, 3], maxRateM3s: 0.01, dailyCapM3: null, minStoragePct: 0, enabled: true, priority: 0, source: 'river' };
	return { nodes: [outlet, b, a], crops: [], cropAreas: [], transfers: [offtake] as Record<string, unknown>[], a, b, offtake };
}
const doc = (m: ReturnType<typeof model>) => ({ nodes: m.nodes, crops: m.crops, cropAreas: m.cropAreas, transfers: m.transfers });

async function importDoc(settings: Record<string, unknown>, m = model()): Promise<string> {
	const res = await app.request('/projects/import', {
		method: 'POST',
		headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: owner.cookie },
		body: JSON.stringify({ name: `Imported ${crypto.randomUUID().slice(0, 8)}`, settings: { apanMm: monthly(150), ...settings }, model: doc(m), series: [] })
	});
	const body = (await res.json()) as { project: { id: string } };
	expect(res.status, JSON.stringify(body)).toBe(201);
	return body.project.id;
}

const revisions = async (id: string) =>
	(await owner.call('GET', `/projects/${id}/history?kind=revision`)).body.items as { id: string; source: string; reason: string | null }[];
/** The stored rules, read as the schema owner: what the project holds, not what a run reads. */
async function stored(id: string) {
	const nodes = await asOwner(`SELECT name, dam_release_rule AS rule, dam_release_m3_day AS release, hands_off_ewr AS ewr FROM node WHERE project_id = $1 ORDER BY name`, [id]);
	const transfers = await asOwner(`SELECT hands_off_ewr AS ewr FROM transfer WHERE project_id = $1`, [id]);
	const { settings } = ((await asOwner('SELECT settings FROM project WHERE id = $1', [id])) as { settings: { droughtRestriction?: unknown } }[])[0]!;
	return { nodes, transfers, restriction: settings.droughtRestriction };
}
/** Switch every rule on behind the API's back, as a project stored before 220 would hold them. */
async function storeRules(id: string) {
	await asOwner(`UPDATE node SET dam_release_rule = 'passInflow', dam_release_m3_day = NULL WHERE project_id = $1 AND name = 'Farm A'`, [id]);
	await asOwner(`UPDATE node SET hands_off_ewr = true WHERE project_id = $1 AND name = 'Farm B'`, [id]);
	await asOwner(`UPDATE transfer SET hands_off_ewr = true WHERE project_id = $1`, [id]);
	await asOwner(`UPDATE project SET settings = settings || jsonb_build_object('droughtRestriction', $2::jsonb) WHERE id = $1`, [id, JSON.stringify({ ...RESTRICTION, ewrTrigger: TRIGGER })]);
}

describe('a save can’t switch on a rule that keeps the EWR (issue #523 B4)', () => {
	it('PUT …/model refuses each of the three model rules, naming it and the scenario op', async () => {
		const id = await importDoc({});
		const cases: [string, (m: ReturnType<typeof model>) => void, RegExp][] = [
			['pass inflow without amounts', (m) => Object.assign(m.a, { damReleaseRule: 'passInflow', damReleaseM3Day: null }), /^unit "Farm A": dam release: pass inflow keeps the EWR.*node\.set damReleaseRule passInflow/],
			['a unit’s hands-off EWR', (m) => Object.assign(m.b, { handsOffEwr: true }), /^unit "Farm B": hands-off flow at a unit keeps the EWR.*node\.set handsOffEwr true/],
			['an off-take’s hands-off EWR', (m) => Object.assign(m.offtake, { handsOffEwr: true }), /^transfer "Farm A → Farm B": hands-off flow at a river off-take keeps the EWR.*transfer\.set handsOffEwr true/]
		];
		for (const [what, on, line] of cases) {
			const m = model();
			on(m);
			const res = await owner.call('PUT', `/projects/${id}/model`, doc(m));
			expect(res.status, what).toBe(400);
			expect(res.body.code, what).toBe('ewr_rule_scenario_only');
			expect(res.body.error, what).toMatch(/run only in a scenario: in the baseline the EWR is assessed and reported, never applied/);
			expect(res.body.details, what).toHaveLength(1);
			expect(res.body.details[0], what).toMatch(line);
		}
		// Nothing was saved.
		expect((await stored(id)).nodes.every((n: { ewr: boolean; rule: string }) => !n.ewr && n.rule === 'none')).toBe(true);
	});

	it('positive control: the set flows beside them save (pass inflow with amounts, hands-off flows by month)', async () => {
		const id = await importDoc({});
		const m = model();
		Object.assign(m.a, { damReleaseRule: 'passInflow', damReleaseM3Day: monthly(25) });
		Object.assign(m.b, { handsOffM3Day: monthly(10) });
		Object.assign(m.offtake, { handsOffM3Day: 40 });
		const res = await owner.call('PUT', `/projects/${id}/model`, doc(m));
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect((await stored(id)).nodes.find((n: { name: string }) => n.name === 'Farm A')).toMatchObject({ rule: 'passInflow', release: monthly(25) });
	});

	it('PATCH /projects/:id refuses a drought restriction with an EWR trigger, and saves one without (positive control)', async () => {
		const id = await importDoc({});
		const refused = await owner.call('PATCH', `/projects/${id}`, { settings: { droughtRestriction: { ...RESTRICTION, ewrTrigger: TRIGGER } } });
		expect(refused.status).toBe(400);
		expect(refused.body.code).toBe('ewr_rule_scenario_only');
		expect(refused.body.details).toEqual([expect.stringMatching(/^drought restriction rule: drought restriction triggered by an EWR failure keeps the EWR.*settings\.set droughtRestriction/)]);
		expect((await stored(id)).restriction).toBeUndefined();
		const saved = await owner.call('PATCH', `/projects/${id}`, { settings: { droughtRestriction: RESTRICTION } });
		expect(saved.status, JSON.stringify(saved.body)).toBe(200);
		expect((await stored(id)).restriction).toEqual(RESTRICTION);
		// A patch that doesn't touch the rule isn't refused for it.
		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { lakeEvapFactor: 0.7 } })).status).toBe(200);
	});
});

describe('rules from outside a save come in switched off, and the revision says so (issue #523 B4)', () => {
	const allOff = {
		nodes: [
			{ name: 'Farm A', rule: 'none', release: null, ewr: false },
			{ name: 'Farm B', rule: 'none', release: null, ewr: false },
			{ name: 'Outlet gauge', rule: 'none', release: null, ewr: false }
		],
		transfers: [{ ewr: false }],
		restriction: RESTRICTION
	};

	it('a project file with all four imports without them', async () => {
		const m = model();
		Object.assign(m.a, { damReleaseRule: 'passInflow', damReleaseM3Day: null });
		Object.assign(m.b, { handsOffEwr: true });
		Object.assign(m.offtake, { handsOffEwr: true });
		const id = await importDoc({ droughtRestriction: { ...RESTRICTION, ewrTrigger: TRIGGER } }, m);
		expect(await stored(id)).toEqual(allOff);
		const [rev] = await revisions(id);
		expect(rev!.source).toBe('import');
		expect(rev!.reason).toMatch(/^4 rules keeping the EWR switched off/);
		expect(rev!.reason).toMatch(NOTE);
	});

	it('positive control: a file without them imports with no note', async () => {
		const id = await importDoc({ droughtRestriction: RESTRICTION });
		expect(await stored(id)).toEqual(allOff);
		expect((await revisions(id))[0]!.reason).toBeNull();
	});

	it('a copy of a project stored with them (before 220) comes without them', async () => {
		const id = await importDoc({});
		await storeRules(id);
		const copy = await owner.call('POST', `/projects/${id}/copy`, { name: 'The copy' });
		expect(copy.status, JSON.stringify(copy.body)).toBe(201);
		expect(await stored(copy.body.project.id)).toEqual(allOff);
		const [rev] = await revisions(copy.body.project.id);
		expect(rev!.reason).toMatch(/^Copied from "Imported [^"]+"\. 4 rules keeping the EWR switched off/);
	});

	it('restoring a revision that kept the EWR restores it without them', async () => {
		const id = await importDoc({});
		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { lakeEvapFactor: 0.6 } })).status).toBe(200);
		const [target] = await revisions(id);
		// A revision recorded before 220, when the baseline could keep the EWR.
		await asOwner(`UPDATE model_revision SET snapshot = jsonb_set(snapshot, '{settings,droughtRestriction}', $2::jsonb) WHERE id = $1`, [
			target!.id,
			JSON.stringify({ ...RESTRICTION, ewrTrigger: TRIGGER })
		]);
		await asOwner(
			`UPDATE model_revision SET snapshot = jsonb_set(snapshot, '{model,nodes}', (SELECT jsonb_agg(CASE WHEN n ->> 'name' = 'Farm B' THEN n || '{"handsOffEwr": true}' ELSE n END) FROM jsonb_array_elements(snapshot -> 'model' -> 'nodes') n)) WHERE id = $1`,
			[target!.id]
		);
		expect((await owner.call('PATCH', `/projects/${id}`, { settings: { lakeEvapFactor: 0.8 } })).status).toBe(200);
		const res = await owner.call('POST', `/projects/${id}/history/revisions/${target!.id}/restore`, { reason: 'Back to 0.6' });
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		const s = await stored(id);
		expect(s.nodes.find((n: { name: string }) => n.name === 'Farm B')).toMatchObject({ ewr: false });
		expect(s.restriction).toEqual(RESTRICTION);
		expect(res.body.revision.reason).toMatch(/^Back to 0\.6\. 2 rules keeping the EWR switched off/);
	});
});

describe('the input a baseline run reads never keeps the EWR (issue #523 B4)', () => {
	it('is the same with and without the rules stored', async () => {
		const id = await importDoc({ droughtRestriction: RESTRICTION });
		const without = (await owner.call('GET', `/projects/${id}/model-input`)).body.input;
		await storeRules(id);
		// Positive control: the store does hold them now.
		const s = await stored(id);
		expect(s.transfers).toEqual([{ ewr: true }]);
		expect((s.restriction as { ewrTrigger?: unknown }).ewrTrigger).toEqual(TRIGGER);
		const withThem = (await owner.call('GET', `/projects/${id}/model-input`)).body.input;
		expect(withThem).toEqual(without);
	});
});
