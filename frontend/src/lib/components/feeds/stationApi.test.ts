import { describe, expect, it } from 'vitest';
import { previewStationAnswer } from '@water-management/engine/station-format';
import {
	emptyStationDraft,
	moreLine,
	previewRows,
	previewSummary,
	requestLine,
	STATION_PRESETS,
	stationDraftToBody,
	stationFormatOf,
	stationUrlProblem,
	urlPlaceholderNote,
	type StationDraft
} from './stationApi';

const URL = 'https://station.example/daily.json?station={station}&from={start}&to={end}';
/** A draft that attaches: generic JSON daily totals, no key. */
const ready = (over: Partial<StationDraft> = {}): StationDraft => ({
	...STATION_PRESETS.find((p) => p.id === 'json-daily')!.apply(emptyStationDraft()),
	url: URL,
	station: 'WS-01',
	...over
});

describe('stationDraftToBody', () => {
	it('makes the config with the defaults left out, and no credential without a key', () => {
		const r = stationDraftToBody(ready(), 'Hilltop gauge');
		expect(r).toEqual({
			body: {
				config: {
					url: URL,
					station: 'WS-01',
					auth: { kind: 'none' },
					format: { format: 'json', records: 'data', time: 'date', timeFormat: 'YYYY-MM-DD', value: 'rain_mm', resolution: 'daily' }
				}
			}
		});
		expect('credential' in (r as { body: object }).body).toBe(false);
	});

	it('names the station first: the series is called that', () => {
		expect(stationDraftToBody(ready(), '  ')).toEqual({ error: 'Name the station: its rainfall series is called that.', field: 'name' });
	});

	it('sends the key once, trimmed, and a user name only for basic', () => {
		const bearer = stationDraftToBody(ready({ authKind: 'bearer', secret: '  tok-1234  ', user: 'ignored' }), 'G');
		expect('body' in bearer && bearer.body.credential).toEqual({ secret: 'tok-1234' });
		expect('body' in bearer && bearer.body.config.auth).toEqual({ kind: 'bearer' });
		const basic = stationDraftToBody(ready({ authKind: 'basic', secret: 'pw', user: ' ann ' }), 'G');
		expect('body' in basic && basic.body.credential).toEqual({ secret: 'pw', user: 'ann' });
		// No user name typed: none sent, never an empty one (the API refuses that).
		const noUser = stationDraftToBody(ready({ authKind: 'basic', secret: 'pw', user: '  ' }), 'G');
		expect('body' in noUser && noUser.body.credential).toEqual({ secret: 'pw' });
	});

	it('never sends an empty credential: a key method with no key is refused, and no method drops a typed key', () => {
		expect(stationDraftToBody(ready({ authKind: 'bearer', secret: '   ' }), 'G')).toEqual({ error: 'Enter the key.', field: 'st-secret' });
		expect(stationDraftToBody(ready({ authKind: 'basic', secret: '' }), 'G')).toEqual({ error: 'Enter the password.', field: 'st-secret' });
		const none = stationDraftToBody(ready({ authKind: 'none', secret: 'left-over' }), 'G');
		expect('body' in none && 'credential' in none.body).toBe(false);
	});

	it('takes a header or query parameter by name, never the key in the URL or an extra header', () => {
		const header = stationDraftToBody(ready({ authKind: 'header', headerName: 'X-Api-Key', headerPrefix: 'Token ', secret: 'k' }), 'G');
		expect('body' in header && header.body.config.auth).toEqual({ kind: 'header', name: 'X-Api-Key', prefix: 'Token ' });
		expect(stationDraftToBody(ready({ authKind: 'header', secret: 'k' }), 'G')).toMatchObject({ field: 'st-header-name' });
		expect(stationDraftToBody(ready({ authKind: 'header', headerName: 'Cookie', secret: 'k' }), 'G')).toMatchObject({ field: 'st-header-name' });
		const query = stationDraftToBody(ready({ authKind: 'query', queryName: 'apiKey', secret: 'k' }), 'G');
		expect('body' in query && query.body.config.auth).toEqual({ kind: 'query', name: 'apiKey' });
		expect(stationDraftToBody(ready({ url: `${URL}&apiKey=abc` }), 'G')).toMatchObject({ field: 'st-url' });
		expect(stationDraftToBody(ready({ url: `${URL}&code=1`, authKind: 'query', queryName: 'code', secret: 'k' }), 'G')).toMatchObject({ field: 'st-query-name' });
		expect(stationDraftToBody(ready({ headers: [{ name: 'Authorization', value: 'Bearer x' }] }), 'G')).toMatchObject({ field: 'st-headers' });
	});

	it('keeps up to 8 named extra headers, drops blank rows, and refuses a ninth', () => {
		const ok = stationDraftToBody(ready({ headers: [{ name: 'Accept', value: 'application/json' }, { name: '', value: ' ' }] }), 'G');
		expect('body' in ok && ok.body.config.headers).toEqual({ Accept: 'application/json' });
		const nine = Array.from({ length: 9 }, (_, i) => ({ name: `X-H${i}`, value: 'v' }));
		expect(stationDraftToBody(ready({ headers: nine }), 'G')).toEqual({ error: 'At most 8 extra headers.', field: 'st-headers' });
		expect(stationDraftToBody(ready({ headers: [{ name: '', value: 'v' }] }), 'G')).toMatchObject({ field: 'st-headers' });
	});

	it('needs a station ID when the URL asks for one', () => {
		expect(stationDraftToBody(ready({ station: '' }), 'G')).toEqual({ error: 'The URL has {station}: enter the station’s ID.', field: 'st-station' });
		expect(stationDraftToBody(ready({ station: 'a/b' }), 'G')).toMatchObject({ field: 'st-station' });
		const without = stationDraftToBody(ready({ station: '', url: 'https://station.example/latest.json?from={start}&to={end}' }), 'G');
		expect('body' in without && 'station' in without.body.config).toBe(false);
	});

	it('sends the request settings only when they differ from the defaults', () => {
		const r = stationDraftToBody(ready({ urlTime: 'epoch_s', maxDays: '7', revisionDays: '0', startDate: '2026-01-01' }), 'G');
		expect('body' in r && r.body.config).toMatchObject({ urlTimeFormat: 'epoch_s', maxDaysPerRequest: 7, revisionDays: 0, startDate: '2026-01-01' });
		const custom = stationDraftToBody(ready({ urlTime: 'custom', urlTimeCustom: 'DD.MM.YYYY' }), 'G');
		expect('body' in custom && custom.body.config.urlTimeFormat).toBe('DD.MM.YYYY');
		expect(stationDraftToBody(ready({ urlTime: 'custom', urlTimeCustom: 'MM/YYYY' }), 'G')).toMatchObject({ field: 'st-url-time' });
		expect(stationDraftToBody(ready({ maxDays: '400' }), 'G')).toMatchObject({ field: 'st-max-days' });
		expect(stationDraftToBody(ready({ revisionDays: 'x' }), 'G')).toMatchObject({ field: 'st-revision' });
	});
});

describe('stationUrlProblem and urlPlaceholderNote', () => {
	it('asks for https, known placeholders and no key or fragment', () => {
		expect(stationUrlProblem('')).toBe('Enter the API’s URL, starting https://.');
		expect(stationUrlProblem('http://station.example/x')).toMatch(/must start with https/);
		expect(stationUrlProblem('https://station.example/{day}')).toBe('{day} is not a placeholder: use {station}, {start} and {end}.');
		expect(stationUrlProblem('https://ann:pw@station.example/')).toMatch(/user name and password/);
		expect(stationUrlProblem('https://station.example/?token=abc')).toMatch(/carries a key \(token=…\)/);
		expect(stationUrlProblem('https://station.example/#x')).toMatch(/#fragment/);
		expect(stationUrlProblem(URL)).toBeNull();
	});

	it('says when the URL names no days', () => {
		expect(urlPlaceholderNote(URL)).toBeNull();
		expect(urlPlaceholderNote('https://station.example/latest')).toMatch(/no \{start\} or \{end\}/);
		expect(urlPlaceholderNote('https://station.example/?from={start}')).toBe('The URL has no {end}: check the API wants only the first day.');
		expect(urlPlaceholderNote('')).toBeNull();
	});
});

describe('stationFormatOf', () => {
	it('builds a CSV, sub-daily format with only what differs from the defaults', () => {
		const d = STATION_PRESETS.find((p) => p.id === 'csv-5min')!.apply(emptyStationDraft());
		const r = stationFormatOf({ ...d, dayStartHour: '0', creditDayTo: 'end', valueKind: 'cumulative', scale: '0,2', skipLines: '1', delimiter: ';', decimalComma: true });
		expect(r).toEqual({
			format: {
				format: 'csv',
				time: 'TIMESTAMP',
				value: 'Rain_mm_Tot',
				timeFormat: 'YYYY-MM-DD HH:mm:ss',
				resolution: 'subdaily',
				delimiter: ';',
				skipLines: 1,
				decimalComma: true,
				dayStartHour: 0,
				creditDayTo: 'end',
				valueKind: 'cumulative',
				scale: 0.2
			}
		});
	});

	it('leaves the default missing markers and zone out, and keeps the empty marker with your own', () => {
		const r = stationFormatOf(ready());
		expect('format' in r && r.format.missing).toBeUndefined();
		expect('format' in r && r.format.timeZone).toBeUndefined();
		const own = stationFormatOf(ready({ missing: '---, x', timeZone: 'UTC' }));
		expect('format' in own && own.format).toMatchObject({ missing: ['', '---', 'x'], timeZone: 'UTC' });
	});

	it('explains a format the reader can’t use, on its field', () => {
		expect(stationFormatOf(ready({ time: '' }))).toMatchObject({ field: 'st-time' });
		expect(stationFormatOf(ready({ value: '' }))).toMatchObject({ field: 'st-value' });
		expect(stationFormatOf(ready({ timeFormat: 'custom', timeFormatCustom: 'HH:mm' }))).toMatchObject({ field: 'st-time-format' });
		expect(stationFormatOf(ready({ timeZone: 'Mars/Olympus' }))).toMatchObject({ field: 'st-zone' });
		expect(stationFormatOf(ready({ scale: '0' }))).toMatchObject({ field: 'st-scale' });
		expect(stationFormatOf(ready({ resolution: 'daily', valueKind: 'cumulative' }))).toHaveProperty('format');
		// A decimal comma with comma-separated columns can't be read.
		expect(stationFormatOf({ ...ready(), format: 'csv', time: 'd', decimalComma: true })).toHaveProperty('error');
	});

	it('takes records keyed by time with no time field', () => {
		const r = stationFormatOf(ready({ recordsKeyedByTime: true, time: '', timeFormat: 'epoch_s', value: 'v' }));
		expect('format' in r && r.format).toMatchObject({ recordsKeyedByTime: true, time: '', timeFormat: 'epoch_s' });
	});
});

describe('presets', () => {
	it('prefill the format (and for Weather Underground the URL and key method) but keep the name, station and key', () => {
		const typed = { ...emptyStationDraft(), station: 'IKAAPS12', secret: 'abc', time: 'old', scale: '2' };
		const wu = STATION_PRESETS.find((p) => p.id === 'wu-pws-daily')!.apply(typed);
		expect(wu).toMatchObject({ station: 'IKAAPS12', secret: 'abc', authKind: 'query', queryName: 'apiKey', urlTime: 'YYYYMMDD', records: 'observations', value: 'metric.precipTotal', scale: '' });
		const body = stationDraftToBody(wu, 'Home');
		expect('body' in body && body.body.config).toMatchObject({ urlTimeFormat: 'YYYYMMDD', maxDaysPerRequest: 31, auth: { kind: 'query', name: 'apiKey' } });
		const generic = STATION_PRESETS.find((p) => p.id === 'json-daily')!.apply({ ...typed, url: URL, authKind: 'bearer' });
		expect(generic).toMatchObject({ url: URL, authKind: 'bearer', time: 'date', scale: '' });
	});

	it('each give a format the reader accepts', () => {
		for (const p of STATION_PRESETS) expect(stationFormatOf(p.apply(emptyStationDraft())), p.id).toHaveProperty('format');
	});

	it('read a sample of their own shape', () => {
		const now = Date.parse('2026-11-15T12:00:00Z');
		const csv = stationFormatOf(STATION_PRESETS.find((p) => p.id === 'csv-5min')!.apply(emptyStationDraft()));
		const text = 'TIMESTAMP,RECORD,Rain_mm_Tot\n"2026-11-13 08:05:00",1,0.2\n"2026-11-13 12:00:00",2,NAN\n"2026-11-14 09:00:00",3,1.4\n';
		const r = previewStationAnswer(text, 'format' in csv ? csv.format : (null as never), now);
		expect(r.values).toEqual([null, 1.4]);
	});
});

describe('the preview', () => {
	it('summarises what a sample would write', () => {
		expect(previewSummary({ startDate: '2026-11-01', values: [1, null, 0], daysWithData: 2, gaps: 1, records: 3, readings: 3 })).toBe('Read 3 records: 3 days, 2 with rain data and 1 gap.');
		expect(previewSummary({ startDate: '2026-11-01', values: [], daysWithData: 0, gaps: 0, records: 2, readings: 0 })).toMatch(/none held a reading/);
		expect(previewSummary({ startDate: '2026-11-15', values: [], daysWithData: 0, gaps: 0, records: 1, readings: 1 })).toMatch(/no day in it has ended/);
	});

	it('lists the last days, newest first', () => {
		const values = Array.from({ length: 20 }, (_, i) => (i === 19 ? null : i));
		const rows = previewRows({ startDate: '2026-10-01', values });
		expect(rows).toHaveLength(14);
		expect(rows[0]).toEqual({ day: '2026-10-20', mm: null });
		expect(rows[13]).toEqual({ day: '2026-10-07', mm: 6 });
	});
});

describe('the folds’ lines', () => {
	it('say the request settings and values in words', () => {
		expect(requestLine(emptyStationDraft())).toBe('dates as YYYY-MM-DD, 31 days a request, the last 7 read again, from 90 days back');
		expect(requestLine({ ...emptyStationDraft(), urlTime: 'epoch_s', maxDays: '5', headers: [{ name: 'Accept', value: 'x' }] })).toBe(
			'dates as Unix seconds, 5 days a request, the last 7 read again, from 90 days back, 1 extra header'
		);
		expect(moreLine(emptyStationDraft())).toBe('values as written, the usual missing markers, a day with no readings is a gap');
		expect(moreLine({ ...emptyStationDraft(), scale: '25.4', missing: 'x', noReadingsMeans: 'zero' })).toBe('values × 25.4, your own missing markers, a day with no readings is 0 mm');
	});
});
