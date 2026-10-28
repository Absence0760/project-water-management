// The evaporation-station panel's wording and choices (stationProposal.ts; issue #646 item 6).
import { describe, expect, it } from 'vitest';
import type { EvaporationStationProposal, EvaporationStationProposals } from '#lib/api/index.js';
import { chosenApan, defaultStation, otherDailySeries, recordText, sameAsSaved, useMessage, whereText } from './stationProposal';

const ROW = [180, 230, 290, 300, 260, 245, 180, 125, 80, 64, 78, 118];
const station = (patch: Partial<EvaporationStationProposal> = {}): EvaporationStationProposal => ({
	code: 'Z1E001',
	name: 'Testpan Dam (invented)',
	pan: 'class_a',
	lon: 21.3,
	lat: -33.8,
	distanceKm: 0,
	recordStart: '2014-01-01',
	recordEnd: '2019-12-31',
	recordYears: 6,
	completeness: 0.983,
	dataset: 'synthetic',
	source: 'Invented',
	synthetic: true,
	monthly: { meansMm: ROW, years: new Array(12).fill(6), first: '2014-01', last: '2019-12', problem: null },
	apan: { ok: true, apanMm: ROW, spanMm: null, conversion: null, note: null },
	conversions: null,
	seriesName: 'DWS Z1E001',
	...patch
});
const symons = station({
	code: 'Z1E002',
	pan: 'symons',
	distanceKm: 18.25,
	apan: null,
	seriesName: 'DWS Z1E002',
	conversions: [
		{ id: 'taljaard2023', label: 'Taljaard (2023) general monthly equation, inverted', result: { ok: true, apanMm: ROW.map((x) => x + 20), spanMm: ROW, conversion: 'taljaard2023', note: 'n' } },
		{ id: 'wr90', label: 'WR90 general monthly equation, inverted', result: { ok: false, reason: 'the S-pan in Jul is below 32.5 mm' } }
	]
});
const props = (stations: EvaporationStationProposal[], daily: EvaporationStationProposals['settings']['dailyApan'] = []): EvaporationStationProposals => ({
	boundary: { featureId: 'f', name: 'B' },
	withinKm: 100,
	datasets: [{ dataset: 'synthetic', count: 4 }],
	stations,
	settings: { apanMm: new Array(12).fill(0), dailyApan: daily }
});

describe('station wording', () => {
	it('says where it is and what its record holds', () => {
		expect(whereText(station())).toBe('inside the boundary');
		expect(whereText(symons)).toBe('18.3 km from the boundary');
		expect(recordText(station())).toBe('2014–2019 (6 years), 98 % of days read');
	});
});

describe('chosenApan', () => {
	it('is a Class-A pan’s means as they stand, and a Symons pan’s only once an equation is picked', () => {
		expect(chosenApan(station(), null)).toMatchObject({ ok: true, apanMm: ROW });
		expect(chosenApan(symons, null)).toBeNull();
		expect(chosenApan(symons, 'taljaard2023')).toMatchObject({ ok: true });
		expect(chosenApan(symons, 'wr90')).toMatchObject({ ok: false });
	});
});

describe('defaultStation', () => {
	it('picks the nearest usable station, else the nearest', () => {
		const short = station({ code: 'Z1E003', apan: { ok: false, reason: 'too short' } });
		expect(defaultStation(props([short, symons, station()]))).toBe('Z1E002');
		expect(defaultStation(props([short]))).toBe('Z1E003');
		expect(defaultStation(props([]))).toBeNull();
	});
});

describe('the daily series', () => {
	it('another series under another name blocks writing it; the station’s own doesn’t', () => {
		const own = { name: 'DWS Z1E001', source: 's', from: '2014-01-01', to: '2019-12-31' };
		const mine = { name: 'My pan', source: null, from: '2020-01-01', to: '2020-02-01' };
		expect(otherDailySeries(props([], [own]), station())).toBeNull();
		expect(otherDailySeries(props([], [mine]), station())).toEqual(mine);
	});
});

describe('useMessage', () => {
	it('says what is written and from where', () => {
		const m = useMessage(station(), ROW, true, props([station()]), null);
		expect(m).toMatch(/^The A-pan row becomes 2\u202f150 mm a year, the monthly means of /);
		expect(m).toMatch(/Z1E001 \(Testpan Dam \(invented\)\), a Class-A pan inside the boundary/);
		expect(m).toMatch(/written as the daily A-pan series “DWS Z1E001”/);
	});

	it('cites the conversion for a Symons pan, and a daily series it leaves in place', () => {
		const daily = [{ name: 'My pan', source: null, from: '2020-01-01', to: '2020-02-01' }];
		const m = useMessage(symons, ROW, false, props([symons], daily), 'Taljaard (2023) general monthly equation, inverted');
		expect(m).toMatch(/converted by the Taljaard \(2023\) general monthly equation, inverted\./);
		expect(m).toMatch(/“My pan” still replaces the monthly row/);
	});

	it('knows a row already saved', () => {
		expect(sameAsSaved(ROW, ROW.map((x) => x + 0.04))).toBe(true);
		expect(sameAsSaved(ROW, ROW.map((x) => x + 0.1))).toBe(false);
	});
});
