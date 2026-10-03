// The outcome matrix's project settings (settings.outcomes, issue #53 R4;
// projects/outcomeSettings.ts): who reads and writes them (project RLS:
// every member reads the row, an editor updates it), validation through the
// API, and that they are no model input: saving them alone leaves updatedAt
// alone, and a run doesn't record them. The matrix's Reserve site
// (outcomes.siteNodeId) is checked against the network and the rule tables.
import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

const custom = { reserveMonthsMet: { lower: 0.95, increasing: 0.8 }, daysBelowEwr: { lower: 0.1, increasing: 0.3 } };
const DEFAULTS = { yearClassMethod: 'auto', riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: null }, siteNodeId: null };

async function runnable(u: User) {
	const projectId = (await u.call('POST', '/projects', { name: 'Outcomes' })).body.project.id as string;
	const outlet = node('Outlet', null);
	const farm = node('Upper', outlet.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150) } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	return projectId;
}

describe('settings.outcomes', () => {
	it('an editor sets them, a viewer reads them but cannot change them, a non-member sees nothing', async () => {
		const owner = await signUp('OutOwner');
		const editor = await signUp('OutEditor');
		const viewer = await signUp('OutViewer');
		const stranger = await signUp('OutStranger');
		const pid = await runnable(owner);
		for (const [u, role] of [
			[editor, 'editor'],
			[viewer, 'viewer']
		] as const) {
			expect((await owner.call('POST', `/projects/${pid}/members`, { email: u.email, role })).status).toBe(201);
		}
		// Every field, from the start (an older stored document has none).
		expect((await viewer.call('GET', `/projects/${pid}`)).body.project.settings.outcomes).toEqual(DEFAULTS);

		const outcomes = { yearClassMethod: 'terciles', riskCutoffs: custom, siteNodeId: null };
		const set = await editor.call('PATCH', `/projects/${pid}`, { settings: { outcomes } });
		expect(set.status).toBe(200);
		expect(set.body.project.settings.outcomes).toEqual(outcomes);
		// Positive control: the viewer reads the editor's choice.
		expect((await viewer.call('GET', `/projects/${pid}`)).body.project.settings.outcomes).toEqual(outcomes);

		expect((await viewer.call('PATCH', `/projects/${pid}`, { settings: { outcomes: { yearClassMethod: 'quintiles' } } })).status).toBe(403);
		expect((await stranger.call('GET', `/projects/${pid}`)).status).toBe(404);
		expect((await stranger.call('PATCH', `/projects/${pid}`, { settings: { outcomes: { yearClassMethod: 'quintiles' } } })).status).toBe(404);
		expect((await owner.call('GET', `/projects/${pid}`)).body.project.settings.outcomes).toEqual(outcomes);
	});

	it('refuses cut-offs the engine refuses, in its words, and stores nothing', async () => {
		const u = await signUp('OutBad');
		const pid = await runnable(u);
		const bad = await u.call('PATCH', `/projects/${pid}`, {
			settings: { outcomes: { riskCutoffs: { reserveMonthsMet: { lower: 0.6, increasing: 0.9 }, daysBelowEwr: null } } }
		});
		expect(bad.status).toBe(400);
		expect(JSON.stringify(bad.body)).toContain('reserveMonthsMet cut-offs must be shares with lower ≥ increasing');
		expect((await u.call('PATCH', `/projects/${pid}`, { settings: { outcomes: { yearClassMethod: 'deciles' } } })).status).toBe(400);
		expect((await u.call('GET', `/projects/${pid}`)).body.project.settings.outcomes).toEqual(DEFAULTS);
	});

	it('is no model input: updatedAt stays, a run does not record it, and changing it back to defaults works', async () => {
		const u = await signUp('OutInput');
		const pid = await runnable(u);
		const before = (await u.call('GET', `/projects/${pid}`)).body.project;
		// The Settings form sends every setting: the whole document with only outcomes changed.
		const res = await u.call('PATCH', `/projects/${pid}`, { settings: { ...before.settings, outcomes: { yearClassMethod: 'quintiles', riskCutoffs: custom } } });
		expect(res.status).toBe(200);
		expect(res.body.project.updatedAt).toBe(before.updatedAt);

		const run = await u.call('POST', `/projects/${pid}/runs`, { label: 'r' });
		expect(run.status).toBe(201);
		const stored = (await u.call('GET', `/projects/${pid}/runs/${run.body.run.id}`)).body.run;
		expect(stored.settings).not.toHaveProperty('outcomes');
		expect(stored.settings).not.toHaveProperty('autoRun');

		// Positive control on updatedAt: a model input does move it.
		const input = await u.call('PATCH', `/projects/${pid}`, { settings: { februaryDays: 28 } });
		expect(input.body.project.updatedAt > before.updatedAt).toBe(true);

		const reset = await u.call('PATCH', `/projects/${pid}`, { settings: { outcomes: { yearClassMethod: 'auto', riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: null }, siteNodeId: null } } });
		expect(reset.body.project.settings.outcomes).toEqual(DEFAULTS);
	});

	it('travels with a copy and through the project document', async () => {
		const u = await signUp('OutCopy');
		const pid = await runnable(u);
		const outcomes = { yearClassMethod: 'quintiles', riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: custom.daysBelowEwr }, siteNodeId: null };
		expect((await u.call('PATCH', `/projects/${pid}`, { settings: { outcomes } })).status).toBe(200);
		const copy = await u.call('POST', `/projects/${pid}/copy`, { name: 'Outcomes copy' });
		expect(copy.body.project.settings.outcomes).toEqual(outcomes);
		const doc = await u.call('GET', `/projects/${pid}/export.json`);
		const imported = await u.call('POST', '/projects/import', doc.body);
		expect(imported.status).toBe(201);
		expect(imported.body.project.settings.outcomes).toEqual(outcomes);
	});

	describe('the Reserve site (outcomes.siteNodeId)', () => {
		/** Outlet gauge ← upper gauge ← farm, and a lower gauge with no table; a synthetic rule table at the upper gauge. */
		async function twoGauges(u: User) {
			const projectId = (await u.call('POST', '/projects', { name: 'Outcome sites' })).body.project.id as string;
			const outlet = node('Outlet', null);
			const upper = node('Upper gauge', outlet.id, { kind: 'gauge' });
			const lower = node('Lower gauge', outlet.id, { kind: 'gauge' });
			const farm = node('Farm', upper.id);
			expect((await u.call('PUT', `/projects/${projectId}/model`, { nodes: [outlet, upper, lower, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
			const table = (siteNodeId: string | null) => ({
				siteNodeId,
				source: 'Synthetic table',
				component: 'total',
				unit: 'mcm',
				points: [10, 50, 90],
				ewr: Array.from({ length: 12 }, () => [1.5, 1, 0.5]),
				naturalSource: 'run',
				natural: null,
				scale: 1
			});
			expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { ewrRules: [table(null), table(upper.id)] } })).status).toBe(200);
			return { projectId, outlet, upper, lower, farm, table };
		}
		const site = (siteNodeId: string | null) => ({ settings: { outcomes: { siteNodeId } } });

		it('refuses a rule table for "the outlet" beside one keyed by the outlet node, and keeps what was stored (engine ≥ 1.69.0)', async () => {
			const u = await signUp('OutOutletTwice');
			const c = await twoGauges(u);
			const twice = await u.call('PATCH', `/projects/${c.projectId}`, { settings: { ewrRules: [c.table(null), c.table(c.outlet.id)] } });
			expect(twice.status).toBe(400);
			expect(JSON.stringify(twice.body)).toContain('two Reserve rule tables for the outlet');
			// Positive control: the outlet keyed by its own id alone saves.
			expect((await u.call('PATCH', `/projects/${c.projectId}`, { settings: { ewrRules: [c.table(c.outlet.id), c.table(c.upper.id)] } })).status).toBe(200);
		});

		it('an editor picks a gauge with a rule table; a viewer reads it but cannot change it; a non-member sees nothing', async () => {
			const owner = await signUp('SiteOwner');
			const editor = await signUp('SiteEditor');
			const viewer = await signUp('SiteViewer');
			const stranger = await signUp('SiteStranger');
			const c = await twoGauges(owner);
			for (const [u, role] of [
				[editor, 'editor'],
				[viewer, 'viewer']
			] as const) {
				expect((await owner.call('POST', `/projects/${c.projectId}/members`, { email: u.email, role })).status).toBe(201);
			}
			const set = await editor.call('PATCH', `/projects/${c.projectId}`, site(c.upper.id));
			expect(set.status, JSON.stringify(set.body)).toBe(200);
			expect(set.body.project.settings.outcomes).toEqual({ ...DEFAULTS, siteNodeId: c.upper.id });
			// Positive control: the viewer reads the editor's choice.
			expect((await viewer.call('GET', `/projects/${c.projectId}`)).body.project.settings.outcomes.siteNodeId).toBe(c.upper.id);
			expect((await viewer.call('PATCH', `/projects/${c.projectId}`, site(null))).status).toBe(403);
			expect((await stranger.call('GET', `/projects/${c.projectId}`)).status).toBe(404);
			expect((await stranger.call('PATCH', `/projects/${c.projectId}`, site(null))).status).toBe(404);
			// Back to the outlet.
			expect((await editor.call('PATCH', `/projects/${c.projectId}`, site(null))).body.project.settings.outcomes.siteNodeId).toBeNull();
		});

		it('refuses a farm, the outlet node, a gauge with no table and a node of another project, and stores nothing', async () => {
			const u = await signUp('SiteBad');
			const c = await twoGauges(u);
			const other = await twoGauges(u);
			for (const [id, why] of [
				[c.farm.id, 'the site is the outlet (null) or a gauge above it'],
				[c.outlet.id, 'the site is the outlet (null) or a gauge above it'],
				[c.lower.id, 'that gauge has no Reserve rule table'],
				[other.upper.id, 'no such node in this project'],
				[crypto.randomUUID(), 'no such node in this project']
			] as const) {
				const res = await u.call('PATCH', `/projects/${c.projectId}`, site(id));
				expect(res.status, why).toBe(400);
				expect(res.body.error).toBe(`outcomes.siteNodeId: ${why}`);
			}
			expect((await u.call('GET', `/projects/${c.projectId}`)).body.project.settings.outcomes).toEqual(DEFAULTS);
		});

		it('counts the rule tables being saved with it, and a stored site outlives its table without blocking other saves', async () => {
			const u = await signUp('SiteTables');
			const c = await twoGauges(u);
			// A table for the lower gauge in the same patch makes it eligible.
			const both = await u.call('PATCH', `/projects/${c.projectId}`, {
				settings: { ewrRules: [c.table(null), c.table(c.upper.id), c.table(c.lower.id)], outcomes: { siteNodeId: c.lower.id } }
			});
			expect(both.status, JSON.stringify(both.body)).toBe(200);
			expect(both.body.project.settings.outcomes.siteNodeId).toBe(c.lower.id);
			// Removing that table keeps the stored site (the Runs tab says it has no table any more) ...
			const removed = await u.call('PATCH', `/projects/${c.projectId}`, { settings: { ewrRules: [c.table(null)] } });
			expect(removed.status).toBe(200);
			expect(removed.body.project.settings.outcomes.siteNodeId).toBe(c.lower.id);
			// ... and the Settings form, which sends every setting with the stored site, still saves.
			const whole = await u.call('PATCH', `/projects/${c.projectId}`, { settings: { ...removed.body.project.settings, februaryDays: 28 } });
			expect(whole.status, JSON.stringify(whole.body)).toBe(200);
			// Choosing it anew is checked: it has no table now.
			expect((await u.call('PATCH', `/projects/${c.projectId}`, site(c.upper.id))).status).toBe(400);
		});

		it('follows its gauge into a copy', async () => {
			const u = await signUp('SiteCopy');
			const c = await twoGauges(u);
			expect((await u.call('PATCH', `/projects/${c.projectId}`, site(c.upper.id))).status).toBe(200);
			const copy = await u.call('POST', `/projects/${c.projectId}/copy`, { name: 'Outcome sites copy' });
			expect(copy.status).toBe(201);
			const nodes = (await u.call('GET', `/projects/${copy.body.project.id}/model`)).body.nodes as { id: string; name: string }[];
			const gauge = nodes.find((n) => n.name === 'Upper gauge')!;
			expect(gauge.id).not.toBe(c.upper.id);
			expect(copy.body.project.settings.outcomes.siteNodeId).toBe(gauge.id);
		});
	});
});
