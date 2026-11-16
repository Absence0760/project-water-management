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
	stationFieldOfPath,
	stationFormatOf,
	stationServerProblem,
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

	it('says the first problem in the form’s order: the URL, the station ID, then the name', () => {
		expect(stationDraftToBody(ready({ url: '' }), '')).toMatchObject({ field: 'st-url' });
		expect(stationDraftToBody(ready({ station: '' }), '')).toMatchObject({ field: 'st-station' });
	});

	it('starts no earlier than 2000, in the server’s words', () => {
		expect(stationDraftToBody(ready({ startDate: '1999-12-31' }), 'G')).toEqual({
			error: 'A station feed starts on 1 Jan 2000 at the earliest: upload an older record instead.',
			field: 'st-start'
		});
		expect('body' in stationDraftToBody(ready({ startDate: '2000-01-01' }), 'G')).toBe(true);
	});

	it('puts a too-long user name on the user name field', () => {
		expect(stationDraftToBody(ready({ authKind: 'basic', secret: 'password1', user: 'u'.repeat(257) }), 'G')).toMatchObject({ field: 'st-user' });
	});

	it('sends the key once, trimmed, and a user name only for basic', () => {
		const bearer = stationDraftToBody(ready({ authKind: 'bearer', secret: '  tok-1234  ', user: 'ignored' }), 'G');
		expect('body' in bearer && bearer.body.credential).toEqual({ secret: 'tok-1234' });
		expect('body' in bearer && bearer.body.config.auth).toEqual({ kind: 'bearer' });
		const basic = stationDraftToBody(ready({ authKind: 'basic', secret: 'password1', user: ' ann ' }), 'G');
		expect('body' in basic && basic.body.credential).toEqual({ secret: 'password1', user: 'ann' });
		// No user name typed: none sent, never an empty one (the API refuses that).
		const noUser = stationDraftToBody(ready({ authKind: 'basic', secret: 'password1', user: '  ' }), 'G');
		expect('body' in noUser && noUser.body.credential).toEqual({ secret: 'password1' });
	});

	it('never sends an empty credential: a key method with no key is refused, and no method drops a typed key', () => {
		expect(stationDraftToBody(ready({ authKind: 'bearer', secret: '   ' }), 'G')).toEqual({ error: 'Enter the key.', field: 'st-secret' });
		expect(stationDraftToBody(ready({ authKind: 'bearer', secret: 'short12' }), 'G')).toEqual({ error: 'The key is at least 8 characters.', field: 'st-secret' });
		expect(stationDraftToBody(ready({ authKind: 'basic', secret: '' }), 'G')).toEqual({ error: 'Enter the password.', field: 'st-secret' });
		const none = stationDraftToBody(ready({ authKind: 'none', secret: 'left-over' }), 'G');
		expect('body' in none && 'credential' in none.body).toBe(false);
	});

	it('takes a header or query parameter by name, never the key in the URL or an extra header', () => {
		const header = stationDraftToBody(ready({ authKind: 'header', headerName: 'X-Api-Key', headerPrefix: 'Token ', secret: 'key-12345' }), 'G');
		expect('body' in header && header.body.config.auth).toEqual({ kind: 'header', name: 'X-Api-Key', prefix: 'Token ' });
		expect(stationDraftToBody(ready({ authKind: 'header', secret: 'key-12345' }), 'G')).toMatchObject({ field: 'st-header-name' });
		expect(stationDraftToBody(ready({ authKind: 'header', headerName: 'Cookie', secret: 'key-12345' }), 'G')).toMatchObject({ field: 'st-header-name' });
		const query = stationDraftToBody(ready({ authKind: 'query', queryName: 'apiKey', secret: 'key-12345' }), 'G');
		expect('body' in query && query.body.config.auth).toEqual({ kind: 'query', name: 'apiKey' });
		expect(stationDraftToBody(ready({ url: `${URL}&apiKey=abc` }), 'G')).toMatchObject({ field: 'st-url' });
		expect(stationDraftToBody(ready({ url: `${URL}&code=1`, authKind: 'query', queryName: 'code', secret: 'key-12345' }), 'G')).toMatchObject({ field: 'st-query-name' });
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
		// Each { runs to the next } (as /\{[^}]*\}/g did), scanned in one pass: the regex took ~10 s on 100 000 of them.
		expect(stationUrlProblem('https://station.example/{a{station}')).toBe('{a{station} is not a placeholder: use {station}, {start} and {end}.');
		expect(stationUrlProblem(`https://station.example/${'{'.repeat(100_000)}`)).toBeNull();
		expect(stationUrlProblem(`https://station.example/${'{'.repeat(100_000)}}`)).toMatch(/^\{+\} is not a placeholder/);
		expect(stationUrlProblem('https://ann:pw@station.example/')).toMatch(/user name and password/);
		expect(stationUrlProblem('https://station.example/?token=abc')).toMatch(/carries a key \(token=…\)/);
		expect(stationUrlProblem('https://station.example/#x')).toMatch(/#fragment/);
		expect(stationUrlProblem(URL)).toBeNull();
	});

	it('refuses what the server refuses: a placeholder in the host, another port, a name only the local network knows', () => {
		// The server's words (backend config.ts stationUrlProblem, stationUrl.ts urlProblem), as sentences.
		expect(stationUrlProblem('https://{station}.example.com/daily?from={start}')).toBe(
			'The URL’s site (its host) must be written out: put {station}, {start} and {end} in its path or query.'
		);
		expect(stationUrlProblem('https://api.example.com:8443/rain')).toBe('The URL must use the standard HTTPS port: take out the :port.');
		expect(stationUrlProblem('https://api.example.com:443/rain')).toBeNull();
		for (const host of ['localhost', 'logger', 'logger.local', 'station.internal', 'a.localhost']) {
			expect(stationUrlProblem(`https://${host}/rain`), host).toBe('The URL’s host must be a public internet name.');
		}
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
		const typed = { ...emptyStationDraft(), station: 'IKAAPS12', secret: 'abc-12345', time: 'old', scale: '2' };
		const wu = STATION_PRESETS.find((p) => p.id === 'wu-pws-daily')!.apply(typed);
		expect(wu).toMatchObject({ station: 'IKAAPS12', secret: 'abc-12345', authKind: 'query', queryName: 'apiKey', urlTime: 'YYYYMMDD', records: 'observations', value: 'metric.precipTotal', scale: '' });
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

describe('the server’s refusal, on its field', () => {
	const bad = (path: (string | number)[], message: string) => ({ status: 400, message: 'invalid request (…)', details: [{ path, message }] });

	it('maps each place in the body to the form’s field', () => {
		expect(stationFieldOfPath(['config', 'url'], 'none')).toBe('st-url');
		expect(stationFieldOfPath(['config', 'station'], 'none')).toBe('st-station');
		expect(stationFieldOfPath(['config', 'auth', 'name'], 'header')).toBe('st-header-name');
		expect(stationFieldOfPath(['config', 'auth', 'name'], 'query')).toBe('st-query-name');
		expect(stationFieldOfPath(['config', 'headers', 'X-Thing'], 'none')).toBe('st-headers');
		expect(stationFieldOfPath(['config', 'urlTimeFormat'], 'none')).toBe('st-url-time');
		expect(stationFieldOfPath(['config', 'maxDaysPerRequest'], 'none')).toBe('st-max-days');
		expect(stationFieldOfPath(['config', 'revisionDays'], 'none')).toBe('st-revision');
		expect(stationFieldOfPath(['config', 'startDate'], 'none')).toBe('st-start');
		expect(stationFieldOfPath(['config', 'format', 'value'], 'none')).toBe('st-value');
		expect(stationFieldOfPath(['config', 'format', 'timeZone'], 'none')).toBe('st-zone');
		expect(stationFieldOfPath(['credential', 'secret'], 'bearer')).toBe('st-secret');
		expect(stationFieldOfPath(['credential', 'user'], 'basic')).toBe('st-user');
		expect(stationFieldOfPath(['targetName'], 'none')).toBe('name');
		expect(stationFieldOfPath(['schedule'], 'none')).toBeNull();
	});

	it('says the server’s words as a sentence on that field', () => {
		expect(stationServerProblem(bad(['config', 'url'], 'the URL points at a private or reserved address'), 'none')).toEqual({
			error: 'The URL points at a private or reserved address.',
			field: 'st-url'
		});
		// A problem with the whole format is about how its times are read, or its zone or scale when it names them.
		expect(stationServerProblem(bad(['config', 'format'], 'an unknown time zone'), 'none')).toMatchObject({ field: 'st-zone' });
		expect(stationServerProblem(bad(['config', 'format'], 'a pattern needs YYYY'), 'none')).toMatchObject({ field: 'st-time-format' });
	});

	it('puts a series another feed writes on the station name, and leaves the rest to the panel’s line', () => {
		expect(stationServerProblem({ status: 409, message: 'another feed already writes that series' }, 'none')).toEqual({
			error: 'Another feed already writes that series: give the station another name.',
			field: 'name'
		});
		expect(stationServerProblem({ status: 409, message: 'a project can have at most 10 weather station API feeds' }, 'none')).toBeNull();
		expect(stationServerProblem({ status: 400, message: 'station API feeds are off on this server' }, 'none')).toBeNull();
		expect(stationServerProblem(bad(['schedule'], 'bad'), 'none')).toBeNull();
	});
});
