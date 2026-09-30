// The preview worker's computation (./compute.ts) and wiring
// (./engine.worker.ts): the preview's firm yield is the one the `yield` job
// works out (backend/src/jobs/handlers/yield.ts: applyScenario, prepareYield,
// firmYield on the same input), and the worker answers each message with its
// id. Also: only the worker imports compute.ts, so no page ships the engine's
// run code for it.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyScenario, firmYield, prepareYield, type ModelInput, type ScenarioOp } from '@water-management/engine';
import { randomInput } from '@water-management/engine/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handle, previewYield } from './compute';
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
		expect(m.type).toBe('yield-done');
		expect(m.id).toBe(7);
	});

	it("answers the engine's words, with the id, when it throws", () => {
		const { input } = withDam();
		const m = handle({ type: 'yield', id: 3, request: { input, nodeId: 'nope', ...opts } });
		expect(m).toEqual({ type: 'error', id: 3, message: expect.stringMatching(/not found/) });
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
