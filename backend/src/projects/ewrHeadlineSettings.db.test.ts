// Which EWR test the results are judged by (settings.ewrHeadline, issue #444;
// projects/ewrHeadlineSettings.ts): who reads and writes it (project RLS:
// every member reads the row, an editor updates it), validation through the
// API, the site check against the network and the rule tables, that it is no
// model input (saving it alone leaves updatedAt alone, a run doesn't record
// it), and that it travels with a copy and through the project document.
import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

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

/** Outlet gauge ← upper gauge ← farm, and a lower gauge with no table; synthetic rule tables at the outlet and the upper gauge; enough to run. */
async function project(u: User) {
	const projectId = (await u.call('POST', '/projects', { name: 'Judge by' })).body.project.id as string;
	const outlet = node('Outlet', null);
	const upper = node('Upper gauge', outlet.id, { kind: 'gauge' });
	const lower = node('Lower gauge', outlet.id, { kind: 'gauge' });
	const farm = node('Farm', upper.id);
	const crop = { id: crypto.randomUUID(), name: 'Lucerne', cropFactor: monthly(0.8) };
	const model = { nodes: [outlet, upper, lower, farm], crops: [crop], cropAreas: [{ nodeId: farm.id, cropId: crop.id, areaM2: 10_000 }], transfers: [] };
	expect((await u.call('PUT', `/projects/${projectId}/model`, model)).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${projectId}`, { settings: { apanMm: monthly(150), ewrRules: [table(null), table(upper.id)] } })).status).toBe(200);
	const rain = Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? 10 : 0));
	expect((await u.call('PUT', `/projects/${projectId}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2020-01-01', values: rain })).status).toBe(200);
	return { projectId, outlet, upper, lower, farm };
}
const judge = (ewrHeadline: unknown) => ({ settings: { ewrHeadline } });

describe('settings.ewrHeadline', () => {
	it('an editor chooses it, a viewer reads it but cannot change it, a non-member sees nothing', async () => {
		const owner = await signUp('JudgeOwner');
		const editor = await signUp('JudgeEditor');
		const viewer = await signUp('JudgeViewer');
		const stranger = await signUp('JudgeStranger');
		const c = await project(owner);
		for (const [u, role] of [
			[editor, 'editor'],
			[viewer, 'viewer']
		] as const) {
			expect((await owner.call('POST', `/projects/${c.projectId}/members`, { email: u.email, role })).status).toBe(201);
		}
		// Automatic, from the start (a stored document has none).
		expect((await viewer.call('GET', `/projects/${c.projectId}`)).body.project.settings.ewrHeadline).toEqual({ source: 'auto' });

		const set = await editor.call('PATCH', `/projects/${c.projectId}`, judge({ source: 'pragmatic' }));
		expect(set.status, JSON.stringify(set.body)).toBe(200);
		expect(set.body.project.settings.ewrHeadline).toEqual({ source: 'pragmatic' });
		// Positive control: the viewer reads the editor's choice.
		expect((await viewer.call('GET', `/projects/${c.projectId}`)).body.project.settings.ewrHeadline).toEqual({ source: 'pragmatic' });
		expect((await viewer.call('PATCH', `/projects/${c.projectId}`, judge({ source: 'auto' }))).status).toBe(403);
		expect((await stranger.call('GET', `/projects/${c.projectId}`)).status).toBe(404);
		expect((await stranger.call('PATCH', `/projects/${c.projectId}`, judge({ source: 'auto' }))).status).toBe(404);

		// A rule-table site replaces the choice whole, and back to automatic leaves no site behind.
		const gauge = await editor.call('PATCH', `/projects/${c.projectId}`, judge({ source: 'ruleTable', siteNodeId: c.upper.id }));
		expect(gauge.body.project.settings.ewrHeadline).toEqual({ source: 'ruleTable', siteNodeId: c.upper.id });
		const auto = await editor.call('PATCH', `/projects/${c.projectId}`, judge({ source: 'auto' }));
		expect(auto.body.project.settings.ewrHeadline).toEqual({ source: 'auto' });
	});

	it('refuses a shape that is no choice, and stores nothing', async () => {
		const u = await signUp('JudgeShape');
		const c = await project(u);
		for (const bad of [{ source: 'best' }, { source: 'pragmatic', siteNodeId: null }, { source: 'ruleTable' }, { source: 'ruleTable', siteNodeId: 'not-a-uuid' }, 'pragmatic']) {
			expect((await u.call('PATCH', `/projects/${c.projectId}`, judge(bad))).status, JSON.stringify(bad)).toBe(400);
		}
		expect((await u.call('GET', `/projects/${c.projectId}`)).body.project.settings.ewrHeadline).toEqual({ source: 'auto' });
	});

	it('takes the outlet or a gauge with a rule table; refuses a farm, the outlet node, a gauge with no table and a node of another project', async () => {
		const u = await signUp('JudgeSites');
		const c = await project(u);
		const other = await project(u);
		expect((await u.call('PATCH', `/projects/${c.projectId}`, judge({ source: 'ruleTable', siteNodeId: null }))).status).toBe(200);
		for (const [id, why] of [
			[c.farm.id, 'the site is the outlet (null) or a gauge above it'],
			[c.outlet.id, 'the site is the outlet (null) or a gauge above it'],
			[c.lower.id, 'that gauge has no Reserve rule table'],
			[other.upper.id, 'no such hydrological unit in this project']
		] as const) {
			const res = await u.call('PATCH', `/projects/${c.projectId}`, judge({ source: 'ruleTable', siteNodeId: id }));
			expect(res.status, why).toBe(400);
			expect(res.body.error).toBe(`ewrHeadline.siteNodeId: ${why}`);
		}
		expect((await u.call('GET', `/projects/${c.projectId}`)).body.project.settings.ewrHeadline).toEqual({ source: 'ruleTable', siteNodeId: null });
	});

	it('refuses the outlet without an outlet table, counts the tables saved with it, and a stored choice outlives its table', async () => {
		const u = await signUp('JudgeOutlet');
		const c = await project(u);
		expect((await u.call('PATCH', `/projects/${c.projectId}`, { settings: { ewrRules: [table(c.upper.id)] } })).status).toBe(200);
		const none = await u.call('PATCH', `/projects/${c.projectId}`, judge({ source: 'ruleTable', siteNodeId: null }));
		expect(none.status).toBe(400);
		expect(none.body.error).toBe('ewrHeadline.siteNodeId: the outlet has no Reserve rule table');
		// The outlet's table keyed by the outlet node counts, saved in the same patch.
		const both = await u.call('PATCH', `/projects/${c.projectId}`, { settings: { ewrRules: [table(c.outlet.id), table(c.upper.id)], ewrHeadline: { source: 'ruleTable', siteNodeId: null } } });
		expect(both.status, JSON.stringify(both.body)).toBe(200);
		// Removing the table keeps the choice (the screens fall back to automatic and say so) ...
		const removed = await u.call('PATCH', `/projects/${c.projectId}`, { settings: { ewrRules: [table(c.upper.id)] } });
		expect(removed.status).toBe(200);
		expect(removed.body.project.settings.ewrHeadline).toEqual({ source: 'ruleTable', siteNodeId: null });
		// ... and the Settings form, which sends every setting with the stored choice, still saves.
		const whole = await u.call('PATCH', `/projects/${c.projectId}`, { settings: { ...removed.body.project.settings, februaryDays: 28 } });
		expect(whole.status, JSON.stringify(whole.body)).toBe(200);
	});

	it('is no model input: updatedAt stays and a run does not record it', async () => {
		const u = await signUp('JudgeInput');
		const c = await project(u);
		const before = (await u.call('GET', `/projects/${c.projectId}`)).body.project;
		// The Settings form sends every setting: the whole document with only the choice changed.
		const res = await u.call('PATCH', `/projects/${c.projectId}`, { settings: { ...before.settings, ewrHeadline: { source: 'pragmatic' } } });
		expect(res.status, JSON.stringify(res.body)).toBe(200);
		expect(res.body.project.updatedAt).toBe(before.updatedAt);

		const run = await u.call('POST', `/projects/${c.projectId}/runs`, { label: 'r' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		const stored = (await u.call('GET', `/projects/${c.projectId}/runs/${run.body.run.id}`)).body.run;
		expect(stored.settings).not.toHaveProperty('ewrHeadline');
		// Positive control: the run did record the model's settings.
		expect(stored.settings.ewrRules).toHaveLength(2);

		// Positive control on updatedAt: a model input does move it.
		const input = await u.call('PATCH', `/projects/${c.projectId}`, { settings: { februaryDays: 28 } });
		expect(input.body.project.updatedAt > before.updatedAt).toBe(true);
	});

	it('travels with a copy (its site following its node) and through the project document', async () => {
		const u = await signUp('JudgeCopy');
		const c = await project(u);
		expect((await u.call('PATCH', `/projects/${c.projectId}`, judge({ source: 'ruleTable', siteNodeId: c.upper.id }))).status).toBe(200);
		const copy = await u.call('POST', `/projects/${c.projectId}/copy`, { name: 'Judge copy' });
		expect(copy.status).toBe(201);
		const copied = copy.body.project.settings;
		const upperRule = copied.ewrRules.find((t: { siteNodeId: string | null }) => t.siteNodeId !== null);
		expect(upperRule.siteNodeId).not.toBe(c.upper.id);
		expect(copied.ewrHeadline).toEqual({ source: 'ruleTable', siteNodeId: upperRule.siteNodeId });
		const doc = await u.call('GET', `/projects/${c.projectId}/export.json`);
		const imported = await u.call('POST', '/projects/import', doc.body);
		expect(imported.status).toBe(201);
		const importedRule = imported.body.project.settings.ewrRules.find((t: { siteNodeId: string | null }) => t.siteNodeId !== null);
		expect(imported.body.project.settings.ewrHeadline).toEqual({ source: 'ruleTable', siteNodeId: importedRule.siteNodeId });
	});
});
