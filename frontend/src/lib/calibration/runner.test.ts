// The stepwise fit in the browser (issue #659, docs/ui.md § Settings & calibration): one worker per step of the
// engine's plan, in its order, each on the input with the steps before it at their fitted parameters, and the fit's
// report the headline's step's, whichever step it was.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// runner.ts imports the worker's URL from a virtual module only the app build provides.
vi.mock('virtual:autocal-worker-url', () => ({ default: '' }));
import { defaultProjectSettings, newCalibrationZone, type CalibrationReport, type ModelInput, type NetworkNode, type ZoneFitPlanStep } from '@water-management/engine';
import type { FitRequest } from './fit';
import { startStepwiseFit } from './runner';

const node = (id: string, kind: NetworkNode['kind'], down: string | null, areaKm2 = 0) => ({ id, name: id, kind, downstreamNodeId: down, areaKm2 }) as NetworkNode;
const NODES = [node('O', 'gauge', null), node('H', 'gauge', 'O'), node('U', 'farm', 'H', 5), node('D', 'farm', 'O', 5)];

/** Each worker started: the request it got. It answers with X1 = 100 + its step, so each step's parameters are known. */
let seen: FitRequest[] = [];
class FakeWorker {
	onmessage: ((e: MessageEvent) => void) | null = null;
	onerror: ((e: ErrorEvent) => void) | null = null;
	postMessage(req: FitRequest) {
		seen.push(req);
		const x1 = 100 + seen.length;
		queueMicrotask(() => this.onmessage?.({ data: { type: 'done', report: { params: { x1, x2: 0, x3: 90, x4: 1.7 }, zone: req.zone } as unknown as CalibrationReport } } as MessageEvent));
	}
	terminate() {}
}

beforeEach(() => {
	seen = [];
	vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

const input = (settings: Record<string, unknown>): ModelInput =>
	({ settings: { ...defaultProjectSettings(), ...settings }, model: { nodes: NODES, crops: [], cropAreas: [], transfers: [] }, series: {} }) as unknown as ModelInput;
const req = (i: ModelInput) => ({ input: i, model: 'gr4j', objective: 'kgePrime', budget: 50, free: ['x1'], validate: false, seed: 1, starts: 1 }) as FitRequest;

describe('startStepwiseFit', () => {
	it('runs the plan’s steps in order, each on the parameters the steps before it fitted', async () => {
		const i = input({ calibrateAtOutlet: true, calibrationRest: 'nearest', calibrationZones: [{ ...newCalibrationZone('H'), enabled: true }] });
		const plan: ZoneFitPlanStep[] = [
			{ zoneNodeId: 'H', name: 'H', units: ['U'], borrowed: [], deps: [] },
			{ zoneNodeId: null, name: 'O', units: ['D'], borrowed: [], deps: ['H'], headline: true }
		];
		const h = startStepwiseFit(req(i), plan, () => {});
		const steps = await h.steps!;
		expect(seen.map((r) => r.zone)).toEqual(['H', null]);
		// The outlet's step ran with the weir's row at its fitted X1 (101); the weir's step on none.
		expect((seen[0]!.input.settings.calibrationZones as { gr4j: unknown }[])[0]!.gr4j).toBeNull();
		expect((seen[1]!.input.settings.calibrationZones as { gr4j: { x1: number } }[])[0]!.gr4j.x1).toBe(101);
		expect(steps.map((s) => s.report.params.x1)).toEqual([101, 102]);
		expect((await h.result).params.x1).toBe(102);
	});

	it('gives the headline’s report as the fit’s, even when a step after it depends on it', async () => {
		const i = input({ calibrateAtOutlet: true, calibrationRest: 'nearest', calibrationSiteNodeId: 'H', calibrationZones: [{ ...newCalibrationZone('H'), enabled: true }] });
		const plan: ZoneFitPlanStep[] = [
			{ zoneNodeId: 'H', name: 'H', units: ['U'], borrowed: [], deps: [], headline: true },
			{ zoneNodeId: null, name: 'O', units: ['D'], borrowed: [], deps: ['H'] }
		];
		const h = startStepwiseFit(req(i), plan, () => {});
		expect((await h.result).params.x1).toBe(101);
		// The outlet's parameters are the top level's: the outlet step's input kept the form's own.
		expect((seen[1]!.input.settings.gr4j as { x1: number }).x1).toBe(defaultProjectSettings().gr4j.x1);
	});

	it('reads settings from before engine 1.110.0 in the locations shape first, so an inner site’s parameters land in its row', async () => {
		const legacy = { ...defaultProjectSettings(), calibrationSiteNodeId: 'H' } as Record<string, unknown>;
		delete legacy.calibrateAtOutlet;
		const plan: ZoneFitPlanStep[] = [{ zoneNodeId: 'H', name: 'H', units: ['U', 'D'], borrowed: [], deps: [], headline: true }];
		await startStepwiseFit(req(input(legacy)), plan, () => {}).steps;
		expect(seen[0]!.input.settings.calibrateAtOutlet).toBe(false);
		expect(seen[0]!.input.settings.calibrationZones).toEqual([expect.objectContaining({ nodeId: 'H', enabled: true })]);
	});
});
