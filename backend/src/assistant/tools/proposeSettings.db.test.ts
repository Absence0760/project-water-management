// propose_settings against Postgres (issue #610): it runs as the signed-in
// member inside a read-only withUser transaction, as every assistant tool
// does. A patch the save would refuse (by its schema or by a check that
// reads the project, such as the calibration site's record) is never
// returned; a valid one comes back as a proposal the save then accepts; and
// nothing is stored either way. Synthetic values only.
import { describe, expect, it } from 'vitest';
import { asOwner, monthly, node, signUp } from '../../__tests__/helpers.js';
import { withUser } from '../../db/tx.js';
import type { ToolResult } from '../types.js';
import { proposeSettings } from './proposeSettings.js';

type User = Awaited<ReturnType<typeof signUp>>;

/** Outlet ← a gauge with no flow record ← a farm. */
async function project(u: User) {
	const id = (await u.call('POST', '/projects', { name: 'Assistant proposals' })).body.project.id as string;
	const outlet = node('Outlet', null);
	const gauge = node('Bare weir', outlet.id, { kind: 'gauge', areaKm2: 0 });
	const farm = node('Farm', gauge.id);
	expect((await u.call('PUT', `/projects/${id}/model`, { nodes: [outlet, gauge, farm], crops: [], cropAreas: [], transfers: [] })).status).toBe(200);
	expect((await u.call('PATCH', `/projects/${id}`, { settings: { apanMm: monthly(150), lakeEvapFactor: 0.7 } })).status).toBe(200);
	return { id, gauge };
}

const propose = (u: User, projectId: string, args: unknown): Promise<ToolResult> =>
	withUser(u.id, (db) => proposeSettings({ db, userId: u.id, projectId, runId: null }, args), { readOnly: true });

/** The stored settings and how many revisions the project has: what a proposal must leave alone. */
async function stored(projectId: string) {
	const rows = await asOwner(
		`SELECT p.settings, p.updated_at, (SELECT count(*)::int FROM model_revision r WHERE r.project_id = p.id) AS revisions FROM project p WHERE p.id = $1`,
		[projectId]
	);
	return rows[0] as { settings: unknown; updated_at: Date; revisions: number };
}

describe('propose_settings', () => {
	it('returns a valid change as a proposal the save accepts, for a viewer, and stores nothing', async () => {
		const owner = await signUp('ProposeOwner');
		const viewer = await signUp('ProposeViewer');
		const p = await project(owner);
		expect((await owner.call('POST', `/projects/${p.id}/members`, { email: viewer.email, role: 'viewer' })).status).toBe(201);
		const before = await stored(p.id);

		const r = await propose(viewer, p.id, {
			changes: [
				{ key: 'lakeEvapFactor', value: 0.85, reason: 'Summer dam levels fall faster in the record than in the run.' },
				{ key: 'gr4j.x1', value: 410, reason: 'Peaks are too high.' }
			],
			summary: 'Raise dam evaporation and the production store'
		});
		expect(r.ok, JSON.stringify(r)).toBe(true);
		if (!r.ok) return;
		expect(r.proposal!.patch).toEqual({ lakeEvapFactor: 0.85, gr4j: { x1: 410 } });
		expect(r.proposal!.diff).toContainEqual({ label: 'Dam evaporation factor (× A-pan)', before: '0.7', after: '0.85' });

		// Nothing stored: not the settings, not a revision, not the inputs' date.
		expect(await stored(p.id)).toEqual(before);

		// The viewer can't save it (Apply is an editor's); the owner's save of the same patch is accepted.
		expect((await viewer.call('PATCH', `/projects/${p.id}`, { settings: r.proposal!.patch })).status).toBe(403);
		const saved = await owner.call('PATCH', `/projects/${p.id}`, { settings: r.proposal!.patch, reason: `Assistant suggestion: ${r.proposal!.summary}` });
		expect(saved.status, JSON.stringify(saved.body)).toBe(200);
		expect(saved.body.project.settings).toMatchObject({ lakeEvapFactor: 0.85, gr4j: { x1: 410 } });
	});

	it('never returns a patch the save refuses, by its schema or by a check that reads the project', async () => {
		const owner = await signUp('ProposeRefused');
		const p = await project(owner);
		const before = await stored(p.id);
		const refused = async (args: unknown, why: string) => {
			const r = await propose(owner, p.id, args);
			expect(r.ok, JSON.stringify(r)).toBe(false);
			expect('proposal' in r).toBe(false);
			if (!r.ok) expect(r.error).toContain(why);
			// The save refuses the same patch.
			const patch = Object.fromEntries((args as { changes: { key: string; value: unknown }[] }).changes.map((c) => [c.key, c.value]));
			expect((await owner.call('PATCH', `/projects/${p.id}`, { settings: patch })).status).toBeGreaterThanOrEqual(400);
		};
		await refused({ changes: [{ key: 'lakeEvapFactor', value: 5, reason: 'r' }], summary: 's' }, 'lakeEvapFactor');
		await refused({ changes: [{ key: 'allocationMode', value: 'cap', reason: 'r' }], summary: 's' }, 'registered volumes');
		// A gauge with no flow record can't be the calibration site (projects/calibrationSite.ts reads the records).
		await refused({ changes: [{ key: 'calibrationSiteNodeId', value: p.gauge.id, reason: 'r' }], summary: 's' }, 'no observed flow record');
		expect(await stored(p.id)).toEqual(before);
	});

	it('sees only a project the member can see (RLS)', async () => {
		const owner = await signUp('ProposeRlsOwner');
		const stranger = await signUp('ProposeRlsStranger');
		const p = await project(owner);
		const args = { changes: [{ key: 'lakeEvapFactor', value: 0.9, reason: 'r' }], summary: 's' };
		// Positive control: the owner gets a proposal.
		expect((await propose(owner, p.id, args)).ok).toBe(true);
		expect(await propose(stranger, p.id, args)).toEqual({ ok: false, error: 'the project is not visible' });
	});
});
