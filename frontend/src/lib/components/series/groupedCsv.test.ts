// The Data tab's CSV of the grouped series (issue #553 round 5): compact and
// full columns, the `#` lines on each area's station, and cells that stay
// harmless whatever a user typed. Synthetic names only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NetworkNode, SeriesMeta } from '@water-management/engine';
import { BOM, commentLine, datedCsv, groupedCsv, textCell, type ExportArea } from './groupedCsv';
import type { AreaRainLines } from './derivedRain';
import { groupSeries } from './groups';

// Rule 7: dates, so under a skewed TZ (UTC+14 would move a local-midnight date a day).
let tz: string | undefined;
beforeAll(() => {
	tz = process.env.TZ;
	process.env.TZ = 'Pacific/Kiritimati';
});
afterAll(() => {
	process.env.TZ = tz;
});

const ser = (id: string, kind: string, extra: Partial<SeriesMeta> = {}) => ({ id, kind, name: id, unit: kind.endsWith('_mm') ? 'mm' : 'm³/s', startDate: '2021-01-01', length: 3, siteNodeId: null, ...extra }) as SeriesMeta;
const NODES = [{ id: 'A', name: 'Unit A', kind: 'farm', areaKm2: 10, mapMm: 800 }] as unknown as NetworkNode[];
const LIST = [ser('Bergwater', 'rain_catchment_mm'), ser('chirps', 'rain_chirps_mm'), ser('chirpsA', 'rain_chirps_mm', { siteNodeId: 'A' }), ser('flow', 'flow_observed_m3s'), ser('evap', 'evap_apan_mm')];
const VALUES = Object.fromEntries(LIST.map((s, i) => [s.id, { startDate: '2021-01-01', values: [i, null, i + 0.5] }]));
const lines = (startDate: string): AreaRainLines =>
	({
		startDate,
		rainUsed: [1.5, 2, 0],
		source: ['station', 'chirps', 'none'],
		patchFrom: [null, null, null],
		stationRaw: [1, null, 0],
		stationScaled: [1.5, null, 0],
		chirpsRaw: [0.4, 1, 0],
		chirpsCorrected: [0.8, 2, 0],
		factors: [2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2],
		refused: null,
		correctAgainst: 'Bergwater',
		forcing: {} as never,
		warnings: []
	}) satisfies AreaRainLines;
const AREAS: ExportArea[] = [{ nodeId: 'A', name: 'Unit A', sentence: 'Bergwater × 1.5 (unit MAP 800.0 mm ÷ station MAP 533.3 mm); gaps from CHIRPS corrected against Bergwater.', lines: lines('2021-01-02') }];
const META = { engineVersion: '1.92.0', exportedOn: '2026-10-24' };
const rows = (csv: string) => csv.slice(BOM.length).trimEnd().split('\r\n');

describe('groupedCsv', () => {
	const groups = groupSeries(LIST, NODES, { unitRain: { mode: 'perUnit' } } as never);

	it('compact: the stations, each unit’s rain used and the flow records, over every column’s days', () => {
		const r = rows(groupedCsv('compact', groups, VALUES, AREAS, META));
		expect(r[0]).toBe('# Data tab export (compact); engine 1.92.0; exported 2026-10-24; derived columns are computed from the stored inputs and are not stored');
		expect(r[1]).toBe('# Unit A: Bergwater × 1.5 (unit MAP 800.0 mm ÷ station MAP 533.3 mm); gaps from CHIRPS corrected against Bergwater.');
		expect(r[2]).toBe('date,Bergwater (mm),Unit A: rain used (mm),flow (m³/s)');
		expect(r.slice(3)).toEqual(['2021-01-01,0,,3', '2021-01-02,,1.5,', '2021-01-03,0.5,2,3.5', '2021-01-04,,0,']);
	});

	it('full: every stored series group by group, a unit’s own under it, and its derived columns and the day’s source', () => {
		const r = rows(groupedCsv('full', groups, VALUES, AREAS, META));
		expect(r[2]).toBe('# Unit A: CHIRPS factors Jan to Dec 2 2 2 2 2 2 2 2 2 2 2 2');
		expect(r[3]).toBe(
			'date,Bergwater (mm),chirps (mm),chirpsA (mm),Unit A: station × ratio (mm),Unit A: CHIRPS corrected (mm),Unit A: rain used (mm),Unit A: rain used from,flow (m³/s),evap (mm)'
		);
		expect(r[5]).toBe('2021-01-02,,,,1.5,0.8,1.5,station,,');
		expect(r[6]).toBe('2021-01-03,0.5,1.5,2.5,,2,2,chirps,3.5,4.5');
		// A patch day names its station (issue #612).
		const patched: ExportArea = { ...AREAS[0]!, lines: { ...lines('2021-01-02'), source: ['station', 'patch', 'none'], patchFrom: [null, 'patch 1: Ridge', null] } };
		expect(rows(groupedCsv('full', groups, VALUES, [patched], META))[6]).toBe('2021-01-03,0.5,1.5,2.5,,2,2,patch 1: Ridge,3.5,4.5');
	});

	it('the average catchment rainfall leads the catchment group; an area without lines adds no columns', () => {
		const settings = { unitRain: { mode: 'perUnit' }, rainStations: { catchment: { stationId: 'Bergwater' } } } as never;
		const g = groupSeries(LIST, NODES, settings);
		const catchment: ExportArea = { nodeId: null, name: 'the catchment', sentence: 'Bergwater × 1.00 (…).', lines: { ...lines('2021-01-01'), chirpsCorrected: null } };
		const compact = rows(groupedCsv('compact', g, VALUES, [catchment, { ...AREAS[0]!, lines: null }], META));
		expect(compact.find((l) => l.startsWith('date,'))).toBe('date,Bergwater (mm),Average catchment rainfall: rain used (mm),flow (m³/s)');
		const full = rows(groupedCsv('full', g, VALUES, [catchment], META));
		expect(full.find((l) => l.startsWith('date,'))).toBe(
			'date,Bergwater (mm),Average catchment rainfall: station × ratio (mm),Average catchment rainfall: rain used (mm),Average catchment rainfall: rain used from,chirps (mm),chirpsA (mm),flow (m³/s),evap (mm)'
		);
	});

	it('a series whose values aren’t there is left out; an unnamed one goes by its kind', () => {
		const unnamed = { ...LIST[3]!, name: '' };
		const g = groupSeries([LIST[0]!, unnamed], NODES, null);
		const r = rows(groupedCsv('compact', g, { Bergwater: VALUES.Bergwater!, flow: VALUES.flow! }, [], META));
		expect(r.find((l) => l.startsWith('date,'))).toBe('date,Bergwater (mm),Flow — observed gauge (m³/s)');
		expect(rows(groupedCsv('compact', g, { flow: VALUES.flow! }, [], META)).find((l) => l.startsWith('date,'))).toBe('date,Flow — observed gauge (m³/s)');
	});

	it('says when an area’s lines couldn’t be computed, or its pairing is refused', () => {
		const refused = { ...lines('2021-01-01'), refused: 'fewer than 5 complete years', factors: null, chirpsCorrected: null };
		const r = rows(groupedCsv('compact', groups, VALUES, [{ ...AREAS[0]!, lines: refused }, { nodeId: null, name: 'the catchment', sentence: null, lines: null, error: 'no model input' }], META));
		expect(r[2]).toBe('# Unit A: CHIRPS gaps not corrected; the pairing is refused (fewer than 5 complete years)');
		expect(r[3]).toBe('# Average catchment rainfall: not computed (no model input)');
	});
});

describe('cells stay harmless', () => {
	it('a header that reads as a formula gets an apostrophe; commas and quotes are quoted', () => {
		expect(textCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
		expect(textCell('Kloof, upper')).toBe('"Kloof, upper"');
		expect(textCell('-1 gauge')).toBe("'-1 gauge");
		for (const lead of ['+', '@', '\t', '\r']) expect(textCell(`${lead}x`).replace(/^"/, '').startsWith("'")).toBe(true);
	});
	it('a comment line stays one cell: its commas, quotes and line breaks are percent-encoded', () => {
		expect(commentLine('a,b "c"\nd')).toBe('# a%2Cb %22c%22%0Ad');
		// `%` too, so the line reads back whole; and the Unicode line breaks and C1 controls.
		const hostile = 'Dam 100% =cmd|x,"y"\u2028z\x7f\x9f';
		const line = commentLine(hostile);
		expect(line).not.toMatch(/[,"\u2028\x7f\x9f]/);
		expect(decodeURIComponent(line.slice(2))).toBe(hostile);
	});
	it('no columns gives the header row alone', () => {
		expect(rows(datedCsv([], []))).toEqual(['date']);
	});
});
