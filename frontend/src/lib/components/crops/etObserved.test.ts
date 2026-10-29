import { describe, expect, it } from 'vitest';
import type { EtObserved, EtPoint, EtSourceResult, EtTotals } from '#lib/api/types.js';
import { areaWords, dekadRows, emptyCase, emptyWords, ET_ATTRIBUTION, etCsv, etCsvName, etLine, fmtBias, leadSource, seasonRows, shownSource, sourceLabel, summaryWords } from './etObserved';

const totals = (o: Partial<EtTotals> = {}): EtTotals => ({
	compared: 2,
	skipped: 1,
	observedEtM3: 10_000,
	modelledEtM3: 12_000,
	observedIrrigationM3: 8_000,
	modelledIrrigationM3: 6_000,
	etBiasPct: 20,
	irrigationBiasPct: -25,
	etWithinShare: 0.5,
	irrigationWithinShare: 1,
	...o
});
const point = (o: Partial<EtPoint> = {}): EtPoint => ({
	source: 'wapor',
	dekad: '2020-01-01',
	end: '2020-01-10',
	days: 10,
	etaMmDay: 4,
	validShare: 1,
	areaM2: 120_000,
	mask: 'cropland',
	observedEtM3: 4000,
	modelledEtM3: 5000,
	requirementM3: 5200,
	effectiveRainM3: 500,
	observedIrrigationM3: 3500,
	modelledIrrigationM3: 3000,
	suppliedM3: 3750,
	compared: true,
	skip: null,
	etWithin: true,
	irrigationWithin: true,
	...o
});
const source = (o: Partial<EtSourceResult> = {}): EtSourceResult => ({
	source: 'wapor',
	attribution: 'FAO WaPOR v3, CC BY 4.0',
	area: { areaM2: 120_000, mask: 'cropland', ratioToPlanted: 1.2, differs: false },
	points: [point(), point({ dekad: '2020-01-11', end: '2020-01-20', compared: false, skip: 'partly-seen', etWithin: null, irrigationWithin: null }), point({ dekad: '2020-01-21', end: '2020-01-31', days: 11, irrigationWithin: false })],
	seasons: [{ waterYear: 2019, half: 'summer', label: 'Oct 2019 – Mar 2020', ...totals() }],
	summary: totals(),
	...o
});
const data = (sources: EtSourceResult[] = [source()], o: Partial<EtObserved> = {}): EtObserved => ({
	nodeId: 'n1',
	name: 'Farm A',
	enabled: true,
	parcels: 2,
	thresholds: { minValidShare: 0.8, withinShare: 0.25, floorMmDay: 0.5, areaRatio: 1.5 },
	run: { id: 'r1', label: 'Newest', createdAt: '2026-10-29T00:00:00Z', engineVersion: '1.107.0', forecastFrom: null, inRun: true },
	plantedAreaM2: 100_000,
	sources,
	...o
});

describe('etObserved', () => {
	it('mirrors the backend’s credits', () => {
		expect(ET_ATTRIBUTION.wapor).toBe('FAO WaPOR v3, CC BY 4.0');
		expect(ET_ATTRIBUTION.ssebop).toBe('USGS FEWS NET SSEBop v6, CC0');
	});

	it('shows the source picked in the switch while the unit has it, else the lead, and labels each with its dekads', () => {
		const ssebop = source({ source: 'ssebop', attribution: 'USGS FEWS NET SSEBop v6, CC0', points: [point({ source: 'ssebop' })], summary: totals({ etBiasPct: 5 }) });
		const both = data([source(), ssebop]);
		expect(shownSource(both, null)!.source).toBe('wapor');
		expect(shownSource(both, 'ssebop')!.source).toBe('ssebop');
		expect(shownSource(both, 'wapor')!.source).toBe('wapor');
		// Picked on another unit that has only WaPOR: the lead.
		expect(shownSource(data(), 'ssebop')!.source).toBe('wapor');
		expect(shownSource(null, 'ssebop')).toBeNull();
		expect(sourceLabel(source())).toBe('WaPOR (3 dekads)');
		expect(sourceLabel(ssebop)).toBe('SSEBop (1 dekad)');
		// The fold's line follows the switch.
		expect(etLine(both, false, null, 'ssebop')).toBe('2 dekads compared · crop ET +5% · irrigation −25%');
	});

	it('says why a unit has no observations: the check off (with or without parcels), no parcels linked, or none read yet', () => {
		const none = (enabled: boolean, parcels: number) => data([], { enabled, parcels });
		expect([none(false, 2), none(false, 0), none(true, 0), none(true, 1)].map(emptyCase)).toEqual(['off', 'off-no-parcels', 'no-parcels', 'waiting']);
		expect(emptyWords(none(false, 2))).toBe(
			'The satellite check of actual ET is off on this site (it is off by default). Once it is switched on, the 2 farm parcels linked to Farm A on the Map are read each dekad from satellite (FAO WaPOR v3, CC BY 4.0) and compared here with the model’s crop water use.'
		);
		expect(emptyWords(none(false, 0))).toBe(
			'The satellite check of actual ET is off on this site (it is off by default), and no farm parcels are linked to Farm A on the Map. Once it is on, the parcels linked to a unit are read each dekad from satellite (FAO WaPOR v3, CC BY 4.0) and compared here with the model’s crop water use.'
		);
		expect(emptyWords(none(true, 0))).toBe(
			'No farm parcels are linked to Farm A on the Map, so there is nothing for the satellite to read. Draw Farm A’s parcels on the Map, or link them to it; their actual ET is then read each dekad from satellite (FAO WaPOR v3, CC BY 4.0) and compared here with the model’s crop water use.'
		);
		expect(emptyWords(none(true, 1))).toBe(
			'1 farm parcel is linked to Farm A, but no dekad has been read for it yet. Each dekad is published about three days after it ends and read newest first, so the first should show within a day.'
		);
		expect(emptyWords(none(false, 1))).toContain('the 1 farm parcel linked to Farm A on the Map is read each dekad');
		expect([none(false, 2), none(false, 0), none(true, 0), none(true, 3)].map((d) => etLine(d, false, null))).toEqual([
			'off on this site',
			'off on this site',
			'no farm parcels linked',
			'none read yet'
		]);
	});

	it('leads with WaPOR, else the first source', () => {
		expect(leadSource(data([source({ source: 'ssebop' }), source()]))!.source).toBe('wapor');
		expect(leadSource(data([source({ source: 'ssebop' })]))!.source).toBe('ssebop');
		expect(leadSource(data([]))).toBeNull();
		expect(leadSource(null)).toBeNull();
	});

	it('says in the fold’s line what was compared and which way the model leans', () => {
		expect(etLine(data(), false, null)).toBe('2 dekads compared · crop ET +20% · irrigation −25%');
		expect(etLine(data([]), false, null)).toBe('none read yet');
		expect(etLine(data([source({ summary: totals({ compared: 0, etBiasPct: null, irrigationBiasPct: null }) })]), false, null)).toBe('3 dekads observed, none compared');
		expect(etLine(null, true, null)).toBe('loading…');
		expect(etLine(null, false, 'boom')).toBe('couldn’t be loaded');
	});

	it('signs the bias: + means the model uses more', () => {
		expect(fmtBias(12.4)).toBe('+12%');
		expect(fmtBias(-3)).toBe('−3%');
		expect(fmtBias(0)).toBe('0%');
		expect(fmtBias(0.3)).toBe('0%');
		expect(fmtBias(-0.3)).toBe('0%');
		expect(fmtBias(null)).toBe('–');
	});

	it('puts the totals in a sentence', () => {
		expect(summaryWords(totals(), 0.25)).toBe(
			'Over 2 dekads: The model’s crop ET is 20% above the satellite’s. The model’s irrigation is 25% below the satellite’s. Within ±25%: 50% of dekads for crop ET, 100% for irrigation.'
		);
		expect(summaryWords(totals({ compared: 0 }), 0.25)).toBeNull();
	});

	it('names an observed area far from the planted area, and nothing otherwise', () => {
		expect(areaWords(source(), 100_000)).toBeNull();
		expect(areaWords(source({ area: { areaM2: 200_000, mask: 'parcel', ratioToPlanted: 2, differs: true } }), 100_000)).toBe(
			'The satellite read 20.0 ha of the unit’s parcels; the model plants 10.0 ha. Check the planted areas and the parcels.'
		);
	});

	it('lays out the seasons and the dekads, newest first, with why one wasn’t compared', () => {
		expect(seasonRows(source())[0]).toMatchObject({ label: 'Oct 2019 – Mar 2020', dekads: '2 of 3', etBias: '+20%', irrigationBias: '−25%' });
		const rows = dekadRows(source());
		expect(rows.map((r) => [r.note, r.outside])).toEqual([
			['irrigation differs', true],
			['Not compared: partly seen (cloud or a gap)', false],
			['Agrees', false]
		]);
		expect(rows[2]!.eta).toBe('4.0 mm/day');
		expect(rows.map((r) => r.dekad)).toEqual(['21–31 Jan 2020', '11–20 Jan 2020', '1–10 Jan 2020']);
	});

	it('writes the CSV with the credit on its own first line, then a row per dekad', () => {
		const csv = etCsv(data());
		const lines = csv.split('\r\n');
		expect(lines[0]).toBe('# Farm A: actual ET FAO WaPOR v3, CC BY 4.0 · compared with run "Newest" · volumes on the run\'s planted area');
		expect(lines[1]!.split(',')[0]).toBe('source');
		expect(lines[2]).toBe('wapor,2020-01-01,2020-01-10,10,4,1,120000,cropland,4000,5000,5200,500,3500,3000,3750,yes,');
		expect(lines[3]!.endsWith(',no,partly-seen')).toBe(true);
		expect(lines).toHaveLength(6); // first line, head, three dekads, and the closing CRLF
		expect(etCsvName('Farm A / North')).toBe('Farm-A-North-actual-et.csv');
	});
});
