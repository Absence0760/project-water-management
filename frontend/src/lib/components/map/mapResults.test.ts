// Results on the map, the page's side (mapResults.ts, issue #326 A1): the
// measure in the URL, the run caption, the legend's rows, the fills for areas
// with no figure, and a feature's figure for the card and the table.
import { describe, expect, it } from 'vitest';
import type { MapFeature, RunMeta } from '$lib/api/types';
import { fmtDate } from '$lib/format/number';
import type { MapStatus } from './mapStatus';
import { ewrLine, featureResult, legendRows, noRunLine, resultFills, runCaption, runOption, unlinkedAreas, VIEW_OPTIONS, viewFromParam, viewParam } from './mapResults';

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

	it('offers the four measures, days short first, then Kind as the off state', () => {
		expect(VIEW_OPTIONS.map((o) => o.id)).toEqual(['daysShort', 'curtailment', 'damLevel', 'allocation', 'kind']);
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
