// The outcome matrix's project settings (settings.outcomes, issue #53 R4;
// projects/outcomeSettings.ts): who reads and writes them (project RLS:
// every member reads the row, an editor updates it), validation through the
// API, and that they are no model input: saving them alone leaves updatedAt
// alone, and a run doesn't record them.
import { describe, expect, it } from 'vitest';
import { monthly, node, signUp } from '../__tests__/helpers.js';

type User = Awaited<ReturnType<typeof signUp>>;

const custom = { reserveMonthsMet: { lower: 0.95, increasing: 0.8 }, daysBelowEwr: { lower: 0.1, increasing: 0.3 } };
const DEFAULTS = { yearClassMethod: 'auto', riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: null } };

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

		const outcomes = { yearClassMethod: 'terciles', riskCutoffs: custom };
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

		const reset = await u.call('PATCH', `/projects/${pid}`, { settings: { outcomes: { yearClassMethod: 'auto', riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: null } } } });
		expect(reset.body.project.settings.outcomes).toEqual(DEFAULTS);
	});

	it('travels with a copy and through the project document', async () => {
		const u = await signUp('OutCopy');
		const pid = await runnable(u);
		const outcomes = { yearClassMethod: 'quintiles', riskCutoffs: { reserveMonthsMet: null, daysBelowEwr: custom.daysBelowEwr } };
		expect((await u.call('PATCH', `/projects/${pid}`, { settings: { outcomes } })).status).toBe(200);
		const copy = await u.call('POST', `/projects/${pid}/copy`, { name: 'Outcomes copy' });
		expect(copy.body.project.settings.outcomes).toEqual(outcomes);
		const doc = await u.call('GET', `/projects/${pid}/export.json`);
		const imported = await u.call('POST', '/projects/import', doc.body);
		expect(imported.status).toBe(201);
		expect(imported.body.project.settings.outcomes).toEqual(outcomes);
	});
});
