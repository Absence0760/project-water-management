// The preview worker's computation (./compute.ts) and wiring
// (./engine.worker.ts): the preview's firm yield is the one the `yield` job
// works out (backend/src/jobs/handlers/yield.ts: applyScenario, prepareYield,
// firmYield on the same input), and the worker answers each message with its
// id. Also: only the worker imports compute.ts, so no page ships the engine's
// run code for it.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyScenario, compareRuns, firmYield, prepareYield, runModelWithoutChecks, SUPPLY_TARGET, type ModelInput, type ScenarioOp } from '@water-management/engine';
import { randomInput } from '@water-management/engine/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetBase, handle, parseMessage, previewEffect, previewYield } from './compute';
import type { FromWorker, ToWorker } from './messages';

/** A random catchment (engine fuzz) with a dam on a farm: the input and that farm's id. */
function withDam(): { input: ModelInput; nodeId: string } {
	for (let seed = 1; seed < 200; seed++) {
		const input = randomInput(seed, { maxNodes: 6, maxDays: 500 });
		const dam = input.model.nodes.find((n) => n.kind === 'farm' && n.damCapacityM3 > 0);
		if (!dam) continue;
		try {
			prepareYield(input);
		} catch {
			continue;
		}
		return { input, nodeId: dam.id };
	}
	throw new Error('no fuzz seed with a dam');
}

const opts = { pattern: 'constant' as const, assurance: 1, tolerance: 0.001 };

describe('previewYield', () => {
	it("is the job's firm yield on the same input, exactly", () => {
		const { input, nodeId } = withDam();
		const job = firmYield(prepareYield(input), nodeId, opts);
		expect(previewYield({ input, nodeId, ...opts })).toEqual(job);
	});

	it('at a lower assurance, too', () => {
		const { input, nodeId } = withDam();
		const o = { ...opts, assurance: 0.8 };
		expect(previewYield({ input, nodeId, ...o })).toEqual(firmYield(prepareYield(input), nodeId, o));
	});

	it("applies a scenario's ops first, as the job does", () => {
		const { input, nodeId } = withDam();
		const cap = input.model.nodes.find((n) => n.id === nodeId)!.damCapacityM3;
		const ops: ScenarioOp[] = [{ op: 'node.set', nodeId, field: 'damCapacityM3', value: cap * 2 }];
		const applied = applyScenario(input, ops);
		expect(applied.problems).toEqual([]);
		const job = firmYield(prepareYield(applied.input), nodeId, opts);
		const preview = previewYield({ input, ops, nodeId, ...opts });
		expect(preview).toEqual(job);
		expect(preview.capacityM3).toBe(cap * 2);
	});

	it("refuses a scenario whose op doesn't apply, as the job does", () => {
		const { input, nodeId } = withDam();
		const ops: ScenarioOp[] = [{ op: 'node.remove', nodeId: 'no-such-node' }];
		expect(() => previewYield({ input, ops, nodeId, ...opts })).toThrow(/doesn't apply to its base run/);
	});
});

describe('handle', () => {
	it('answers with the point and the request id', () => {
		const { input, nodeId } = withDam();
		const m = handle({ type: 'yield', id: 7, request: { input, nodeId, ...opts } });
		expect(m?.type).toBe('yield-done');
		expect(m?.id).toBe(7);
	});

	it("answers the engine's words, with the id, when it throws", () => {
		const { input } = withDam();
		const m = handle({ type: 'yield', id: 3, request: { input, nodeId: 'nope', ...opts } });
		expect(m).toEqual({ type: 'error', id: 3, message: expect.stringMatching(/not found/) });
	});
});

describe('parseMessage: the worker message is checked at the boundary', () => {
	const good = () => {
		const { input, nodeId } = withDam();
		return { type: 'yield', id: 5, request: { input, nodeId, ...opts } } as Record<string, unknown> & { request: Record<string, unknown> };
	};
	const refused = (data: unknown) => {
		const r = parseMessage(data);
		expect(r.ok).toBe(false);
		return r as { ok: false; id: number | null; message: string };
	};

	it('takes a well-formed request and rebuilds its ops from their allowlisted fields', () => {
		const m = good();
		const nodeId = m.request.nodeId as string;
		m.request.ops = [{ op: 'node.set', nodeId, field: 'damCapacityM3', value: 1000, extra: 'dropped' }];
		const r = parseMessage(m);
		expect(r.ok).toBe(true);
		expect(r.ok && r.msg.type).toBe('yield');
		if (r.ok && r.msg.type === 'yield') expect(r.msg.request.ops).toEqual([{ op: 'node.set', nodeId, field: 'damCapacityM3', value: 1000 }]);
	});

	it('ignores what is not a preview request (no id to answer)', () => {
		for (const d of [null, 'yield', [], { type: 'run', id: 1 }, { type: 'yield', id: 0 }, { type: 'yield', id: 1.5 }, { type: 'yield', id: '1' }]) {
			expect(refused(d).id).toBeNull();
		}
	});

	it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'no.such.op'])('refuses %s as an op name, field or path, with the request id', (name) => {
		for (const op of [
			{ op: name },
			{ op: 'node.set', nodeId: 'A', field: name, value: 1 },
			{ op: 'transfer.set', transferId: 't', field: name, value: 1 },
			{ op: 'settings.set', path: name, value: 1 }
		]) {
			const m = good();
			m.request.ops = [op];
			const r = refused(m);
			expect(r.id).toBe(5);
			expect(r.message).toMatch(/^the preview request is malformed: the scenario's ops: ops\[0\]\.(op|field|path): /);
		}
	});

	it('refuses an unknown key on the message or the request, including an own __proto__', () => {
		const m = good();
		expect(refused({ ...m, extra: 1 }).message).toMatch(/unknown message field/);
		expect(refused({ ...m, request: { ...m.request, runId: 'x' } }).message).toMatch(/unknown request field/);
		// JSON.parse keeps __proto__ as an own key, as a structured clone of such an object does.
		expect(refused({ ...m, request: { ...m.request, ...JSON.parse('{"__proto__": {"polluted": 1}}') } }).message).toMatch(/unknown request field/);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it('refuses parameters outside the ranges the yield job takes (backend YieldParams)', () => {
		const at = (patch: Record<string, unknown>) => {
			const m = good();
			return refused({ ...m, request: { ...m.request, ...patch } }).message;
		};
		expect(at({ assurance: 0.4 })).toMatch(/assurance/);
		expect(at({ assurance: Number.NaN })).toMatch(/assurance/);
		expect(at({ tolerance: 0.5 })).toMatch(/tolerance/);
		expect(at({ pattern: 'toString' })).toMatch(/pattern/);
		expect(at({ pattern: [1, 2, 3] })).toMatch(/pattern/);
		expect(at({ nodeId: 42 })).toMatch(/nodeId/);
		expect(at({ ops: 'all' })).toMatch(/ops: must be a list/);
	});

	it("refuses an input without the engine's outline", () => {
		const at = (input: unknown) => {
			const m = good();
			return refused({ ...m, request: { ...m.request, input } }).message;
		};
		expect(at(null)).toMatch(/run input/);
		expect(at({ settings: {}, model: { nodes: {} }, series: {} })).toMatch(/nodes must be a list/);
		const { input } = withDam();
		expect(at({ ...input, model: { ...input.model, nodes: [{ id: 'x', kind: 'constructor' }] } })).toMatch(/kind \(farm, gauge or user\)/);
	});

	it('handle answers a malformed request with an error carrying its id, and never runs the engine on it', () => {
		const m = good();
		m.request.ops = [{ op: 'transfer.set', transferId: 't', field: '__proto__', value: {} }];
		expect(handle(m)).toEqual({ type: 'error', id: 5, message: expect.stringMatching(/is not a transfer field a scenario can set/) });
		expect(handle({ type: 'run' })).toBeNull();
	});
});

/** A random catchment (engine fuzz) the model runs, with planted crops: the input, and it with every planted area tripled. */
function withCrops(): { base: ModelInput; edited: ModelInput } {
	for (let seed = 1; seed < 200; seed++) {
		const base = randomInput(seed, { maxNodes: 6, maxDays: 400 });
		if (!base.model.cropAreas.some((a) => a.areaM2 > 0)) continue;
		try {
			runModelWithoutChecks(base);
		} catch {
			continue;
		}
		const edited: ModelInput = JSON.parse(JSON.stringify(base));
		for (const a of edited.model.cropAreas) a.areaM2 *= 3;
		return { base, edited };
	}
	throw new Error('no fuzz seed with crops');
}

describe('previewEffect: what unsaved edits do to the last run (issue #284)', () => {
	afterEach(forgetBase);

	it("reads the two runs as compareRuns does, exactly (it keeps its own copy of compareRuns' sums)", () => {
		const { base, edited } = withCrops();
		const c = compareRuns(runModelWithoutChecks(base), runModelWithoutChecks(edited));
		const e = previewEffect({ baseKey: 'p/r', base, edited });
		expect(e.totals).toEqual(c.totals);
		expect(e.catchment).toEqual({ meanNaturalFlowM3Day: c.catchment.meanNaturalFlowM3Day, meanSimulatedOutflowM3Day: c.catchment.meanSimulatedOutflowM3Day, ewrDaysNotMet: c.catchment.ewrDaysNotMet });
		expect(e.calibration).toEqual(c.calibration ? { nse: c.calibration.nse, kge: c.calibration.kge, pbias: c.calibration.pbias } : null);
		// compute.ts counts units below 95 % supplied without importing the engine's constant.
		expect(SUPPLY_TARGET).toBe(0.95);
		expect(e.totals.demandM3Day.delta).toBeGreaterThan(0);
		// Every unit with a moved figure is listed, the largest change in supply first.
		const moved = c.farms.filter((f) => Math.abs(f.fractionSupplied.delta ?? 0) > 1e-9 || Math.abs(f.deficitM3Day.delta ?? 0) > 1e-6);
		expect(e.units.map((u) => u.name).sort()).toEqual(moved.map((f) => f.name).sort());
		const steps = e.units.map((u) => Math.abs(u.fractionSupplied.delta ?? 0));
		expect(steps).toEqual([...steps].sort((a, b) => b - a));
	});

	it('moves nothing when the edits change nothing', () => {
		const { base } = withCrops();
		const e = previewEffect({ baseKey: 'p/r', base, edited: JSON.parse(JSON.stringify(base)) });
		expect(e.totals.demandM3Day.delta).toBe(0);
		expect(e.units).toEqual([]);
		expect(e.addedUnits).toEqual([]);
		expect(e.removedUnits).toEqual([]);
	});

	it("runs the last run's input once for previews of the same run", () => {
		const { base, edited } = withCrops();
		const first = previewEffect({ baseKey: 'p/r', base, edited });
		// The same key: the kept output, not this (different) input's.
		const again = previewEffect({ baseKey: 'p/r', base: edited, edited });
		expect(again.totals.demandM3Day.a).toBe(first.totals.demandM3Day.a);
		// Another run: worked out afresh.
		expect(previewEffect({ baseKey: 'p/other', base: edited, edited }).totals.demandM3Day.delta).toBe(0);
	});

	it("words the engine's refusal of the edited input", () => {
		const { base } = withCrops();
		const edited: ModelInput = JSON.parse(JSON.stringify(base));
		edited.model.nodes[0]!.downstreamNodeId = 'no-such-node';
		expect(() => previewEffect({ baseKey: 'p/r', base, edited })).toThrow(/^the model can't run with these edits: /);
	});

	it('handle answers an effect request with its id', () => {
		const { base, edited } = withCrops();
		const m = handle({ type: 'effect', id: 9, request: { baseKey: 'p/r', base, edited } });
		expect(m?.type).toBe('effect-done');
		expect(m?.id).toBe(9);
	});

	it('parseMessage refuses a malformed effect request, with its id', () => {
		const { base, edited } = withCrops();
		const bad = (request: unknown) => {
			const r = parseMessage({ type: 'effect', id: 2, request });
			expect(r.ok).toBe(false);
			return (r as { id: number; message: string }).message;
		};
		expect(bad({ baseKey: 'k', base, edited, input: base })).toMatch(/unknown request field/);
		expect(bad({ baseKey: '', base, edited })).toMatch(/baseKey/);
		expect(bad({ baseKey: 'k', base: null, edited })).toMatch(/base must be a run input/);
		expect(bad({ baseKey: 'k', base, edited: { ...edited, model: { ...edited.model, crops: 1 } } })).toMatch(/edited\.model\.crops must be a list/);
	});
});

describe('engine.worker', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	async function load() {
		const posted: FromWorker[] = [];
		const self = { location: { origin: 'https://app.test' }, postMessage: (m: FromWorker) => posted.push(m), onmessage: null as unknown };
		vi.stubGlobal('self', self);
		await import('./engine.worker');
		const send = (data: unknown, origin = '') => (self.onmessage as (e: { data: unknown; origin: string }) => void)({ data, origin });
		return { posted, send };
	}

	it('posts the answer to a yield request', async () => {
		const { posted, send } = await load();
		const { input, nodeId } = withDam();
		send({ type: 'yield', id: 1, request: { input, nodeId, ...opts } } satisfies ToWorker);
		expect(posted).toHaveLength(1);
		expect(posted[0]).toEqual({ type: 'yield-done', id: 1, point: firmYield(prepareYield(input), nodeId, opts) });
	});

	it('ignores another origin and an unknown message', async () => {
		const { posted, send } = await load();
		const { input, nodeId } = withDam();
		send({ type: 'yield', id: 1, request: { input, nodeId, ...opts } }, 'https://evil.test');
		send({ type: 'run', id: 2 });
		expect(posted).toEqual([]);
	});

	it('answers a malformed request with an error, never a throw out of onmessage', async () => {
		const { posted, send } = await load();
		const { input, nodeId } = withDam();
		send({ type: 'yield', id: 4, request: { input, nodeId, ...opts, ops: [{ op: 'settings.set', path: '__proto__', value: {} }] } });
		expect(posted).toEqual([{ type: 'error', id: 4, message: expect.stringMatching(/is not a setting a scenario can change/) }]);
	});
});

describe('who imports compute.ts', () => {
	it('only the worker (and tests): a page importing it would ship the engine run code', () => {
		const src = fileURLToPath(new URL('../..', import.meta.url));
		const walk = (d: string): string[] =>
			readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.(ts|svelte)$/.test(e.name) ? [join(d, e.name)] : []));
		const importers = walk(src)
			.filter((f) => !/\.test\.ts$/.test(f))
			.filter((f) => /from\s+['"][^'"]*preview\/compute['"]|from\s+['"]\.\/compute['"]/.test(readFileSync(f, 'utf8')))
			.map((f) => relative(src, f));
		expect(importers).toEqual(['lib/preview/engine.worker.ts']);
	});
});
