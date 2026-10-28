// The climate-state outlook in words (issue #620, ./climate.ts): built with
// the engine's own selectClimateAnalogues and climateConditionedOutlook from
// invented members and invented ONI and AAO series, as the backend's job
// stores them. The panel's markup is rendered with Svelte's server renderer;
// the browser flow is e2e/tests/seasonal-outlook.spec.ts.
import {
	climateConditionedOutlook,
	selectClimateAnalogues,
	summariseOutlook,
	type MonthlyIndexSeries,
	type OutlookMember,
	type OutlookSummaryInput,
	type ProjectModel
} from '@water-management/engine';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import ClimateAnalogues from './ClimateAnalogues.svelte';
import type { OutlookClimate, OutlookResult } from '#lib/api/types.js';
import { fmtNum } from '#lib/format/number.js';
import { buildClimateView, signed, windowText } from './climate';
import { outlookRequest } from './view';

const SEASON = { decisionDate: '2020-10-01', seasonEnd: '2021-04-30' };
const model = { nodes: [{ id: 'dam', name: 'Farm', kind: 'farm', damCapacityM3: 80_000 }], crops: [], cropAreas: [], transfers: [] } as unknown as ProjectModel;
const YEARS = Array.from({ length: 30 }, (_, i) => 1990 + i);
const label = (wy: number) => `${wy}/${String((wy + 1) % 100).padStart(2, '0')}`;

function member(wy: number): OutlookMember {
	return {
		waterYear: wy,
		label: label(wy),
		analogueFrom: `${wy}-10-01`,
		analogueTo: `${wy + 1}-04-30`,
		seasonEndStorageM3: 20_000 + (wy - 1990) * 1000,
		storageM3ByDam: { dam: 20_000 + (wy - 1990) * 1000 },
		farms: {},
		demandM3: 100_000,
		suppliedM3: 90_000,
		demandMet: 0.9,
		userDemandM3: 0,
		userSuppliedM3: 0,
		userDemandMet: null,
		ewrDays: { days: 212, below: wy % 3 === 0 ? 4 : 0 },
		reserve: null
	};
}

/** ONI rising year on year (so the newest seasons are nearest a high ONI), AAO flat. */
function indices(oniThrough = '2020-09'): MonthlyIndexSeries[] {
	const n = (y: number, m: number) => (y - 1979) * 12 + m - 1;
	const last = Number(oniThrough.slice(0, 4)) * 12 + Number(oniThrough.slice(5)) - 1 - 1979 * 12;
	return [
		{ id: 'oni', firstMonth: '1979-01', values: Array.from({ length: last + 1 }, (_, i) => Math.round(((i - 240) / 120) * 100) / 100) },
		{ id: 'aao', firstMonth: '1979-01', values: Array.from({ length: n(2020, 9) + 1 }, (_, i) => (i % 2 ? 0.3 : -0.3)) }
	];
}

function result(series = indices()): OutlookResult {
	const x: OutlookSummaryInput = {
		season: SEASON,
		model,
		analogues: YEARS.map((wy) => ({ waterYear: wy, label: label(wy), from: `${wy}-10-01`, to: `${wy + 1}-04-30` })),
		excluded: [],
		levels: [{ id: '0', label: '100 %', problems: [], members: YEARS.map(member) }],
		startStorageM3: 30_000
	};
	const climate: OutlookClimate = {
		...climateConditionedOutlook(x, selectClimateAnalogues(SEASON, x.analogues, series)),
		source: { oni: { url: 'https://example.invalid/oni', through: '2020-08', revision: 3, fetchedAt: '2020-10-01T00:00:00Z' } }
	};
	return { ...summariseOutlook(x), failures: [], climate };
}

describe('windowText and signed', () => {
	it('names ONI by its 3-month season and AAO by its months', () => {
		expect(windowText('oni', '2015-08', '2015-08')).toBe('JAS 2015');
		expect(windowText('oni', '2015-01', '2015-01')).toBe('DJF 2015');
		expect(windowText('aao', '2015-07', '2015-09')).toBe('Jul–Sep 2015');
		expect(windowText('aao', '2015-11', '2016-01')).toBe('Nov 2015 – Jan 2016');
		expect(signed(0.45)).toBe('+0.45');
		expect(signed(-1.2)).toBe('−1.20');
		expect(signed(0)).toBe('0.00');
	});
});

describe('buildClimateView', () => {
	it('is null for an ESP outlook', () => {
		const { climate: _, ...esp } = result();
		expect(buildClimateView(esp)).toBeNull();
	});

	it('says this season’s state, the years chosen and why, and the dams beside every year', () => {
		const r = result();
		const v = buildClimateView(r)!;
		expect(v.kind).toBe('ready');
		if (v.kind !== 'ready') return;
		const sel = r.climate!.selection;
		expect(v.state).toBe(`ONI JAS 2020 ${signed(sel.indices[0]!.value)}; AAO Jul–Sep 2020 ${signed(sel.indices[1]!.value)}.`);
		// The ONI rises year on year: the newest 10 seasons are nearest.
		expect(sel.k).toBe(10);
		expect(v.chosen.map((y) => y.label)).toEqual(YEARS.slice(-10).reverse().map(label));
		expect(v.chosen[0]).toEqual({ label: '2019/20', oni: signed(sel.years[0]!.values.oni), aao: signed(sel.years[0]!.values.aao), distance: sel.years[0]!.distance.toFixed(2) });
		expect(v.others).toHaveLength(20);
		expect(v.how).toBe('The 10 of 30 past seasons whose ONI and AAO over the same months were nearest this one’s (each index in standard deviations across those seasons, weighted equally).');
		// Storage 20 000 + 1000 × (year − 1990): the chosen 2010–2019 have a median of 44 500 m³, every year 34 500 m³.
		const m3 = (v: number) => `${fmtNum(v)} m³`;
		expect(v.rows).toEqual([
			expect.objectContaining({ id: '0', label: '100 %', storage: { median: m3(44_500), band: `${m3(40_900)} – ${m3(48_100)}` }, storageAll: expect.objectContaining({ median: m3(34_500) }) })
		]);
		expect(v.headline).toBe(`In the 10 past seasons nearest this one, the dams ended at ${m3(44_500)} (10–90 %: ${m3(40_900)} – ${m3(48_100)}) at 100 %, against ${m3(34_500)} in all 30 years.`);
		expect(v.rows[0]!.yearsMet).toMatch(/^EWR met on every day in \d+ of 10 years$/);
		expect(v.rows[0]!.yearsMetAll).toMatch(/^EWR met on every day in \d+ of 30 years$/);
		expect(v.stepped).toBeNull();
		expect(v.missing).toBeNull();
		expect(v.source).toBe('Indices: NOAA Climate Prediction Center, ONI to Aug 2020.');
	});

	it('says when an index was read a month earlier, and why none were chosen', () => {
		const late = buildClimateView(result(indices('2020-07')))!;
		expect(late.kind === 'ready' && late.stepped).toBe('The ONI is read 1 month earlier than usual, in every year alike: the copy didn’t hold its newest month yet.');
		const none = buildClimateView(result(indices('2019-01')))!;
		expect(none).toMatchObject({ kind: 'problem', state: null });
		expect(none.kind === 'problem' && none.message).toMatch(/^The ONI isn’t held for the months before 2020-10-01/);
	});
});

describe('outlookRequest', () => {
	it('sends the method only when it isn’t the default ESP', () => {
		expect(outlookRequest('run', [100])).not.toHaveProperty('method');
		expect(outlookRequest('run', [100], null, 'climateState')).toMatchObject({ method: 'climateState' });
	});
});

describe('ClimateAnalogues markup', () => {
	const html = (r: OutlookResult) => render(ClimateAnalogues, { props: { view: buildClimateView(r)! } }).body;
	// Tags and comments out, every run of white space (the numbers' no-break spaces too) one space. The comments (Svelte's
	// hydration markers) go by splitting at each opener and keeping what follows its closer: a reader of our own markup,
	// not a sanitizer, so nothing is left half-removed for a replace to miss.
	const sp = (s: string) => s.replace(/\s+/g, ' ');
	const uncomment = (h: string) =>
		h
			.split('<!--')
			.map((part, i) => {
				if (i === 0) return part;
				const end = part.indexOf('-->');
				if (end < 0) throw new Error('an unclosed comment in the rendered markup');
				return part.slice(end + 3);
			})
			.join('');
	const text = (h: string) => sp(uncomment(h).replace(/<[^>]+>/g, ' '));

	it('shows the state, the table beside every year, the years chosen with their ONI and AAO, and the source', () => {
		const r = result();
		const v = buildClimateView(r)!;
		if (v.kind !== 'ready') throw new Error('expected a ready view');
		const h = html(r);
		expect(h).toContain('data-testid="outlook-climate"');
		expect(h).toContain('data-state="ready"');
		expect(h).toContain('aria-labelledby="outlook-climate-h"');
		const t = text(h);
		expect(t).toContain(sp(`This season: ${v.state}`));
		expect(t).toContain(sp(v.headline!));
		// One row per level, the chosen seasons' storage beside every year's.
		expect(h.match(/<tr data-level="0"/g)).toHaveLength(1);
		expect(t).toContain(sp(`${v.rows[0]!.storage.median} 10–90 %: ${v.rows[0]!.storage.band} ${v.rows[0]!.storageAll.median}`));
		// The years chosen, nearest first, each with its ONI, AAO and distance; the others collapsed.
		const years = h.slice(h.indexOf('data-testid="climate-years"'));
		const rows = [...years.slice(0, years.indexOf('</table>')).matchAll(/<th scope="row"[^>]*>([^]*?)<\/th>/g)].map((m) => text(m[1]!).trim());
		expect(rows).toEqual(v.chosen.map((y) => y.label));
		expect(t).toContain(sp(`${v.chosen[0]!.label} ${v.chosen[0]!.oni} ${v.chosen[0]!.aao} ${v.chosen[0]!.distance}`));
		expect(t).toContain(sp(`The other past seasons (${v.others.length})`));
		expect(t).toContain('not a forecast');
		expect(t).toContain(sp(v.source!));
		expect(h).not.toContain('data-testid="climate-problem"');
	});

	it('says why no seasons were chosen, with no tables', () => {
		const h = html(result(indices('2019-01')));
		expect(h).toContain('data-state="problem"');
		expect(text(h)).toMatch(/The ONI isn’t held for the months before 2020-10-01/);
		expect(h).not.toContain('data-testid="climate-table"');
		expect(h).not.toContain('data-testid="climate-years"');
		expect(h).not.toContain('data-testid="climate-state"');
	});
});
