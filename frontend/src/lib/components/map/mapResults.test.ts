// Results on the map, the page's side (mapResults.ts, issue #326 A1): the
// measure in the URL, the run caption, the legend's rows, the fills for areas
// with no figure, and a feature's figure for the card and the table.
import { describe, expect, it } from 'vitest';
import type { MapFeature, RunMeta } from '#lib/api/types.js';
import { fmtDate } from '#lib/format/number.js';
import type { MapStatus } from './mapStatus';
import { ewrLine, featureResult, featureZone, legendRows, noRunLine, resultFills, runCaption, runOption, unlinkedAreas, VIEW_OPTIONS, viewFromParam, viewOptions, viewParam, zoneFills, zoneLegendRows } from './mapResults';
import type { ZoneGroup } from '#lib/calibration/zoneGroups.js';

const poly = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } as MapFeature['geometry'];
const point = { type: 'Point', coordinates: [0, 0] } as MapFeature['geometry'];
const line = { type: 'LineString', coordinates: [[0, 0], [1, 1]] } as MapFeature['geometry'];
const f = (id: string, kind: MapFeature['kind'], nodeId: string | null, geometry = poly) => ({ id, kind, nodeId, geometry });
const st = (nodeId: string, band: MapStatus['band'], measure: MapStatus['measure'] = 'daysShort', label = `${nodeId} label`): MapStatus => ({ nodeId, measure, value: 1, band, label });
const run = (over: Partial<RunMeta> = {}) => ({ id: 'r1', label: 'Wet year', createdAt: '2026-09-20T10:00:00Z', published: false, ...over }) as RunMeta;

describe('the measure in the URL', () => {
	it('defaults to days short, reads the kebab-case words, and drops the param for the default', () => {
		expect(viewFromParam(null)).toBe('daysShort');
		expect(viewFromParam('nonsense')).toBe('daysShort');
		expect(viewFromParam('dam-level')).toBe('damLevel');
		expect(viewFromParam('kind')).toBe('kind');
		expect(viewParam('daysShort')).toBeNull();
		for (const o of VIEW_OPTIONS) expect(viewFromParam(viewParam(o.id))).toBe(o.id);
	});

	it('offers the four measures, days short first, the calibration zone, then Kind as the off state', () => {
		expect(VIEW_OPTIONS.map((o) => o.id)).toEqual(['daysShort', 'curtailment', 'damLevel', 'allocation', 'zone', 'kind']);
		expect(viewFromParam('zone')).toBe('zone');
	});

	it('offers the measures only with a run, and the calibration zone only when one applies (issue #555)', () => {
		expect(viewOptions(true, false).map((o) => o.id)).toEqual(['daysShort', 'curtailment', 'damLevel', 'allocation', 'kind']);
		expect(viewOptions(false, true).map((o) => o.id)).toEqual(['zone', 'kind']);
		expect(viewOptions(true, true).map((o) => o.id)).toEqual(['daysShort', 'curtailment', 'damLevel', 'allocation', 'zone', 'kind']);
	});
});

describe('which run, in words', () => {
	it('names the run and says whether it is the published one, the newest, or a pick', () => {
		// The day it ran in the reader's own time zone (fmtDate), whatever TZ the tests run under.
		const day = fmtDate('2026-09-20T10:00:00Z');
		expect(runCaption({ run: run({ published: true }), from: 'published' })).toBe(`From the published run “Wet year”, ran ${day}.`);
		expect(runCaption({ run: run(), from: 'newest' })).toBe(`From your newest run “Wet year”, ran ${day}: nothing is published yet.`);
		expect(runCaption({ run: run({ label: null }), from: 'picked' })).toBe(`From the run “Untitled run”, ran ${day} (not published).`);
		expect(runCaption({ run: null, from: 'none' })).toBeNull();
		expect(runOption(run({ published: true }))).toBe(`Wet year · ${day} · published`);
	});

	it('says in one line why the map shows kinds when there is no run to show', () => {
		expect(noRunLine(false, false)).toBe('Nothing is published yet, so the map shows each feature’s kind.');
		expect(noRunLine(true, true)).toBe('Nothing is published yet, so the map shows each feature’s kind.');
		expect(noRunLine(true, false)).toMatch(/^No run yet/);
	});
});

describe('the legend', () => {
	it('lists the bands units are in, best first, with the measure’s words and a count', () => {
		const rows = legendRows('daysShort', [st('a', 'short'), st('b', 'ok'), st('c', 'short')]);
		expect(rows.map((r) => [r.band, r.word, r.count])).toEqual([
			['ok', 'OK', 1],
			['short', 'Short', 2]
		]);
		expect(rows[0]).toMatchObject({ text: '95% or more of demand days met', token: '--success' });
	});

	it('keeps "No figure" when an area is not linked, and every band when nothing is counted', () => {
		expect(legendRows('daysShort', [st('a', 'ok')], 2).map((r) => r.band)).toEqual(['ok', 'none']);
		expect(legendRows('daysShort', [st('a', 'ok')], 2)[1].text).toMatch(/or not linked to a unit$/);
		expect(legendRows('curtailment', []).map((r) => r.band)).toEqual(['ok', 'watch', 'short', 'none']);
	});

	it('counts the EWR sites met and missed in one line, or none without a site', () => {
		expect(ewrLine([st('g', 'ok', 'ewr'), st('o', 'short', 'ewr'), st('x', 'none', 'ewr')])).toBe('EWR met every day at 1 site, missed on some days at 1 site');
		expect(ewrLine([st('o', 'short', 'ewr'), st('g', 'short', 'ewr')])).toBe('EWR missed on some days at 2 sites');
		expect(ewrLine([st('x', 'none', 'ewr')])).toBeNull();
	});
});

describe('the fills and a feature’s figure', () => {
	const features = [f('p1', 'farm_parcel', 'a'), f('p2', 'farm_parcel', null), f('d1', 'dam', 'a'), f('b', 'catchment_boundary', null), f('r', 'river', null, line), f('g', 'gauge', 'g', point), f('o', 'other', null)];

	it('gives every area without a figure the "no figure" colour, never the boundary, rivers or points', () => {
		expect(resultFills(features, { p1: 'red', d1: 'red' }, 'grey')).toEqual({ p1: 'red', d1: 'red', p2: 'grey', o: 'grey' });
		expect(resultFills(features, { p1: 'red' }, '')).toEqual({ p1: 'red' });
		expect(unlinkedAreas(features)).toBe(2);
	});

	it('reads a feature’s unit, else its gauge’s EWR, else says why there is no figure', () => {
		const units = new Map([['a', st('a', 'watch')]]);
		const ewr = new Map([['g', st('g', 'short', 'ewr', 'EWR missed on 3 days (gauge)')]]);
		expect(featureResult(features[0], units, ewr)).toMatchObject({ band: 'watch', label: 'a label' });
		expect(featureResult(features[5], units, ewr)).toMatchObject({ band: 'short', measure: 'ewr' });
		expect(featureResult(features[1], units, ewr)).toEqual({ band: 'none', label: 'Not linked to a unit or gauge', measure: null });
		expect(featureResult(f('x', 'farm_parcel', 'zz'), units, ewr)).toMatchObject({ band: 'none', label: 'No figure for what it stands for' });
		expect(featureResult(features[3], units, ewr)).toBeNull();
		expect(featureResult(features[4], units, ewr)).toBeNull();
	});
});

describe('calibration zones on the map (issue #555; locations, issue #659)', () => {
	const group = (over: Partial<ZoneGroup>): ZoneGroup => ({ key: 'H', nodeId: 'H', name: 'Weir', kind: 'gauge', headline: false, units: [], borrowed: [], rest: [], restRule: 'nearest', fitted: true, token: '--series-1', ...over });
	// The weir H: its own unit A and D, which borrows its parameters; the outlet G, the headline: B, and C placed by the rest rule.
	const weir = group({ units: ['A', 'D'], borrowed: ['D'], fitted: false });
	const site = group({ key: 'G', nodeId: 'G', name: 'Outlet', kind: 'outlet', headline: true, units: ['B', 'C'], rest: ['C'], token: '--series-2' });
	const byUnit = new Map([
		['A', weir],
		['B', site],
		['C', site],
		['D', weir]
	]);

	it('lists each group in the legend, upstream first, then its borrowed units, with their units and colour token', () => {
		expect(zoneLegendRows([weir, site])).toEqual([
			{ key: 'H', text: 'Weir zone, not fitted yet', count: 1, note: '', token: '--series-1', marker: false },
			{ key: 'H:borrowed', text: 'Borrowed from Weir, not fitted yet', count: 1, note: '', token: '--series-1', marker: true },
			{ key: 'G', text: 'Outlet zone (outlet, headline)', count: 2, note: '1 nearest upstream', token: '--series-2', marker: false }
		]);
	});

	it('fills each unit’s area in its group’s colour (a borrowed unit its donor’s) and every other area in the no-figure colour', () => {
		const features = [f('a', 'farm_parcel', 'A'), f('b', 'farm_parcel', 'B'), f('u', 'farm_parcel', null), f('x', 'farm_parcel', 'X'), f('d', 'farm_parcel', 'D'), f('bd', 'catchment_boundary', null), f('p', 'farm_parcel', 'C', point)];
		const colour = (t: string) => (t === '--series-1' ? '#111' : '#222');
		expect(zoneFills(features, byUnit, colour, '#999')).toEqual({ a: '#111', b: '#222', u: '#999', x: '#999', d: '#111' });
	});

	it('names a feature’s group for its card and table row: its own zone, borrowed, or the rest rule’s', () => {
		expect(featureZone(f('a', 'farm_parcel', 'A'), byUnit)).toBe('Weir zone, not fitted yet');
		expect(featureZone(f('d', 'farm_parcel', 'D'), byUnit)).toBe('Borrowed from Weir, not fitted yet');
		expect(featureZone(f('b', 'farm_parcel', 'B'), byUnit)).toBe('Outlet zone (outlet, headline)');
		expect(featureZone(f('c', 'farm_parcel', 'C'), byUnit)).toBe('Nearest upstream: Outlet');
		expect(featureZone(f('u', 'farm_parcel', null), byUnit)).toBe('Not linked to a unit');
		expect(featureZone(f('g', 'gauge', 'H', point), byUnit)).toBe('In no zone (not a land unit)');
		expect(featureZone(f('r', 'river', null, line), byUnit)).toBeNull();
	});
});
