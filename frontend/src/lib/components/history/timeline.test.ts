import { afterEach, describe, expect, it } from 'vitest';
import type { HistoryEvent, HistoryRevision } from '$lib/api/types';
import { eventLine, filterEntries, groupByChangeSet, groupByDay, itemLines, localTime, revisionLines, revisionTitle } from './timeline';

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

	it('writes each event kind as a sentence', () => {
		expect(eventLine(ev('member.added', { displayName: 'Ben', role: 'viewer' }))).toBe('Added Ben as viewer');
		expect(eventLine(ev('member.added', { displayName: 'Ben', role: 'viewer', via: 'invite' }))).toBe('Ben joined as viewer (accepted an invite)');
		expect(eventLine(ev('member.removed', { displayName: 'Ben', role: 'farmer', self: true }))).toBe('Ben left the project');
		expect(eventLine(ev('member.role', { displayName: 'Ben', from: 'viewer', to: 'editor' }))).toBe('Changed Ben’s role from viewer to editor');
		expect(eventLine(ev('signoff.created', { fullName: 'Dr A. Hydrologist', registrationBody: 'SACNASP', registrationNo: '400999/20' }))).toBe(
			'Signed off a run as Dr A. Hydrologist (SACNASP 400999/20)'
		);
		expect(eventLine(ev('farmer.linked', { displayName: 'Cara', nodeName: 'Hilltop', cause: 'farmers_set' }))).toBe('Linked Cara to the farm Hilltop');
		expect(eventLine(ev('farmer.linked', { displayName: 'Cara', nodeName: 'Hilltop', cause: 'invite' }))).toBe('Linked Cara to the farm Hilltop (from their invite)');
		expect(eventLine(ev('farmer.unlinked', { displayName: 'Cara', nodeName: 'Hilltop', cause: 'model_saved' }))).toBe(
			'Unlinked Cara from the farm Hilltop (the farm was removed, or is no longer a farm)'
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
		expect(eventLine(ev('feed.configured', { action: 'changed', source: 'chirps', targetKind: 'rain_chirps_mm', targetName: '', replaceSeries: 'CHIRPS/2.0' }))).toBe(
			'Confirmed that the CHIRPS feed replaces the Rainfall — CHIRPS series at its next fetch'
		);
		expect(eventLine(ev('series.merged', { kind: 'rain_chirps_mm', name: 'grid', daysChanged: 1, feedId: 'f', source: 'chirps' }))).toBe(
			'The CHIRPS feed added days to the Rainfall — CHIRPS “grid” series: 1 day changed'
		);
		expect(eventLine(ev('publication.published', { restriction: { level: 'restricted', pct: 20 }, farms: 6 }))).toBe('Published a run, restricted (20 %) to 6 farms');
		expect(eventLine(ev('publication.notice_changed', { fields: ['restriction', 'nextExpectedOn'] }))).toBe(
			'Changed the publication’s restriction notice and next publication date'
		);
		expect(eventLine(ev('run.deleted', { runIds: ['a', 'b'], reason: 'trimmed' }))).toBe('Removed 2 old runs to stay within the storage cap');
		expect(eventLine(ev('project.changed', { fields: ['name'], from: 'Old', to: 'New' }))).toBe('Renamed the project from “Old” to “New”');
		expect(eventLine(ev('restore', { target: 'series', kind: 'flow_observed_m3s', name: 'weir' }))).toBe('Restored earlier values of the Flow — observed gauge “weir” series');
		expect(eventLine(ev('something.new'))).toBe('something.new');
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
