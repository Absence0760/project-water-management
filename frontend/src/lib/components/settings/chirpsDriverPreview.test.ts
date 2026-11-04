// chirpsDriverPreview.ts (engine ≥ 1.114.0): the engine's unitChirpsChoicePreview over the model input, fetched once
// per project until forgotten, with the form's choices; a failed fetch is tried again. Synthetic input: invented values
// only (public repo).
import { describe, expect, it, vi } from 'vitest';
import { toEpochDay, type ModelInput } from '@water-management/engine';
import { chirpsDriverPreview, forgetChirpsDriverPreview } from './chirpsDriverPreview';

vi.mock('#lib/api/index.js', () => ({ api: { runs: { modelInput: () => Promise.reject(new Error('not in this test')) } } }));

const START = '2015-01-01';
const DAYS = toEpochDay('2021-01-01') - toEpochDay(START);
const rain = (k: number) => Array.from({ length: DAYS }, (_, i) => (i % 5 === 0 ? 4 * k : 0));
const node = { sortOrder: 0, pctUpstreamToDam: 0, pctRunoffToDam: 0, damCapacityM3: 0, damInitialPct: 0, damMinPct: 0, divertCapacityM3Day: 0, irrigationEfficiency: 0.8, returnFlowFraction: 0, damAreaFullM2: 0, damAreaExponent: 0.7, damSeepagePerDay: 0 };
function input(): ModelInput {
	return {
		settings: { runoffModel: 'gr4j', unitRain: { mode: 'perUnit' } },
		model: {
			nodes: [
				{ ...node, id: 'g', name: 'Gauge', kind: 'gauge', downstreamNodeId: null, areaKm2: 0 },
				{ ...node, id: 'a', name: 'Upper', kind: 'farm', downstreamNodeId: 'g', areaKm2: 2, mapMm: 600, mapSource: 'x' },
				{ ...node, id: 'b', name: 'Lower', kind: 'farm', downstreamNodeId: 'g', areaKm2: 1 }
			],
			crops: [],
			cropAreas: [],
			transfers: []
		},
		series: { rain_catchment_mm: { startDate: START, values: rain(1) }, ['rain_chirps_mm@a' as never]: { startDate: START, values: rain(1) } }
	} as unknown as ModelInput;
}

describe('chirpsDriverPreview', () => {
	it('gives each chosen unit its level, fetching the input once per project', async () => {
		const modelInput = vi.fn(() => Promise.resolve(input()));
		forgetChirpsDriverPreview('p1');
		const p = await chirpsDriverPreview('p1', { a: { correction: 'raw' }, b: { correction: 'bias' } }, {}, { modelInput });
		expect(p.a).toMatchObject({ applies: true, level: { source: 'map' } });
		// Raw CHIRPS × MAP ÷ its mean annual rain: 600 ÷ about 292 mm a year (73 days of 4 mm).
		const level = p.a!.level as { factor: number; meanAnnualMm: number };
		expect(level.factor).toBeCloseTo(600 / level.meanAnnualMm, 12);
		// Lower has no CHIRPS of its own: the choice can't apply.
		expect(p.b).toMatchObject({ applies: false, level: null });
		await chirpsDriverPreview('p1', { a: { correction: 'bias' } }, {}, { modelInput });
		expect(modelInput).toHaveBeenCalledTimes(1);
		forgetChirpsDriverPreview('p1');
		await chirpsDriverPreview('p1', { a: { correction: 'bias' } }, {}, { modelInput });
		expect(modelInput).toHaveBeenCalledTimes(2);
	});

	it('reads the form’s unit-rain setting and bias mode in place of the stored ones', async () => {
		forgetChirpsDriverPreview('p3');
		const modelInput = vi.fn(() => Promise.resolve(input()));
		// No MAP on Lower and no CHIRPS: nothing to show; Upper raw is levelled either way, and a draft setting without a
		// usable shape still previews (the engine resolves it).
		const p = await chirpsDriverPreview('p3', { a: { correction: 'bias' } }, { unitRain: { mode: 'perUnit' }, chirpsBiasCorrection: 'none' }, { modelInput });
		expect(p.a).toMatchObject({ applies: true, level: { source: 'map' } });
		await chirpsDriverPreview('p3', { a: { correction: 'bias' } }, { chirpsBiasCorrection: 'monthly' }, { modelInput });
		expect(modelInput).toHaveBeenCalledTimes(1);
	});

	it('tries a failed fetch again', async () => {
		forgetChirpsDriverPreview('p2');
		const failing = vi.fn(() => Promise.reject(new Error('offline')));
		await expect(chirpsDriverPreview('p2', { a: { correction: 'raw' } }, {}, { modelInput: failing })).rejects.toThrow('offline');
		const ok = vi.fn(() => Promise.resolve(input()));
		expect((await chirpsDriverPreview('p2', { a: { correction: 'raw' } }, {}, { modelInput: ok })).a?.applies).toBe(true);
	});
});
