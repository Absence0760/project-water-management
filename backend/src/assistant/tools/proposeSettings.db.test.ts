// propose_settings against Postgres (issues #610, #640): it runs as the
// signed-in member inside a read-only withUser transaction, as every
// assistant tool does. A patch the save would refuse (by its schema or by a
// check that reads the project, such as the calibration site's record) is
// never returned; a valid one comes back as a proposal the save then accepts;
// an outcome's management change comes back as scenario ops on the run that
// POST /scenarios accepts; and nothing is stored either way. Synthetic values
// only.
import { describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../../__tests__/helpers.js';
import { withUser } from '../../db/tx.js';
import type { ToolResult } from '../types.js';
import { proposeSettings } from './proposeSettings.js';

type User = Awaited<ReturnType<typeof signUp>>;

/** Outlet ← a gauge with no flow record ← a farm with a dam. */
async function project(u: User) {
	const id = (await u.call('POST', '/projects', { name: 'Assistant proposals' })).body.project.id as string;
	const outlet = node('Outlet', null);
	const gauge = node('Bare weir', outlet.id, { kind: 'gauge', areaKm2: 0 });
	const farm = node('Farm', gauge.id);
	expect((await u.call('PUT', `/projects/${id}/model`, { nodes: [outlet, gauge, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150), lakeEvapFactor: 0.7 } })).status).toBe(200);
	return { id, gauge, farm };
}

const propose = (u: User, projectId: string, args: unknown, runId: string | null = null): Promise<ToolResult> =>
	withUser(u.id, (db) => proposeSettings({ db, userId: u.id, projectId, runId }, args), { readOnly: true });

/** The stored settings, model and how many revisions and scenarios the project has: what a proposal must leave alone. */
async function stored(projectId: string) {
	const rows = await asOwner(
		`SELECT p.settings, p.updated_at, (SELECT count(*)::int FROM model_revision r WHERE r.project_id = p.id) AS revisions,
		        (SELECT count(*)::int FROM scenario s WHERE s.project_id = p.id) AS scenarios FROM project p WHERE p.id = $1`,
		[projectId]
	);
	return rows[0] as { settings: unknown; updated_at: Date; revisions: number; scenarios: number };
}

describe('propose_settings', () => {
	it('returns a valid recalibration as a proposal the save accepts, for a viewer, and stores nothing', async () => {
		const owner = await signUp('ProposeOwner');
		const viewer = await signUp('ProposeViewer');
		const p = await project(owner);
		expect((await owner.call('POST', `/projects/${p.id}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		const before = await stored(p.id);

		const r = await propose(viewer, p.id, {
			goal: 'recalibration',
			changes: [
				{ key: 'lakeEvapFactor', value: 0.85, reason: 'Summer dam levels fall faster in the record than in the run.' },
				{ key: 'gr4j.x1', value: 410, reason: 'Peaks are too high.' }
			]
		});
		expect(r.ok, JSON.stringify(r)).toBe(true);
		if (!r.ok || r.proposal?.apply.kind !== 'settings') throw new Error('no settings proposal');
		const patch = r.proposal.apply.patch;
		expect(patch).toEqual({ lakeEvapFactor: 0.85, gr4j: { x1: 410 } });
		expect(r.proposal.changes[0]).toEqual({
			label: 'Dam evaporation factor (× A-pan)',
			lines: ['Dam evaporation factor (× A-pan): 0.7 → 0.85'],
			reason: 'Summer dam levels fall faster in the record than in the run.'
		});

		// Nothing stored: not the settings, not a revision, not the inputs' date.
		expect(await stored(p.id)).toEqual(before);

		// The viewer can't save it (Apply is an editor's); the owner's save of the same patch is accepted.
		expect((await viewer.call('PATCH', `/projects/${p.id}`, { settings: patch })).status).toBe(403);
		const saved = await owner.call('PATCH', `/projects/${p.id}`, { settings: patch, reason: `Assistant suggestion: ${r.proposal.title}` });
		expect(saved.status, JSON.stringify(saved.body)).toBe(200);
		expect(saved.body.project.settings).toMatchObject({ lakeEvapFactor: 0.85, gr4j: { x1: 410 } });
	});

	it('never returns a patch the save refuses, by its schema or by a check that reads the project', async () => {
		const owner = await signUp('ProposeRefused');
		const p = await project(owner);
		const before = await stored(p.id);
		const refused = async (args: { goal: string; changes: { key: string; value: unknown; reason: string }[] }, why: string) => {
			const r = await propose(owner, p.id, args);
			expect(r.ok, JSON.stringify(r)).toBe(false);
			expect('proposal' in r).toBe(false);
			if (!r.ok) expect(r.error).toContain(why);
			// The save refuses the same patch.
			const patch = Object.fromEntries(args.changes.map((c) => [c.key, c.value]));
			expect((await owner.call('PATCH', `/projects/${p.id}`, { settings: patch })).status).toBeGreaterThanOrEqual(400);
		};
		await refused({ goal: 'recalibration', changes: [{ key: 'lakeEvapFactor', value: 5, reason: 'r' }] }, 'lakeEvapFactor');
		// The allocation mode is management: an outcome's, as a scenario; the baseline save refuses it too.
		await refused({ goal: 'correction', changes: [{ key: 'allocationMode', value: 'cap', reason: 'r' }] }, 'a management setting');
		// A gauge with no flow record can't be the calibration site (projects/calibrationSite.ts reads the records).
		await refused({ goal: 'recalibration', changes: [{ key: 'calibrationSiteNodeId', value: p.gauge.id, reason: 'r' }] }, 'no observed flow record');
		expect(await stored(p.id)).toEqual(before);
	});

	it('makes an outcome’s management change scenario ops on the run, which POST /scenarios accepts; stores nothing itself (issue #640)', async () => {
		const owner = await signUp('ProposeOutcome');
		const p = await project(owner);
		const rain = Array.from({ length: 120 }, (_, i) => (i % 7 === 0 ? 12 : 0));
		expect((await owner.call('PUT', `/projects/${p.id}/series`, { kind: 'rain_catchment_mm', unit: 'mm', startDate: '2021-10-01', values: rain })).status).toBe(200);
		const run = await owner.call('POST', `/projects/${p.id}/runs`, { label: 'Base' });
		expect(run.status, JSON.stringify(run.body)).toBe(201);
		const runId = run.body.run.id as string;
		const before = await stored(p.id);

		// The incident's move (a calibrated parameter for an outcome) is refused; the management lever is not.
		const x1 = await propose(owner, p.id, { goal: 'outcome', changes: [{ key: 'gr4j.x1', value: 1200, reason: 'r' }] }, runId);
		expect(x1.ok).toBe(false);
		const r = await propose(owner, p.id, { goal: 'outcome', changes: [{ node: 'Farm', field: 'pctRunoffToDam', value: 0.25, reason: 'Less captured in dry years.' }] }, runId);
		if (!r.ok || r.proposal?.apply.kind !== 'scenario') throw new Error(`no scenario proposal: ${JSON.stringify(r)}`);
		expect(r.proposal.apply).toEqual({ kind: 'scenario', baseRunId: runId, ops: [{ op: 'node.set', nodeId: p.farm.id, field: 'pctRunoffToDam', value: 0.25 }] });
		expect(r.proposal.title).toBe('Management change: Farm: own runoff to dam');
		expect(await stored(p.id)).toEqual(before);

		const made = await owner.call('POST', `/projects/${p.id}/scenarios`, { name: `Assistant: ${r.proposal.title}`, baseRunId: runId, ops: r.proposal.apply.ops });
		expect(made.status, JSON.stringify(made.body)).toBe(201);
		expect(made.body.check.problems).toEqual([]);
	});

	it('sees only a project the member can see (RLS)', async () => {
		const owner = await signUp('ProposeRlsOwner');
		const stranger = await signUp('ProposeRlsStranger');
		const p = await project(owner);
		const args = { goal: 'correction', changes: [{ key: 'lakeEvapFactor', value: 0.9, reason: 'r' }] };
		// Positive control: the owner gets a proposal.
		expect((await propose(owner, p.id, args)).ok).toBe(true);
		expect(await propose(stranger, p.id, args)).toEqual({ ok: false, error: 'the project is not visible' });
		// The outcome path reads the run as the caller too: a stranger gets a refusal, never the run.
		const outcome = await propose(stranger, p.id, { goal: 'outcome', changes: [{ node: 'Farm', field: 'pctRunoffToDam', value: 0.25, reason: 'r' }] });
		expect(outcome.ok).toBe(false);
	});
});
