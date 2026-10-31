// The areal rainfall correction's "from a MAP" helper (arealFromMap.ts, arealForcing.ts; docs/model.md §2.4g): the
// forcing before the correction, the factor an entered MAP gives over its complete water years, what refuses it,
// the source note, and what Use fills in. Synthetic input only: invented values (public repo).
import { describe, expect, it, vi } from 'vitest';
import { PE_SOURCE_MAX, toEpochDay, type ModelInput, type ProjectSettings } from '@water-management/engine';
import { arealMapBlocker, arealMapNote, forcingRain, proposeArealFromMap, waterYearsSpan, withArealMapProposal } from './arealFromMap';
import { readArealForcing } from './arealForcing';
import { arealRainFormError } from './arealRain';

vi.mock('#lib/api/index.js', () => ({ api: { runs: { modelInput: () => Promise.reject(new Error('not in this test')) } } }));

const START = '2001-10-01';
const DAYS = toEpochDay('2004-10-01') - toEpochDay(START); // three complete water years
/** 1 mm every day: 365, 365 and 366 mm in WY 2001/02, 2002/03, 2003/04. */
const flat = (v = 1): (number | null)[] => new Array(DAYS).fill(v);

describe('forcingRain', () => {
	it('takes catchment rain, else CHIRPS, else the forecast, a negative value as 0, and keeps a day with none as no value', () => {
		expect(forcingRain([2, null, null, -1, null], [9, 3, null, 9, null], [9, 9, 4, 9, null], 5)).toEqual([2, 3, 4, 0, null]);
		expect(forcingRain([], [], [], 2)).toEqual([null, null]);
	});
});

describe('proposeArealFromMap', () => {
	it('divides the MAP by the mean over the complete water years, to three decimals, with the years and the note', () => {
		const p = proposeArealFromMap(700, 'WR2012, quaternary X00A', { startDate: START, rainMm: flat() });
		expect(p.ok).toBe(true);
		if (!p.ok) return;
		expect(p.meanAnnualMm).toBeCloseTo(1096 / 3, 9);
		expect(p.factor).toBe(Number((700 / (1096 / 3)).toFixed(3)));
		expect(p.waterYears).toEqual([2001, 2002, 2003]);
		expect(p.outsideBand).toBe(false);
		expect(p.note).toBe('Catchment MAP 700 mm (WR2012, quaternary X00A) ÷ the GR4J rain’s mean annual 365 mm over WY 2001/02–2003/04 (3 complete water years) = × 1.916');
	});

	it('leaves out a water year with a day of no value, and refuses a forcing with no complete year', () => {
		const gap = flat();
		gap[400] = null; // in WY 2002/03
		const p = proposeArealFromMap(500, 'x', { startDate: START, rainMm: gap });
		expect(p.ok && p.waterYears).toEqual([2001, 2003]);
		const p2 = proposeArealFromMap(500, 'x', { startDate: '2001-11-01', rainMm: new Array(300).fill(1) });
		expect(p2).toEqual({ ok: false, problem: expect.stringMatching(/no complete water year/) });
	});

	it('refuses no MAP, and a factor outside 0.25–4; flags one outside 0.5–2 and still offers it', () => {
		const f = { startDate: START, rainMm: flat() };
		expect(proposeArealFromMap(null, 'x', f)).toEqual({ ok: false, problem: 'Enter the catchment’s MAP in mm.' });
		expect(proposeArealFromMap(0, 'x', f).ok).toBe(false);
		const high = proposeArealFromMap(1600, 'x', f);
		expect(high.ok).toBe(false);
		expect(!high.ok && high.problem).toMatch(/× 4\.38.*outside the 0\.25–4/);
		expect(proposeArealFromMap(80, 'x', f).ok).toBe(false);
		const band = proposeArealFromMap(800, 'x', f);
		expect(band.ok && band.outsideBand).toBe(true);
		const low = proposeArealFromMap(150, 'x', f);
		expect(low.ok && low.outsideBand).toBe(true);
	});
});

describe('the source note and Use', () => {
	it('names one water year alone, and the span with its count otherwise', () => {
		expect(waterYearsSpan([2010])).toBe('WY 2010/11 (1 complete water year)');
		expect(waterYearsSpan([2001, 2004])).toBe('WY 2001/02–2004/05 (2 complete water years)');
		expect(waterYearsSpan([])).toBe('no complete water year');
	});

	it('keeps the note within the source limit, cutting the reference first', () => {
		const note = arealMapNote(560, 'r'.repeat(900), 410.2, [2001, 2002], 1.365);
		expect(note.length).toBeLessThanOrEqual(PE_SOURCE_MAX);
		expect(note).toMatch(/^Catchment MAP 560 mm \(r+…\) ÷ .* = × 1\.365$/);
		expect(arealMapNote(560, '  ', 410.2, [2001], 1.365)).toBe('Catchment MAP 560 mm ÷ the GR4J rain’s mean annual 410 mm over WY 2001/02 (1 complete water year) = × 1.365');
	});

	it('waits for the rain and the MAP’s reference before Use, then fills every month, Independent MAP and the note', () => {
		expect(arealMapBlocker(null, 'x')).toBe('Work the factor out first');
		const f = { startDate: START, rainMm: flat() };
		expect(arealMapBlocker(proposeArealFromMap(null, '', f), '')).toBe('Enter the catchment’s MAP in mm');
		const p = proposeArealFromMap(500, '', f);
		expect(arealMapBlocker(p, ' ')).toMatch(/^Say where the MAP comes from/);
		const q = proposeArealFromMap(500, 'WR2012', f);
		expect(arealMapBlocker(q, 'WR2012')).toBeNull();
		if (!q.ok) throw new Error('expected a proposal');
		const next = withArealMapProposal({ factors: [1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], method: 'stations', source: 'old' }, q);
		expect(next).toEqual({ factors: new Array(12).fill(q.factor), method: 'map', source: q.note });
		// What Use fills in, Save takes.
		expect(arealRainFormError(next)).toBeNull();
	});
});

describe('readArealForcing', () => {
	const input = (series: ModelInput['series'], settings: Record<string, unknown> = {}): ModelInput =>
		({ settings: { runoffModel: 'gr4j', ...settings }, model: { nodes: [], crops: [], cropAreas: [], transfers: [] }, series }) as unknown as ModelInput;

	it('reads the rain as a run with the form’s settings would, the correction itself left out of it', async () => {
		const chirps = flat(2);
		const gauge = flat(1).map((v, t) => (t < 30 ? null : v));
		const form = { arealRain: { factors: new Array(12).fill(3), method: 'map', source: 'x' } } as unknown as ProjectSettings;
		const fetch = vi.fn(() => Promise.resolve(input({ rain_catchment_mm: { startDate: START, values: gauge }, rain_chirps_mm: { startDate: START, values: chirps } })));
		const r = await readArealForcing('p1', form, undefined, fetch);
		expect(fetch).toHaveBeenCalledWith('p1');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.startDate).toBe(START);
		expect(r.rainMm).toHaveLength(DAYS);
		// The gauge where it has a value, untouched by the × 3 the form sets; CHIRPS (corrected, so not checked to the mm) on its gap.
		expect(r.rainMm.slice(30, 40)).toEqual(new Array(10).fill(1));
		expect(r.rainMm.slice(0, 30).every((v) => v !== null && v > 0)).toBe(true);
	});

	it('says why when no run can be prepared', async () => {
		const r = await readArealForcing('p1', {} as ProjectSettings, undefined, () => Promise.resolve(input({})));
		expect(r).toEqual({ ok: false, problem: expect.stringMatching(/^The run can’t be prepared: .*no rainfall series/) });
	});
});
