// The preview runner's protocol against a fake worker: an answer resolves
// its request, a newer request supersedes (terminates and replaces) the one
// in flight, an answer for another id is dropped, and the engine's error or
// a worker crash rejects with its words.
import type { YieldPoint } from '@water-management/engine';
import { describe, expect, it, vi } from 'vitest';
import type { FromWorker, PreviewEffect, ToWorker, YieldPreviewRequest } from './messages';

vi.mock('virtual:preview-worker-url', () => ({ default: '/preview.worker.js' }));
const { createPreviewEngine, PreviewSuperseded } = await import('./runner');

class FakeWorker {
	posted: ToWorker[] = [];
	terminated = false;
	onmessage: ((e: MessageEvent<FromWorker>) => void) | null = null;
	onerror: ((e: ErrorEvent) => void) | null = null;
	postMessage(m: ToWorker) {
		this.posted.push(m);
	}
	terminate() {
		this.terminated = true;
	}
	reply(m: FromWorker) {
		this.onmessage?.({ data: m } as MessageEvent<FromWorker>);
	}
}

function setup() {
	const workers: FakeWorker[] = [];
	const engine = createPreviewEngine(() => {
		const w = new FakeWorker();
		workers.push(w);
		return w;
	});
	return { engine, workers };
}

const req = { input: {} as YieldPreviewRequest['input'], nodeId: 'dam', pattern: 'constant', assurance: 1, tolerance: 0.001 } satisfies YieldPreviewRequest;
const point = (y: number) => ({ yieldM3Day: y }) as YieldPoint;

describe('createPreviewEngine', () => {
	it('posts the request and resolves with the answer to its id, keeping the worker for the next', async () => {
		const { engine, workers } = setup();
		const p = engine.firmYield(req);
		expect(workers).toHaveLength(1);
		const sent = workers[0]!.posted[0]!;
		expect(sent).toEqual({ type: 'yield', id: sent.id, request: req });
		workers[0]!.reply({ type: 'yield-done', id: sent.id, point: point(5) });
		await expect(p).resolves.toEqual(point(5));
		const q = engine.firmYield(req);
		expect(workers).toHaveLength(1);
		workers[0]!.reply({ type: 'yield-done', id: workers[0]!.posted[1]!.id, point: point(6) });
		await expect(q).resolves.toEqual(point(6));
		expect(workers[0]!.terminated).toBe(false);
	});

	it('a newer request supersedes the one in flight: its worker is terminated and a fresh one takes the new request', async () => {
		const { engine, workers } = setup();
		const first = engine.firmYield(req);
		const second = engine.firmYield({ ...req, assurance: 0.9 });
		await expect(first).rejects.toBeInstanceOf(PreviewSuperseded);
		expect(workers).toHaveLength(2);
		expect(workers[0]!.terminated).toBe(true);
		expect((workers[1]!.posted[0] as Extract<ToWorker, { type: 'yield' }>).request.assurance).toBe(0.9);
		workers[1]!.reply({ type: 'yield-done', id: workers[1]!.posted[0]!.id, point: point(9) });
		await expect(second).resolves.toEqual(point(9));
	});

	it("drops an answer carrying another request's id", async () => {
		const { engine, workers } = setup();
		const p = engine.firmYield(req);
		const id = workers[0]!.posted[0]!.id;
		workers[0]!.reply({ type: 'yield-done', id: id + 100, point: point(1) });
		workers[0]!.reply({ type: 'yield-done', id, point: point(2) });
		await expect(p).resolves.toEqual(point(2));
	});

	it("rejects with the engine's words on an error answer", async () => {
		const { engine, workers } = setup();
		const p = engine.firmYield(req);
		workers[0]!.reply({ type: 'error', id: workers[0]!.posted[0]!.id, message: 'node "dam" not found' });
		await expect(p).rejects.toThrow('node "dam" not found');
		await expect(p).rejects.not.toBeInstanceOf(PreviewSuperseded);
	});

	it('rejects when the worker crashes, and starts a new one for the next request', async () => {
		const { engine, workers } = setup();
		const p = engine.firmYield(req);
		workers[0]!.onerror?.({ message: '' } as ErrorEvent);
		await expect(p).rejects.toThrow(/stopped unexpectedly/);
		expect(workers[0]!.terminated).toBe(true);
		void engine.firmYield(req).catch(() => {});
		expect(workers).toHaveLength(2);
	});

	it("rejects a request it can't post, leaving the worker free for the next", async () => {
		const { engine, workers } = setup();
		const bad = engine.firmYield(req);
		workers[0]!.reply({ type: 'yield-done', id: workers[0]!.posted[0]!.id, point: point(1) });
		await bad;
		workers[0]!.postMessage = () => {
			throw new Error('could not be cloned');
		};
		await expect(engine.firmYield(req)).rejects.toThrow('could not be cloned');
		workers[0]!.postMessage = FakeWorker.prototype.postMessage;
		const next = engine.firmYield(req);
		expect(workers).toHaveLength(1);
		expect(workers[0]!.terminated).toBe(false);
		workers[0]!.reply({ type: 'yield-done', id: workers[0]!.posted.at(-1)!.id, point: point(4) });
		await expect(next).resolves.toEqual(point(4));
	});

	it('asks for an effect and resolves with it; an effect request supersedes a yield one', async () => {
		const { engine, workers } = setup();
		const y = engine.firmYield(req);
		const effectReq = { baseKey: 'p/r', base: {} as YieldPreviewRequest['input'], edited: {} as YieldPreviewRequest['input'] };
		const e = engine.effect(effectReq);
		await expect(y).rejects.toBeInstanceOf(PreviewSuperseded);
		const sent = workers[1]!.posted[0]!;
		expect(sent).toEqual({ type: 'effect', id: sent.id, request: effectReq });
		const effect = { engineVersion: '1.0.0' } as PreviewEffect;
		workers[1]!.reply({ type: 'effect-done', id: sent.id, effect });
		await expect(e).resolves.toBe(effect);
	});

	it('cancel() stops the request in flight; close() leaves no worker', async () => {
		const { engine, workers } = setup();
		const p = engine.firmYield(req);
		engine.cancel();
		await expect(p).rejects.toBeInstanceOf(PreviewSuperseded);
		expect(workers[0]!.terminated).toBe(true);
		// Nothing in flight: cancel() is a no-op, and an idle worker is kept until close().
		const q = engine.firmYield(req);
		workers[1]!.reply({ type: 'yield-done', id: workers[1]!.posted[0]!.id, point: point(3) });
		await q;
		engine.cancel();
		expect(workers[1]!.terminated).toBe(false);
		engine.close();
		expect(workers[1]!.terminated).toBe(true);
	});
});
