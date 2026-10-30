// settings.flowMissing and settings.checksKept (engine ≥ 1.102.0, issue #611): what a save may send, the plain
// refusals (a cap is refused, never cut), and how a copy's or import's fresh series ids follow.
import { CHECKS_KEPT_MAX, EXCLUSIONS_MAX, FLOW_MISSING_RECORDS_MAX, WARNING_KEPT_NOTE_MAX, WARNINGS_KEPT_MAX } from '@water-management/engine';
import { describe, expect, it } from 'vitest';
import { remapSettingSeriesIds, settingSeriesIds } from './flowMissingSettings.js';
import { FitRecord, patchSettings, SettingsPatch } from './settings.js';

const OBS = 'f0000000-0000-4000-8000-000000000001';
const LOG = 'f0000000-0000-4000-8000-000000000002';
const GAUGE = 'f0000000-0000-4000-8000-000000000003';
const period = (i: number) => ({ start: `${2000 + i}-01-01`, end: `${2000 + i}-01-31`, reason: 'Weir silted up (synthetic)' });

const messages = (patch: unknown) => {
	const r = SettingsPatch.safeParse(patch);
	return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('SettingsPatch.flowMissing', () => {
	it('takes a record’s periods, a water year or dates with a reason, and null or {} for none', () => {
		const fm = { [OBS]: [period(1), { waterYear: 2005, reason: 'Logger drift' }], [LOG]: [period(2)] };
		expect(SettingsPatch.parse({ flowMissing: fm })).toEqual({ flowMissing: fm });
		expect(SettingsPatch.parse({ flowMissing: null })).toEqual({ flowMissing: null });
		expect(SettingsPatch.parse({ flowMissing: {} })).toEqual({ flowMissing: {} });
	});

	it('refuses a record that isn’t named by a series id, a period without a reason or out of order, and one listed twice', () => {
		expect(messages({ flowMissing: { 'observed gauge': [period(1)] } })).toEqual(['flow missing periods: a flow record is named by its series id']);
		expect(messages({ flowMissing: { [OBS]: [{ start: '2001-01-01', end: '2001-01-31', reason: ' ' }] } })).toContain('a flow missing period needs a reason');
		expect(messages({ flowMissing: { [OBS]: [{ start: '2001-02-01', end: '2001-01-01', reason: 'x' }] } })).toEqual(['flow missing period ends before it starts']);
		expect(messages({ flowMissing: { [OBS]: [period(1), period(1)] } })).toEqual(['a flow missing period is listed twice for one record']);
		expect(messages({ flowMissing: { [OBS]: [{ start: '2001-02-30', end: '2001-03-01', reason: 'x' }] } })).not.toEqual([]);
	});

	it('refuses, never cuts, past EXCLUSIONS_MAX periods a record or FLOW_MISSING_RECORDS_MAX records; positive control: at the caps it takes them', () => {
		const many = Array.from({ length: EXCLUSIONS_MAX }, (_, i) => period(i));
		expect(SettingsPatch.safeParse({ flowMissing: { [OBS]: many } }).success).toBe(true);
		expect(messages({ flowMissing: { [OBS]: [...many, { start: '2200-01-01', end: '2200-01-02', reason: 'x' }] } })).toEqual([
			`flow missing periods: at most ${EXCLUSIONS_MAX} periods a record; merge neighbouring periods into one`
		]);
		const ids = (n: number) => Array.from({ length: n }, (_, i) => `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
		expect(SettingsPatch.safeParse({ flowMissing: Object.fromEntries(ids(FLOW_MISSING_RECORDS_MAX).map((id) => [id, [period(1)]])) }).success).toBe(true);
		expect(messages({ flowMissing: Object.fromEntries(ids(FLOW_MISSING_RECORDS_MAX + 1).map((id) => [id, [period(1)]])) })).toEqual([`flow missing periods: at most ${FLOW_MISSING_RECORDS_MAX} flow records`]);
	});

	it('is replaced whole by a save: a record left out has none', () => {
		const stored = { flowMissing: { [OBS]: [period(1)], [LOG]: [period(2)] } };
		expect(patchSettings(stored, { flowMissing: { [LOG]: [period(3)] } }).flowMissing).toEqual({ [LOG]: [period(3)] });
	});

	it('rides on a fit record, as the fit saw it', () => {
		const ok = FitRecord.shape.flowMissing.safeParse({ [OBS]: [period(1)] });
		expect(ok.success).toBe(true);
		expect(FitRecord.shape.checksKept.safeParse([`outlier:${OBS}:2001-01-05:2001-01-05`]).success).toBe(true);
		expect(FitRecord.shape.flowMissing.safeParse(undefined).success).toBe(true);
	});
});

describe('SettingsPatch.checksKept', () => {
	const item = (check: string, id = OBS, start = '2001-01-05', end = start) => `${check}:${id}:${start}:${end}`;

	it('takes item ids, each once, and null for none', () => {
		const kept = [item('outlier'), item('flatline', LOG, '2002-03-01', '2002-03-20'), item('zerorun', GAUGE, '2003-11-01', '2004-01-31')];
		expect(SettingsPatch.parse({ checksKept: kept })).toEqual({ checksKept: kept });
		expect(SettingsPatch.parse({ checksKept: null })).toEqual({ checksKept: null });
	});

	it('refuses what isn’t an item id, and an item listed twice', () => {
		const bad = 'a kept data check is named by its item id, <check>:<series id>:<start>:<end>';
		for (const v of ['outlier', `outlier:${OBS}:2001-01-05`, `outlier:not-a-series:2001-01-05:2001-01-05`, item('outlier', OBS, '2001-02-01', '2001-01-01'), item('outlier', OBS, '2001-02-30'), `:${OBS}:2001-01-05:2001-01-05`]) {
			expect(messages({ checksKept: [v] }), v).toEqual([bad]);
		}
		expect(messages({ checksKept: [item('outlier'), item('outlier')] })).toEqual(['a kept data check is listed twice']);
	});

	it('refuses, never cuts, past CHECKS_KEPT_MAX; positive control: at the cap it takes them, within the 64 KB patch', () => {
		const items = (n: number) => Array.from({ length: n }, (_, i) => item('outlier', OBS, `${2000 + Math.floor(i / 300)}-${String(1 + (Math.floor(i / 28) % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`));
		expect(new Set(items(CHECKS_KEPT_MAX)).size).toBe(CHECKS_KEPT_MAX);
		expect(SettingsPatch.safeParse({ checksKept: items(CHECKS_KEPT_MAX) }).success).toBe(true);
		expect(messages({ checksKept: [...items(CHECKS_KEPT_MAX), item('outlier', LOG)] })).toEqual([`kept data checks: at most ${CHECKS_KEPT_MAX}; reopen some before keeping more`]);
	});
});

describe('the series ids settings name, and a copy’s or import’s fresh ones', () => {
	const ST = 'a0000000-0000-4000-8000-00000000000a';
	const settings = {
		rainStations: { catchment: { stationId: ST }, unreliable: { [GAUGE]: [['2001-01-01', '2001-01-31']] } },
		flowMissing: { [OBS]: [period(1)] },
		checksKept: [`outlier:${LOG}:2001-01-05:2001-01-05`, 'not an item'],
		calibrationExclusions: [period(4)]
	};

	it('lists every id: the stations’, a rain record’s with unreliable periods, a flow record’s with missing periods, a kept check’s', () => {
		expect([...settingSeriesIds(settings)].sort()).toEqual([ST, GAUGE, OBS, LOG].sort());
		expect(settingSeriesIds({}).size).toBe(0);
		expect(settingSeriesIds(null).size).toBe(0);
		// A patching priority's stations (issue #612) are named too.
		const P = 'f0000000-0000-4000-8000-00000000000f';
		expect([...settingSeriesIds({ rainStations: { units: { [OBS]: { stationId: ST, patch: [{ source: 'station', stationId: P }, { source: 'chirps' }] } } } })].sort()).toEqual([ST, P].sort());
	});

	it('follows fresh ids; an id not in the map, and anything else, stays', () => {
		const N = (c: string) => `${c}0000000-0000-4000-8000-0000000000ff`;
		const out = remapSettingSeriesIds(settings, new Map([
			[ST, N('1')],
			[GAUGE, N('2')],
			[OBS, N('3')]
		]));
		expect(out).toEqual({
			rainStations: { catchment: { stationId: N('1') }, unreliable: { [N('2')]: [['2001-01-01', '2001-01-31']] } },
			flowMissing: { [N('3')]: [period(1)] },
			checksKept: [`outlier:${LOG}:2001-01-05:2001-01-05`, 'not an item'],
			calibrationExclusions: [period(4)]
		});
		expect(remapSettingSeriesIds(settings, new Map([[LOG, N('4')]])).checksKept).toEqual([`outlier:${N('4')}:2001-01-05:2001-01-05`, 'not an item']);
		expect(remapSettingSeriesIds(settings, new Map())).toBe(settings);
	});

	it('the fit record’s series and kept checks follow too, so a copy’s fit stays current', () => {
		const N = 'f1000000-0000-4000-8000-0000000000ff';
		const withFit = { fitRecord: { flowSeriesId: OBS, checksKept: [`outlier:${OBS}:2001-01-05:2001-01-05`], flowMissing: { [OBS]: [period(1)] } } };
		expect([...settingSeriesIds(withFit)]).toEqual([OBS]);
		expect(remapSettingSeriesIds(withFit, new Map([[OBS, N]])).fitRecord).toEqual({ flowSeriesId: N, checksKept: [`outlier:${N}:2001-01-05:2001-01-05`], flowMissing: { [N]: [period(1)] } });
		expect(FitRecord.shape.flowSeriesId.safeParse(OBS).success).toBe(true);
		expect(FitRecord.shape.flowSeriesId.safeParse('not a series').success).toBe(false);
	});

	it('so do each calibration location row’s fit record’s (issues #555, #659): a moved site record lives in a row', () => {
		const N = 'f1000000-0000-4000-8000-0000000000ff';
		const withRow = { calibrationZones: [{ nodeId: 'g1', fitRecord: { flowSeriesId: OBS, checksKept: [`outlier:${OBS}:2001-01-05:2001-01-05`] } }, { nodeId: 'g2', fitRecord: null }] };
		expect([...settingSeriesIds(withRow)]).toEqual([OBS]);
		expect(remapSettingSeriesIds(withRow, new Map([[OBS, N]])).calibrationZones).toEqual([
			{ nodeId: 'g1', fitRecord: { flowSeriesId: N, checksKept: [`outlier:${N}:2001-01-05:2001-01-05`] } },
			{ nodeId: 'g2', fitRecord: null }
		]);
	});
});

describe('SettingsPatch.warningsKept (issue #611)', () => {
	const kept = (i: number) => ({ id: `run:rain.zeroRun.missing:${i.toString(16).padStart(8, '0')}`, note: i % 2 ? 'Checked with the observer' : '' });
	it('takes ids with a note (empty allowed), each once, and null for none; a later save replaces the list', () => {
		expect(SettingsPatch.parse({ warningsKept: [kept(1), { id: 'problem:data:s1', note: '' }] })).toEqual({ warningsKept: [kept(1), { id: 'problem:data:s1', note: '' }] });
		expect(SettingsPatch.parse({ warningsKept: null })).toEqual({ warningsKept: null });
		const after = patchSettings({ warningsKept: [kept(1), kept(2)] }, { warningsKept: [kept(2)] }) as { warningsKept: unknown };
		expect(after.warningsKept).toEqual([kept(2)]);
	});
	it('refuses a malformed id, a note too long, a missing note, an id twice and anything extra', () => {
		expect(messages({ warningsKept: [{ id: 'run:has space', note: '' }] })).toEqual(['a kept warning is named by its id, run:… or problem:…, with no spaces']);
		expect(messages({ warningsKept: [{ id: 'other:x', note: '' }] })).toEqual(['a kept warning is named by its id, run:… or problem:…, with no spaces']);
		expect(messages({ warningsKept: [{ id: 'run:x', note: 'n'.repeat(WARNING_KEPT_NOTE_MAX + 1) }] })).toEqual([`a kept warning’s note: at most ${WARNING_KEPT_NOTE_MAX} characters`]);
		expect(messages({ warningsKept: [{ id: 'run:x' }] }).length).toBe(1);
		expect(messages({ warningsKept: [kept(1), kept(1)] })).toEqual(['a kept warning is listed twice']);
		expect(messages({ warningsKept: [{ ...kept(1), extra: 1 }] }).length).toBe(1);
	});
	it('refuses, never cuts, past WARNINGS_KEPT_MAX; positive control: at the cap it takes them', () => {
		const full = Array.from({ length: WARNINGS_KEPT_MAX }, (_, i) => kept(i));
		expect(SettingsPatch.parse({ warningsKept: full }).warningsKept).toHaveLength(WARNINGS_KEPT_MAX);
		expect(messages({ warningsKept: [...full, kept(WARNINGS_KEPT_MAX)] })).toEqual([`kept warnings: at most ${WARNINGS_KEPT_MAX}; reopen some before keeping more`]);
	});
});
