// The audit workbook's fetching (./collect.ts): the run, then the catchment's
// and the farm's series through the bulk route, then the engine's plan; a
// farm it can't recompute is an error that says why.
import { describe, expect, it } from 'vitest';
import type { ModelInput, ModelOutput } from '@water-management/engine';
import { DownloadError } from '$lib/export/download';
import type { ExportProgress } from '../export/collect';
import { collectAudit } from './collect';
import { auditFixture } from './fixture';

const P = 'p1';
const R = 'r1';
const fx = auditFixture();

function fakeFetch(input: ModelInput, out: ModelOutput) {
	const calls: string[] = [];
	const fn = (async (url: RequestInfo | URL) => {
		calls.push(String(url));
		const u = new URL(String(url));
		if (u.pathname === `/projects/${P}/runs/${R}`)
			return Response.json({ run: { label: 'Baseline', engineVersion: out.engineVersion, summary: out.summary, settings: input.settings, model: input.model }, series: [] });
		if (u.pathname === `/projects/${P}/runs/${R}/series/bulk`) {
			const nodeId = u.searchParams.get('nodeId');
			const series = out.series.filter((s) => s.nodeId === nodeId);
			return Response.json({
				nodeId,
				name: nodeId ?? 'catchment',
				kind: nodeId ? 'farm' : 'catchment',
				startDate: out.startDate,
				days: out.days,
				offset: 0,
				count: out.days,
				next: null,
				// As the API sends them: NaN is JSON null.
				series: series.map((s) => ({ key: s.key, label: s.label, unit: s.unit, header: s.label, values: s.values.map((v) => (Number.isFinite(v) ? v : null)) }))
			});
		}
		return new Response('not found', { status: 404 });
	}) as typeof fetch;
	return { fn, calls };
}

describe('collectAudit', () => {
	it('fetches the run, the catchment and the farm, and plans the same audit as the engine', async () => {
		const { fn, calls } = fakeFetch(fx.input, fx.out);
		const progress: ExportProgress[] = [];
		const got = await collectAudit({ apiBase: 'http://api.test', projectId: P, runId: R, auditNodeId: fx.nodeId }, fn, (p) => progress.push(p));
		expect(calls.map((c) => new URL(c).search)).toEqual(['', '', `?nodeId=${fx.nodeId}`]);
		expect(got.plan.columns.map((c) => c.key)).toEqual(fx.plan.columns.map((c) => c.key));
		expect(got.plan.params).toEqual(fx.plan.params);
		expect(got.run).toEqual({ label: 'Baseline', engineVersion: fx.out.engineVersion });
		expect(got.filename).toMatch(/^baseline_.+_audit\.xlsx$/);
		expect(progress.map((p) => p.phase)).toEqual(['fetch', 'fetch', 'build']);
	});

	it("says why it can't recompute a farm", async () => {
		const input = structuredClone(fx.input);
		const n = input.model.nodes.find((x) => x.id === fx.nodeId)!;
		n.damReleaseRule = 'fixed';
		n.damReleaseM3Day = Array(12).fill(10);
		const { runModel } = await import('@water-management/engine');
		const { fn } = fakeFetch(input, runModel(input));
		const err = await collectAudit({ apiBase: 'http://api.test', projectId: P, runId: R, auditNodeId: fx.nodeId }, fn, () => {}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(DownloadError);
		expect((err as Error).message).toMatch(/can't recompute .+ yet: .*a dam release rule/);
	});
});
