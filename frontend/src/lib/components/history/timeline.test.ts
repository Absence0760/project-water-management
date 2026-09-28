import { afterEach, describe, expect, it } from 'vitest';
import type { HistoryEvent, HistoryRevision } from '$lib/api/types';
import {
	entryHeading,
	entrySummary,
	eventLine,
	filterEntries,
	groupByChangeSet,
	groupByDay,
	historyContext,
	itemLines,
	localTime,
	parseKind,
	pickEntry,
	revisionLines,
	revisionTitle,
	seriesRestore,
	whenText
} from './timeline';

const rev = (over: Partial<HistoryRevision> = {}): HistoryRevision => ({
	type: 'revision',
	id: '1',
	createdAt: '2026-09-24T10:00:00.000000Z',
	changeSet: 'cs-1',
	actor: 'Ann',
	source: 'model_put',
	reason: null,
	changes: [{ area: 'network', kind: 'changed', subject: 'Hilltop', text: 'Hilltop: dam capacity 100,000 m³ → 250,000 m³' }],
	restoredFrom: null,
	restoredFromRun: null,
	...over
});
const ev = (kind: string, subject: Record<string, unknown> = {}, over: Partial<HistoryEvent> = {}): HistoryEvent => ({
	type: 'event',
	id: '7',
	createdAt: '2026-09-24T10:00:00.000000Z',
	changeSet: 'cs-1',
	actor: 'Ann',
	kind,
	subject,
	...over
});

describe('what an item says', () => {
	it('titles a revision by what wrote it, and lists its change lines', () => {
		expect(revisionTitle(rev())).toBe('Model changed');
		expect(revisionTitle(rev({ source: 'restore' }))).toBe('Earlier version restored');
		expect(revisionLines(rev())).toEqual(['Hilltop: dam capacity 100,000 m³ → 250,000 m³']);
		expect(revisionLines(rev({ source: 'baseline', changes: [] }))[0]).toMatch(/before the first recorded change/);
		expect(revisionLines(rev({ changes: [] }))[0]).toMatch(/doesn’t describe/);
	});

	// WP-3.3: an application's events name it only once it is decided (every viewer reads the log).
	it('writes the application workflow without naming a draft', () => {
		expect(eventLine(ev('scenario.created', { scenarioId: 's', application: true }))).toBe('An applicant started an application');
		expect(eventLine(ev('scenario.submitted', { scenarioId: 's', application: true, opsSha256: 'x' }))).toBe('An applicant submitted an application');
		expect(eventLine(ev('scenario.withdrawn', { scenarioId: 's', application: true }))).toBe('An applicant withdrew an application');
		expect(eventLine(ev('scenario.reopened', { scenarioId: 's', application: true }))).toBe('An applicant reopened an application as a draft');
		expect(eventLine(ev('run.created', { runId: 'r', scenarioId: 's', application: true }))).toBe('Ran an application');
		expect(eventLine(ev('scenario.decided', { scenarioId: 's', application: true, name: 'Raise the dam', outcome: 'approved_with_conditions' }))).toBe(
			'Decided the application “Raise the dam”: approved with conditions'
		);
		expect(eventLine(ev('scenario.shared', { scenarioId: 's', application: true, userId: 'u' }))).toBe('Shared an application with another applicant');
		expect(eventLine(ev('scenario.unshared', { scenarioId: 's', application: true, userId: 'u', self: true }))).toBe('Stopped reading a shared application');
		// A team scenario keeps its name, as before.
		expect(eventLine(ev('scenario.submitted', { scenarioId: 's', name: 'Upper dam' }))).toBe('Submitted the scenario “Upper dam”');
	});

	it('writes each event kind as a sentence', () => {
		expect(eventLine(ev('member.added', { displayName: 'Ben', role: 'viewer' }))).toBe('Added Ben as viewer');
		expect(eventLine(ev('member.added', { displayName: 'Ben', role: 'viewer', via: 'invite' }))).toBe('Ben joined as viewer (accepted an invite)');
		expect(eventLine(ev('member.removed', { displayName: 'Ben', role: 'farmer', self: true }))).toBe('Ben left the project');
		expect(eventLine(ev('member.role', { displayName: 'Ben', from: 'viewer', to: 'editor' }))).toBe('Changed Ben’s role from viewer to editor');
		expect(eventLine(ev('member.party', { displayName: 'Ben', from: null, to: 'Rooikloof Trust' }))).toBe('Put Ben in the applying party Rooikloof Trust');
		expect(eventLine(ev('member.party', { displayName: 'Ben', from: 'Rooikloof Trust', to: null }))).toBe('Took Ben out of the applying party Rooikloof Trust');
		expect(eventLine(ev('signoff.created', { fullName: 'Dr A. Hydrologist', registrationBody: 'SACNASP', registrationNo: '400999/20' }))).toBe(
			'Signed off a run as Dr A. Hydrologist (SACNASP 400999/20)'
		);
		expect(eventLine(ev('farmer.linked', { displayName: 'Cara', nodeName: 'Hilltop', cause: 'farmers_set' }))).toBe('Linked Cara to the unit Hilltop');
		expect(eventLine(ev('farmer.linked', { displayName: 'Cara', nodeName: 'Hilltop', cause: 'invite' }))).toBe('Linked Cara to the unit Hilltop (from their invite)');
		expect(eventLine(ev('farmer.unlinked', { displayName: 'Cara', nodeName: 'Hilltop', cause: 'model_saved' }))).toBe(
			'Unlinked Cara from the unit Hilltop (the unit was removed, or is no longer a unit)'
		);
		expect(eventLine(ev('series.replaced', { kind: 'rain_catchment_mm', name: '', daysChanged: 12, from: '2024-01-01', to: '2024-03-31' }))).toBe(
			'Replaced the Rainfall — catchment series: 12 days changed (1 Jan 2024 to 31 Mar 2024)'
		);
		// Issue #40c: a confirmed feed replacement, a relabel, and the confirmation itself.
		expect(
			eventLine(ev('series.replaced', { kind: 'rain_chirps_mm', name: '', daysChanged: 3, feedId: 'f', source: 'chirps', provenance: { from: 'CHIRPS v2.0', to: 'CHIRPS sat v3.0' } }))
		).toBe('The CHIRPS feed replaced the Rainfall — CHIRPS series: 3 days changed; now CHIRPS sat v3.0, was CHIRPS v2.0');
		expect(eventLine(ev('series.labelled', { kind: 'rain_chirps_mm', name: '', provenance: { from: 'an unrecorded version', to: 'CHIRPS v2.0' } }))).toBe(
			'Marked the Rainfall — CHIRPS series as CHIRPS v2.0 (was an unrecorded version)'
		);
		// 084: a flow record moved to a gauge inside the network, and back.
		expect(eventLine(ev('series.site_changed', { kind: 'flow_observed_m3s', name: 'Weir', site: { from: 'the outlet', to: 'Upper weir' } }))).toMatch(
			/^Moved the .* “Weir” series to gauge Upper weir \(was the outlet\)$/
		);
		expect(eventLine(ev('series.site_changed', { kind: 'flow_observed_m3s', name: 'Weir', site: { from: 'Upper weir', to: 'the outlet' } }))).toMatch(
			/to the outlet \(was gauge Upper weir\)$/
		);
		expect(eventLine(ev('feed.configured', { action: 'changed', source: 'chirps', targetKind: 'rain_chirps_mm', targetName: '', replaceSeries: 'CHIRPS/2.0' }))).toBe(
			'Confirmed that the CHIRPS feed replaces the Rainfall — CHIRPS series at its next fetch'
		);
		expect(eventLine(ev('series.merged', { kind: 'rain_chirps_mm', name: 'grid', daysChanged: 1, feedId: 'f', source: 'chirps' }))).toBe(
			'The CHIRPS feed added days to the Rainfall — CHIRPS “grid” series: 1 day changed'
		);
		expect(eventLine(ev('series.held', { kind: 'flow_logger_m3s', name: 'weir', negative: 2, outlier: 1 }))).toBe(
			'Held automatic runs: new days in the Flow — logger “weir” series look wrong (2 negative days, 1 day far above its usual range). Check the data, then run the model'
		);
		// Judged by the key's own days (series/hold.ts, 055): the line says the check was weaker.
		expect(eventLine(ev('series.held', { kind: 'rain_catchment_mm', name: '', outlier: 1, limitFrom: 'own' }))).toContain(
			'look wrong (1 day far above its usual range). Its usual range so far is the key’s own: no run of the model has read this series yet. Check the data'
		);
		expect(eventLine(ev('series.held', { kind: 'rain_catchment_mm', name: '', outlier: 1, limitFrom: 'accepted' }))).not.toContain('key’s own');
		expect(eventLine(ev('publication.published', { restriction: { level: 'restricted', pct: 20 }, farms: 6 }))).toBe('Published a run, restricted (20 %) to 6 farms');
		expect(eventLine(ev('publication.notice_changed', { fields: ['restriction', 'nextExpectedOn'] }))).toBe(
			'Changed the publication’s restriction notice and next publication date'
		);
		expect(eventLine(ev('run.deleted', { runIds: ['a', 'b'], reason: 'trimmed' }))).toBe('Removed 2 old runs to stay within the storage cap');
		expect(eventLine(ev('project.changed', { fields: ['name'], from: 'Old', to: 'New' }))).toBe('Renamed the project from “Old” to “New”');
		expect(eventLine(ev('project.changed', { fields: ['time_zone'], timeZone: { from: 'Africa/Johannesburg', to: 'Africa/Windhoek' } }))).toBe(
			'Set the time zone to Africa/Windhoek'
		);
		expect(eventLine(ev('project.changed', { fields: ['wua_name'], wuaName: { from: null, to: 'Vaalbank WUA' } }))).toBe('Named the WUA “Vaalbank WUA”');
		expect(eventLine(ev('project.changed', { fields: ['wua_name'], wuaName: { from: 'Vaalbank WUA', to: null } }))).toBe('Cleared the WUA’s name');
		expect(eventLine(ev('restore', { target: 'series', kind: 'flow_observed_m3s', name: 'weir' }))).toBe('Restored earlier values of the Flow — observed gauge “weir” series');
		expect(eventLine(ev('something.new'))).toBe('something.new');
	});

	it('writes the allocation events (WP-3.10) without holder names', () => {
		expect(eventLine(ev('allocation.created', { registrationNo: 'R-1' }))).toBe('Added a registered volume (R-1)');
		expect(eventLine(ev('allocation.changed', { registrationNo: '' }))).toBe('Changed a registered volume');
		expect(eventLine(ev('allocation.deleted', { registrationNo: 'R-2' }))).toBe('Deleted a registered volume (R-2)');
		expect(eventLine(ev('allocation.imported', { fileName: 'extract.csv', rows: 12 }))).toBe('Imported 12 registered volumes from extract.csv');
		expect(eventLine(ev('allocation.import_deleted', { fileName: 'extract.csv', rows: 1 }))).toBe('Removed the import of extract.csv and its 1 registered volume');
	});

	it('writes a team’s threshold change (D11) with both sides, saying which were the defaults', () => {
		const from = { green: 5, amber: 20, source: 'default' };
		const to = { green: 2.5, amber: 12.5, source: 'team' };
		expect(eventLine(ev('team_thresholds.changed', { team: 'Upper WUA', from, to }))).toBe(
			'Changed the portfolio traffic lights of the team “Upper WUA” from green under 5 %, amber under 20 % (the defaults) to green under 2.5 %, amber under 12.5 %'
		);
		expect(eventLine(ev('team_thresholds.changed', { team: 'Upper WUA', from: to, to: from }))).toBe(
			'Changed the portfolio traffic lights of the team “Upper WUA” from green under 2.5 %, amber under 12.5 % to green under 5 %, amber under 20 % (the defaults)'
		);
	});

	it('writes who reaches the project through its team (072), with the role it gives here', () => {
		const who = { team: 'Upper WUA', userId: 'u1', displayName: 'Ben' };
		expect(eventLine(ev('team_member.added', { ...who, teamRole: 'member', role: 'editor' }))).toBe('Added Ben to the team “Upper WUA” as member, so editor here');
		expect(eventLine(ev('team_member.added', { ...who, teamRole: 'viewer', role: 'viewer', via: 'invite' }))).toBe(
			'Ben joined the team “Upper WUA” as viewer (accepted an invite), so viewer here'
		);
		expect(eventLine(ev('team_member.role', { ...who, from: 'member', to: 'admin', role: 'owner' }))).toBe('Changed Ben’s role in the team “Upper WUA” from member to admin, so owner here');
		expect(eventLine(ev('team_member.removed', { ...who, teamRole: 'admin', self: false }))).toBe('Removed Ben (admin) from the team “Upper WUA”');
		expect(eventLine(ev('team_member.removed', { ...who, self: true }))).toBe('Ben left the team “Upper WUA”');
		expect(eventLine(ev('team.deleted', { team: 'Upper WUA', members: 3 }))).toBe('Deleted the team “Upper WUA”: its 3 members no longer reach this project through it');
	});

	it('gives an event one line and a revision its changes', () => {
		expect(itemLines(ev('invite.revoked', { email: 'j•••@example.com' }))).toEqual(['Revoked the invite for j•••@example.com']);
		expect(itemLines(rev())).toHaveLength(1);
	});
});

describe('grouping by change set', () => {
	it('folds one request’s items into one entry, whose revision is the one to restore', () => {
		const items = [
			rev({ id: '3', changeSet: 'save' }),
			ev('farmer.unlinked', {}, { id: '9', changeSet: 'save' }),
			ev('member.added', {}, { id: '8', changeSet: 'other' }),
			ev('run.created', {}, { id: '6', changeSet: null }),
			ev('run.created', {}, { id: '5', changeSet: null })
		];
		const entries = groupByChangeSet(items);
		expect(entries.map((e) => e.items.length)).toEqual([2, 1, 1, 1]);
		expect(entries[0]!.revision?.id).toBe('3');
		expect(entries[1]!.revision).toBeNull();
	});
});

describe('grouping by day, under a skewed time zone', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});

	it('puts an entry on the viewer’s calendar day, not the UTC one', () => {
		const late = groupByChangeSet([rev({ id: '2', changeSet: 'a', createdAt: '2026-09-24T20:30:00.000000Z' }), rev({ id: '1', changeSet: 'b', createdAt: '2026-09-24T09:00:00.000000Z' })]);
		const now = new Date('2026-09-30T12:00:00Z');
		process.env.TZ = 'Pacific/Kiritimati'; // UTC+14: 20:30Z is the next day there
		expect(groupByDay(late, now).map((d) => [d.label, d.entries.length])).toEqual([
			['25 Sep 2026', 1],
			['24 Sep 2026', 1]
		]);
		expect(localTime('2026-09-24T20:30:00.000000Z')).toBe('10:30');
		process.env.TZ = 'Pacific/Pago_Pago'; // UTC−11: 09:00Z is still the 23rd there
		expect(groupByDay(late, now).map((d) => [d.label, d.entries.length])).toEqual([
			['24 Sep 2026', 1],
			['23 Sep 2026', 1]
		]);
		process.env.TZ = 'UTC';
		expect(groupByDay(late, now).map((d) => [d.label, d.entries.length])).toEqual([['24 Sep 2026', 2]]);
		process.env.TZ = 'America/St_Johns'; // UTC−2:30 in September
		expect(localTime('2026-09-24T20:30:00.000000Z')).toBe('18:00');
	});

	it('says Today and Yesterday by the viewer’s clock', () => {
		process.env.TZ = 'Pacific/Kiritimati';
		const now = new Date('2026-09-25T09:00:00Z'); // 25 Sep 23:00 there
		const entries = groupByChangeSet([
			rev({ id: '2', changeSet: 'a', createdAt: '2026-09-25T08:00:00.000000Z' }),
			rev({ id: '1', changeSet: 'b', createdAt: '2026-09-24T09:00:00.000000Z' })
		]);
		expect(groupByDay(entries, now).map((d) => d.label)).toEqual(['Today', 'Yesterday']);
	});
});

describe('the parameter filter', () => {
	it('keeps entries with a matching line, and only those lines of a revision', () => {
		const r = rev({
			changes: [
				{ area: 'network', kind: 'changed', subject: 'Hilltop', text: 'Hilltop: dam capacity 100,000 m³ → 250,000 m³' },
				{ area: 'network', kind: 'changed', subject: 'Hilltop', text: 'Hilltop: area 10 → 12 km²' }
			]
		});
		const entries = groupByChangeSet([r, ev('member.added', { displayName: 'Dam Keeper', role: 'viewer' }, { changeSet: 'x' })]);
		const out = filterEntries(entries, 'DAM capacity');
		expect(out).toHaveLength(1);
		expect(itemLines(out[0]!.items[0]!)).toEqual(['Hilltop: dam capacity 100,000 m³ → 250,000 m³']);
		// The version to restore is still the whole revision.
		expect(out[0]!.revision?.changes).toHaveLength(2);
		expect(filterEntries(entries, 'keeper')).toHaveLength(1);
		expect(filterEntries(entries, '')).toHaveLength(2);
	});
});

describe('seriesRestore', () => {
	const kept = { seriesId: 's1', revisionId: '42', kind: 'rain_catchment_mm', name: '' };

	it('offers the values a replace, a merge or a delete kept, and a restore can be undone', () => {
		for (const kind of ['series.replaced', 'series.merged', 'series.deleted'])
			expect(seriesRestore(ev(kind, kept)), kind).toEqual({ seriesId: 's1', revisionId: '42', what: 'the Rainfall — catchment series' });
		expect(seriesRestore(ev('restore', { ...kept, target: 'series' }))?.revisionId).toBe('42');
	});

	it('offers nothing for a change that kept no values, or that is not a series', () => {
		const { revisionId: _, ...none } = kept;
		void _;
		expect(seriesRestore(ev('series.merged', none))).toBeNull(); // an API key's merge
		expect(seriesRestore(ev('series.created', kept))).toBeNull();
		expect(seriesRestore(ev('restore', { target: 'model', revisionId: '42' }))).toBeNull();
		expect(seriesRestore(rev())).toBeNull();
	});
});

describe('the page: the kind filter, the rows, the pick and the header line', () => {
	const tz = process.env.TZ;
	afterEach(() => {
		process.env.TZ = tz;
	});

	it('reads the kind filter from the URL, and anything unknown as every kind', () => {
		expect(parseKind('revision')).toBe('revision');
		expect(parseKind('series')).toBe('series');
		expect(parseKind('nonsense')).toBe('');
		expect(parseKind('')).toBe('');
		expect(parseKind(null)).toBe('');
	});

	it('sums up a row: a revision by its title and first line, an event by its sentence', () => {
		const two = rev({
			reason: 'Surveyed',
			changes: [
				{ area: 'network', kind: 'changed', subject: 'Hilltop', text: 'Hilltop: dam capacity 100,000 m³ → 250,000 m³' },
				{ area: 'network', kind: 'changed', subject: 'Hilltop', text: 'Hilltop: area 10 → 12 km²' }
			]
		});
		const [withEvent] = groupByChangeSet([two, ev('member.added', { displayName: 'Bo', role: 'viewer' })]);
		expect(entrySummary(withEvent!)).toEqual({ title: 'Model changed', line: 'Hilltop: dam capacity 100,000 m³ → 250,000 m³', more: 2, reason: true });
		const [alone] = groupByChangeSet([ev('member.added', { displayName: 'Bo', role: 'viewer' }, { changeSet: null })]);
		expect(entrySummary(alone!)).toEqual({ title: 'Added Bo as viewer', line: '', more: 0, reason: false });
	});

	it('heads the picked entry by its revision, else by the kind of change', () => {
		const [r] = groupByChangeSet([rev({ source: 'settings_patch' })]);
		expect(entryHeading(r!)).toBe('Settings changed');
		const heads = ['series.replaced', 'member.role', 'publication.published', 'team_member.added', 'restore'].map(
			(k) => entryHeading(groupByChangeSet([ev(k, {}, { changeSet: null })])[0]!)
		);
		expect(heads).toEqual(['Data series', 'Members', 'Publication', 'Change', 'Restores of data']);
	});

	it('picks the entry the URL names, else the newest, else none', () => {
		const entries = groupByChangeSet([rev({ id: '2', changeSet: 'a' }), rev({ id: '1', changeSet: 'b' })]);
		expect(pickEntry(entries, 'revision1')?.key).toBe('revision1');
		expect(pickEntry(entries, 'revision99')?.key).toBe('revision2');
		expect(pickEntry(entries, null)?.key).toBe('revision2');
		expect(pickEntry([], 'revision1')).toBeNull();
	});

	it('says what changed last, by whom and when, on the viewer’s clock', () => {
		process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
		const now = new Date('2026-09-25T09:00:00Z'); // 25 Sep 23:00 there
		const [today] = groupByChangeSet([rev({ createdAt: '2026-09-25T08:05:00.000000Z' })]);
		expect(historyContext(today!, '2026-09-01T00:00:00Z', now)).toBe('Latest change today 22:05 by Ann: Model changed · recorded since 1 Sep 2026');
		const [older] = groupByChangeSet([ev('run.created', {}, { createdAt: '2026-09-20T01:00:00.000000Z', actor: 'Bo' })]);
		expect(historyContext(older!, null, now)).toBe('Latest change 20 Sep 2026 15:00 by Bo: Ran the model');
		const [gone] = groupByChangeSet([rev({ actor: null, createdAt: '2026-09-24T09:00:00.000000Z' })]);
		expect(historyContext(gone!, null, now)).toBe('Latest change yesterday 23:00 by a deleted account: Model changed');
		expect(historyContext(null, '2026-09-01T00:00:00Z', now)).toBe('No changes recorded yet · recorded since 1 Sep 2026');
		expect(whenText('2026-09-25T08:05:00.000000Z', now)).toBe('today 22:05');
	});
});
