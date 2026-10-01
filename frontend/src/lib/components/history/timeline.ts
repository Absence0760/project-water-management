// The History tab's pure logic (WP-2.4, docs/ui.md § History): what each
// item says, grouping one request's items (a change set) into one entry, and
// entries into the viewer's calendar days. No DOM, no fetch.
import { registrationLine } from '@water-management/engine';
import { language, LOCALES } from '@water-management/engine/languages';
import { roleLabel } from '$lib/api/roleLabels';
import type { HistoryEvent, HistoryItem, HistoryRevision } from '$lib/api/types';
import { fmtDay, fmtNum, fmtPct, localIsoDate } from '$lib/format/number';
import { kindLabel } from '$lib/series/kinds';

/** The filter's event kinds: '' is everything, 'revision' the model and settings, the rest an event noun. */
export const KIND_FILTERS: { value: string; label: string }[] = [
	{ value: '', label: 'All changes' },
	{ value: 'revision', label: 'Model and settings' },
	{ value: 'series', label: 'Data series' },
	{ value: 'run', label: 'Runs' },
	{ value: 'publication', label: 'Publication' },
	{ value: 'member', label: 'Members' },
	{ value: 'farmer', label: 'Farmer links' },
	{ value: 'invite', label: 'Invites' },
	{ value: 'scenario', label: 'Scenarios' },
	{ value: 'pack', label: 'Evidence packs' },
	{ value: 'feed', label: 'Data feeds' },
	{ value: 'report_schedule', label: 'Report schedules' },
	{ value: 'restore', label: 'Restores of data' }
];

const SOURCE_TITLES: Record<HistoryRevision['source'], string> = {
	baseline: 'Starting point',
	model_put: 'Model changed',
	settings_patch: 'Settings changed',
	restore: 'Earlier version restored',
	import: 'Project imported',
	copy: 'Project copied'
};

/** A revision's heading. */
export function revisionTitle(r: HistoryRevision): string {
	return SOURCE_TITLES[r.source] ?? 'Inputs changed';
}

/** The lines a revision shows under its heading. */
export function revisionLines(r: HistoryRevision): string[] {
	if (r.changes.length) return r.changes.map((c) => c.text);
	switch (r.source) {
		case 'baseline':
			return ['The model and settings as they were before the first recorded change.'];
		case 'import':
		case 'copy':
			return ['The project’s first state.'];
		default:
			// The documents differ, but in nothing the change list describes (the order of rows, say).
			return ['Order or detail changes that the change list doesn’t describe.'];
	}
}

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
/** A recorded role value, project or team, by the name the UI gives it (a team `member` is an editor). */
const role = (v: unknown): string => roleLabel(str(v));
/**
 * ", so owner here" when the project role a team role gives reads differently
 * from the team role; nothing when it doesn't, which is every known role today.
 */
const hereToo = (teamRole: unknown, projectRole: unknown): string =>
	!str(projectRole) || role(projectRole) === role(teamRole) ? '' : `, so ${role(projectRole)} here`;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;

const FEEDS: Record<string, string> = { chirps: 'CHIRPS', chirps_gefs: 'CHIRPS-GEFS forecast', dws: 'DWS' };
const feedName = (s: unknown) => FEEDS[str(s)] ?? str(s);

/** "the Rainfall — catchment series", "the Flow — observed gauge “upper” series". */
function seriesName(s: Record<string, unknown>): string {
	const name = str(s.name);
	return `the ${kindLabel(str(s.kind))}${name ? ` “${name}”` : ''} series`;
}

function range(s: Record<string, unknown>): string {
	const from = str(s.from);
	const to = str(s.to);
	return from && to ? ` (${fmtDay(from)} to ${fmtDay(to)})` : '';
}

/** "; now CHIRPS sat v3.0, was CHIRPS v2.0" when a replace changed the series' product or version (032), else ''. */
function versionChange(s: Record<string, unknown>): string {
	const p = s.provenance as Record<string, unknown> | undefined;
	const o = s.origin as Record<string, unknown> | undefined;
	return (
		(p && typeof p === 'object' ? `; now ${str(p.to)}, was ${str(p.from)}` : '') +
		// Where the values came from, or the unit they were given in (107_series_source.sql).
		(o && typeof o === 'object' ? `; source now ${str(o.to)}, was ${str(o.from)}` : '')
	);
}

/** "green under 5 %, amber under 20 % (the defaults)": a team_thresholds.changed side. */
function trafficLights(v: unknown): string {
	const t = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
	const pct = (x: unknown) => `${fmtNum(num(x) ?? 0, 2, true)} %`;
	return `green under ${pct(t.green)}, amber under ${pct(t.amber)}${t.source === 'default' ? ' (the defaults)' : ''}`;
}

const UNLINK_CAUSES: Record<string, string> = {
	model_saved: ' (the hydrological unit was removed, or is no longer a hydrological unit)',
	member_removed: ' (they left, or were removed from the project)',
	restore: ' (by a restore)'
};

/** "named the WUA “Vaalbank WUA”", or "cleared the WUA's name" (095_wua_name). */
const wuaNamePart = (to: unknown) => (str(to) ? `named the WUA “${str(to)}”` : 'cleared the WUA’s name');

/** One sentence for an audit event, without its actor or time. */
/** "evidence pack version 2 (a1b2-c3d4-e5f6)", from a pack event's subject. */
function packName(s: Record<string, unknown>, capital = false): string {
	const v = num(s.version);
	const code = typeof s.shortCode === 'string' ? s.shortCode : '';
	return `${capital ? 'Evidence' : 'evidence'} pack${v ? ` version ${v}` : ''}${code ? ` (${code})` : ''}`;
}

export function eventLine(e: Pick<HistoryEvent, 'kind' | 'subject'>): string {
	const s = e.subject ?? {};
	const who = str(s.displayName) || 'someone';
	switch (e.kind) {
		case 'project.changed': {
			const fields = Array.isArray(s.fields) ? (s.fields as string[]) : [];
			const parts = [
				fields.includes('name') ? `renamed the project from “${str(s.from)}” to “${str(s.to)}”` : '',
				fields.includes('description') ? 'changed the description' : '',
				fields.includes('time_zone') ? `set the time zone to ${str((s.timeZone as { to?: unknown } | undefined)?.to)}` : '',
				fields.includes('wua_name') ? wuaNamePart((s.wuaName as { to?: unknown } | undefined)?.to) : '',
				fields.includes('team') ? (s.team ? `moved the project into the team “${str(s.team)}”` : 'made the project personal') : ''
			].filter(Boolean);
			const text = parts.join(', ') || 'changed the project';
			return text[0]!.toUpperCase() + text.slice(1);
		}
		case 'member.added':
			return s.via === 'invite' ? `${who} joined as ${role(s.role)} (accepted an invite)` : `Added ${who} as ${role(s.role)}`;
		case 'member.removed':
			// accountDeleted: they deleted their account (issue #112), which took them out of every project; the name reads "Deleted user".
			if (s.accountDeleted) return `${who} deleted their account and left the project (${role(s.role)})`;
			return s.self ? `${who} left the project` : `Removed ${who} (${role(s.role)})`;
		case 'member.role':
			return `Changed ${who}’s role from ${role(s.from)} to ${role(s.to)}`;
		case 'member.party':
			return s.to ? `Put ${who} in the applying party ${str(s.to)}` : `Took ${who} out of the applying party ${str(s.from)}`;
		case 'farmer.linked':
			return `Linked ${who} to the hydrological unit ${str(s.nodeName)}${s.cause === 'invite' ? ' (from their invite)' : ''}`;
		case 'farmer.unlinked':
			return `Unlinked ${who} from the hydrological unit ${str(s.nodeName)}${UNLINK_CAUSES[str(s.cause)] ?? ''}`;
		case 'invite.sent':
			return `Invited ${str(s.email)} as ${role(s.role)}`;
		case 'invite.revoked':
			return `Revoked the invite for ${str(s.email)}`;
		case 'invite.declined':
			return `The invite for ${str(s.email)} was declined`;
		case 'publication.published': {
			const r = (s.restriction ?? {}) as Record<string, unknown>;
			const level = str(r.level);
			const pct = num(r.pct);
			const restriction = level && level !== 'none' ? `, ${level}${pct !== null ? ` (${pct} %)` : ''}` : '';
			const farms = num(s.farms);
			return `Published a run${restriction}${farms !== null ? ` to ${plural(farms, 'farm')}` : ''}`;
		}
		case 'publication.notice_changed': {
			const names: Record<string, string> = { note: 'note', restriction: 'restriction notice', nextExpectedOn: 'next publication date' };
			const fields = (Array.isArray(s.fields) ? (s.fields as string[]) : []).map((f) => names[f] ?? f);
			return `Changed the publication’s ${fields.join(' and ') || 'notice'}`;
		}
		case 'series.created':
			return `Added ${seriesName(s)}${range(s)}${s.feedId ? ` from the ${feedName(s.source)} feed` : ''}`;
		case 'series.replaced':
			return `${s.feedId ? `The ${feedName(s.source)} feed replaced` : 'Replaced'} ${seriesName(s)}: ${plural(num(s.daysChanged) ?? 0, 'day')} changed${range(s)}${versionChange(s)}`;
		case 'series.merged':
			return `${s.feedId ? `The ${feedName(s.source)} feed added days to` : 'Merged days into'} ${seriesName(s)}: ${plural(num(s.daysChanged) ?? 0, 'day')} changed`;
		case 'series.deleted':
			return `Deleted ${seriesName(s)}${range(s)}`;
		case 'series.held': {
			// An API key pushed days the data-quality rules flag (backend series/hold.ts): automatic runs wait for a person.
			const parts = [num(s.negative) ? `${plural(num(s.negative)!, 'negative day')}` : '', num(s.outlier) ? `${plural(num(s.outlier)!, 'day')} far above its usual range` : ''].filter(Boolean);
			// limitFrom 'own' (055): no person-made run has read the series yet, so its usual range is the key's own, a weaker check.
			const own = s.limitFrom === 'own' ? ' Its usual range so far is the key’s own: no run of the model has read this series yet.' : '';
			// newSeries (issue #51): the key created the series, which becomes the model's input for its kind; held whatever its days.
			if (s.newSeries === true) {
				const also = parts.length ? ` Some of its days look wrong (${parts.join(', ')}).` : '';
				return `Held automatic runs: an API key added ${seriesName(s)}, which runs will read.${also} Check the data, then run the model`;
			}
			return `Held automatic runs: new days in ${seriesName(s)} look wrong (${parts.join(', ') || 'flagged days'}).${own} Check the data, then run the model`;
		}
		case 'series.unchecked':
			// An API key pushed days into a series too short for the outlier limit (backend series/hold.ts): the
			// automatic run goes on, but isn't published by itself until a person runs the model (operator, 2026-10-01).
			return `Paused automatic publishing: an API key added ${plural(num(s.daysChanged) ?? 0, 'day')} to ${seriesName(s)}, a record too short to check them against its usual range. Automatic runs go on; run the model to publish automatically again`;
		case 'series.labelled': {
			// A source change (107_series_source.sql) has `origin` in place of `provenance`.
			if (s.origin && typeof s.origin === 'object' && !s.provenance) {
				const o = s.origin as Record<string, unknown>;
				return `Recorded the source of ${seriesName(s)}: ${str(o.to)} (was ${str(o.from)})`;
			}
			const p = (s.provenance ?? {}) as Record<string, unknown>;
			return `Marked ${seriesName(s)} as ${str(p.to)} (was ${str(p.from)})`;
		}
		case 'series.site_changed': {
			// A flow record attached to a gauge inside the network, or back to the outlet (084_gauge_records).
			const p = (s.site ?? {}) as Record<string, unknown>;
			const at = (v: unknown) => (str(v) === 'the outlet' ? 'the outlet' : `gauge ${str(v)}`);
			return `Moved ${seriesName(s)} to ${at(p.to)} (was ${at(p.from)})`;
		}
		case 'restore':
			return s.target === 'series' ? `Restored earlier values of ${seriesName(s)}${range(s)}` : 'Restored an earlier version';
		case 'run.created':
			return `${s.application ? 'Ran an application' : s.scenarioId ? 'Ran a scenario' : 'Ran the model'}${str(s.label) ? ` (“${str(s.label)}”)` : ''}`;
		case 'run.changed':
			if (s.pinned === true) return 'Pinned a run';
			if (s.pinned === false) return 'Unpinned a run';
			return 'Edited a run’s notes';
		case 'run.deleted': {
			const n = Array.isArray(s.runIds) ? s.runIds.length : 1;
			return s.reason === 'trimmed' ? `Removed ${plural(n, 'old run')} to stay within the storage cap` : `Deleted the run${str(s.label) ? ` “${str(s.label)}”` : ''}`;
		}
		case 'feed.configured': {
			const feed = `the ${feedName(s.source)} feed`;
			if (s.action === 'created') return `Set up ${feed} into ${seriesName({ kind: s.targetKind, name: s.targetName })}`;
			if (s.action === 'removed') return `Removed ${feed}`;
			// A confirmation to replace its series (issue #40c) is its own sentence: it is why the series will change.
			if (typeof s.replaceSeries === 'string') return `Confirmed that ${feed} replaces ${seriesName({ kind: s.targetKind, name: s.targetName })} at its next fetch`;
			return `Changed ${feed}${s.enabled === false ? ' (switched off)' : ''}`;
		}
		case 'feed.failed':
			return `The ${feedName(s.source)} feed started failing: ${str(s.error)}`;
		case 'report_schedule.configured': {
			const what = `a ${str(s.frequency)} report`;
			if (s.action === 'created') return `Scheduled ${what}`;
			if (s.action === 'removed') return `Removed ${what} schedule`;
			return `Changed ${what} schedule`;
		}
		// An application's events (WP-3.3) carry no name until it is decided: `application: true`.
		case 'scenario.created':
			return s.application ? 'An applicant started an application' : `Created the scenario “${str(s.name)}”`;
		case 'scenario.changed':
			if (s.application) return 'An applicant changed their application';
			return s.to ? `Moved the scenario “${str(s.name)}” from ${str(s.from)} to ${str(s.to)}` : `Changed the scenario “${str(s.name)}”`;
		case 'scenario.deleted':
			return s.application ? 'An applicant deleted an application' : `Deleted the scenario “${str(s.name)}”`;
		case 'signoff.created': {
			// From signoff-3 the event names the category and field too (issue #47); a sign-off of an evidence pack names the pack (112).
			const opt = (v: unknown) => (v ? str(v) : null);
			const what = s.packId ? 'an evidence pack' : 'a run';
			const line = registrationLine(str(s.registrationBody), opt(s.registrationCategory), opt(s.registrationField), str(s.registrationNo));
			return line
				? `Signed off ${what} as ${str(s.fullName)}, ${line}`
				: `Signed off ${what} as ${str(s.fullName)} (${str(s.registrationBody)} ${str(s.registrationNo)})`;
		}
		// An evidence pack's lifecycle (112_evidence_pack, WP-3.14): by version and short code, never a name.
		case 'pack.drafted':
			return `Drafted ${packName(s)}`;
		case 'pack.deleted':
			return `Deleted the draft ${packName(s)}`;
		case 'pack.issued':
			return `Issued ${packName(s)}${num(s.supersedesVersion) ? `, replacing version ${num(s.supersedesVersion)}` : ''}`;
		case 'pack.superseded':
			return `${packName(s, true)} was superseded${num(s.byVersion) ? ` by version ${num(s.byVersion)}` : ''}`;
		case 'pack.withdrawn':
			return `Withdrew ${packName(s)}${str(s.reason) ? `: ${str(s.reason)}` : ''}`;
		case 'calibration_rules.signed_off':
			return `Signed off the calibration rules (revision ${num(s.revision) ?? '?'}) as ${str(s.fullName)}`;
		case 'calibration_rules.sign_off_withdrawn':
			return `Withdrew the sign-off of the calibration rules (revision ${num(s.revision) ?? '?'})`;
		case 'allocation.created':
			return `Added a registered volume${str(s.registrationNo) ? ` (${str(s.registrationNo)})` : ''}`;
		case 'allocation.changed':
			return `Changed a registered volume${str(s.registrationNo) ? ` (${str(s.registrationNo)})` : ''}`;
		case 'allocation.deleted':
			return `Deleted a registered volume${str(s.registrationNo) ? ` (${str(s.registrationNo)})` : ''}`;
		case 'allocation.imported': {
			const n = num(s.rows) ?? 0;
			return `Imported ${plural(n, 'registered volume')} from ${str(s.fileName)}`;
		}
		case 'allocation.import_deleted':
			return `Removed the import of ${str(s.fileName)} and its ${plural(num(s.rows) ?? 0, 'registered volume')}`;
		case 'scenario.submitted':
			return s.application ? 'An applicant submitted an application' : `Submitted the scenario “${str(s.name)}”`;
		case 'scenario.withdrawn':
			return s.application ? 'An applicant withdrew an application' : `Withdrew the scenario “${str(s.name)}”`;
		case 'scenario.reopened':
			return s.application ? 'An applicant reopened an application as a draft' : `Reopened the scenario “${str(s.name)}” as a draft`;
		case 'scenario.decided':
			return `Decided ${s.application ? 'the application' : 'the scenario'} “${str(s.name)}”: ${str(s.outcome).replaceAll('_', ' ')}`;
		case 'scenario.shared':
			return 'Shared an application with another applicant';
		case 'scenario.unshared':
			return s.self ? 'Stopped reading a shared application' : 'Stopped sharing an application';
		case 'share_link.created':
			return s.targetKind === 'scenario' ? 'Created a share link to a scenario' : s.targetKind === 'pack' ? 'Created a share link to an evidence pack' : 'Created a share link';
		case 'share_link.revoked':
			return s.targetKind === 'scenario' ? 'Revoked a share link to a scenario' : s.targetKind === 'pack' ? 'Revoked a share link to an evidence pack' : 'Revoked a share link';
		case 'api_key.created':
			return `Created an API key${str(s.name) ? ` “${str(s.name)}”` : ''}`;
		case 'api_key.revoked':
			return `Revoked an API key${str(s.name) ? ` “${str(s.name)}”` : ''}`;
		// A team admin changed the portfolio's traffic lights (D11, 055): recorded on each team project.
		case 'team_thresholds.changed':
			return `Changed the portfolio traffic lights of the team “${str(s.team)}” from ${trafficLights(s.from)} to ${trafficLights(s.to)}`;
		// Who reaches the project through its team (072): each is recorded on every team project, with the role it gives here.
		case 'team_member.added':
			return s.via === 'invite'
				? `${who} joined the team “${str(s.team)}” as ${role(s.teamRole)} (accepted an invite)${hereToo(s.teamRole, s.role)}`
				: `Added ${who} to the team “${str(s.team)}” as ${role(s.teamRole)}${hereToo(s.teamRole, s.role)}`;
		case 'team_member.role':
			return `Changed ${who}’s role in the team “${str(s.team)}” from ${role(s.from)} to ${role(s.to)}${hereToo(s.to, s.role)}`;
		case 'team_member.removed':
			if (s.accountDeleted) return `${who} deleted their account and left the team “${str(s.team)}”`;
			return s.self ? `${who} left the team “${str(s.team)}”` : `Removed ${who} (${role(s.teamRole)}) from the team “${str(s.team)}”`;
		case 'team.deleted':
			return `Deleted the team “${str(s.team)}”: its ${plural(num(s.members) ?? 0, 'member')} no longer reach this project through it`;
		default:
			return e.kind;
	}
}

/** The series events whose change kept the values it replaced (a series revision): a replace, a person's merge, a delete. */
const SERIES_KEPT = new Set(['series.replaced', 'series.merged', 'series.deleted']);

/**
 * What "Restore the earlier values" puts back for an item: the values a
 * series change replaced, and a restore of them can be undone the same way.
 * Null for a change that kept none (a new series, a feed's or an API key's
 * merge). The server keeps a series' newest 5 for up to 180 days, so an old
 * one may be gone (404).
 */
export function seriesRestore(i: HistoryItem): { seriesId: string; revisionId: string; what: string } | null {
	if (i.type !== 'event') return null;
	const s = i.subject;
	if (!SERIES_KEPT.has(i.kind) && !(i.kind === 'restore' && s.target === 'series')) return null;
	const seriesId = str(s.seriesId);
	const revisionId = str(s.revisionId);
	return seriesId && revisionId ? { seriesId, revisionId, what: seriesName(s) } : null;
}

/** The lines an item shows: a revision's changes, or an event's sentence. */
export const itemLines = (i: HistoryItem): string[] => (i.type === 'revision' ? revisionLines(i) : [eventLine(i)]);

/** One entry of the timeline: the items one request wrote (a change set), newest first. */
export interface HistoryEntry {
	key: string;
	createdAt: string;
	actor: string | null;
	items: HistoryItem[];
	/** The entry's revision, if it has one (what "Restore this version" restores). */
	revision: HistoryRevision | null;
}

/**
 * Fold adjacent items of one change set into one entry. The server returns
 * one change set's items together (they share a timestamp); an item without
 * a change set stands alone.
 */
export function groupByChangeSet(items: readonly HistoryItem[]): HistoryEntry[] {
	const out: HistoryEntry[] = [];
	for (const i of items) {
		const last = out.at(-1);
		if (last && i.changeSet && last.items[0]!.changeSet === i.changeSet) {
			last.items.push(i);
			if (!last.revision && i.type === 'revision') last.revision = i;
			continue;
		}
		out.push({ key: `${i.type}${i.id}`, createdAt: i.createdAt, actor: i.actor, items: [i], revision: i.type === 'revision' ? i : null });
	}
	return out;
}

/** The viewer's calendar day of a timestamp (YYYY-MM-DD), not the UTC one. */
export const localDay = (iso: string): string => localIsoDate(new Date(iso));

/** "14:05" in the viewer's time zone. */
export function localTime(iso: string): string {
	const d = new Date(iso);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export interface HistoryDay {
	day: string;
	label: string;
	entries: HistoryEntry[];
}

/** Entries by the viewer's calendar day, newest first: "Today", "Yesterday", then "3 Sep 2026". */
export function groupByDay(entries: readonly HistoryEntry[], now: Date = new Date()): HistoryDay[] {
	const today = localIsoDate(now);
	const y = new Date(now);
	y.setDate(y.getDate() - 1);
	const yesterday = localIsoDate(y);
	const out: HistoryDay[] = [];
	for (const e of entries) {
		const day = localDay(e.createdAt);
		const last = out.at(-1);
		if (last?.day === day) last.entries.push(e);
		else out.push({ day, label: day === today ? 'Today' : day === yesterday ? 'Yesterday' : fmtDay(day), entries: [e] });
	}
	return out;
}

/**
 * The parameter filter: entries with a line that mentions the words (any
 * order, any case), and only those lines of a revision, so "dam capacity"
 * shows just the dam-capacity lines of a save that changed more.
 */
export function filterEntries(entries: readonly HistoryEntry[], query: string): HistoryEntry[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return [...entries];
	const hit = (line: string) => words.every((w) => line.toLowerCase().includes(w));
	return entries.flatMap((e) => {
		const items = e.items.flatMap((i): HistoryItem[] => {
			if (i.type === 'event') return hit(eventLine(i)) ? [i] : [];
			const changes = i.changes.filter((c) => hit(c.text));
			return changes.length ? [{ ...i, changes }] : [];
		});
		return items.length ? [{ ...e, items, revision: e.revision && items.some((i) => i.type === 'revision') ? e.revision : null }] : [];
	});
}

// --- The page (issue #17): the filters in the URL, the list's rows, the picked entry, the header's line ---

/** The kind filter from the URL (`kind=`): one of `KIND_FILTERS`, else '' (every kind). */
export function parseKind(v: string | null): string {
	return v && KIND_FILTERS.some((k) => k.value === v) ? v : '';
}

/** An entry's row in the list: what it was, its first line, how many more lines it has, and whether it gives a reason. */
export function entrySummary(e: HistoryEntry): { title: string; line: string; more: number; reason: boolean } {
	const lines = e.items.flatMap((i) => itemLines(i));
	const reason = e.items.some((i) => i.type === 'revision' && !!i.reason);
	if (e.revision) return { title: revisionTitle(e.revision), line: lines[0] ?? '', more: Math.max(0, lines.length - 1), reason };
	// An event is its own sentence: the title, with any others of its change set counted.
	return { title: lines[0] ?? '', line: '', more: Math.max(0, lines.length - 1), reason };
}

/** The picked entry's heading: a revision's title, else what kind of change it is ("Data series", "Members"), else "Change". */
export function entryHeading(e: HistoryEntry): string {
	if (e.revision) return revisionTitle(e.revision);
	const first = e.items[0];
	const noun = first?.type === 'event' ? first.kind.split('.')[0] : '';
	return KIND_FILTERS.find((k) => k.value && k.value === noun)?.label ?? 'Change';
}

/** The entry `key` names (the URL's `entry=`), else the newest; null when there are none. */
export function pickEntry(entries: readonly HistoryEntry[], key: string | null): HistoryEntry | null {
	return (key ? entries.find((e) => e.key === key) : undefined) ?? entries[0] ?? null;
}

/** "today 14:05", "yesterday 09:30", "3 Sep 2026 14:05", in the viewer's time zone. */
export function whenText(iso: string, now: Date = new Date()): string {
	const day = localDay(iso);
	const y = new Date(now);
	y.setDate(y.getDate() - 1);
	const label = day === localIsoDate(now) ? 'today' : day === localIsoDate(y) ? 'yesterday' : fmtDay(day);
	return `${label} ${localTime(iso)}`;
}

/**
 * The section header's line, the fact the page is opened for: the latest
 * change, who made it and when, and since when changes are recorded.
 * "Latest change today 14:05 by Ann: Model changed · recorded since 3 Sep 2026",
 * "No changes recorded yet · recorded since 3 Sep 2026".
 */
export function historyContext(latest: HistoryEntry | null, since: string | null, now: Date = new Date()): string {
	const from = since ? ` · recorded since ${fmtDay(localDay(since))}` : '';
	if (!latest) return `No changes recorded yet${from}`;
	const { title } = entrySummary(latest);
	return `Latest change ${whenText(latest.createdAt, now)} by ${latest.actor ?? 'a deleted account'}: ${title}${from}`;
}

/** One hydrological unit's line in a publication's record: its own figures (backend publish/decision.ts DecisionFarm), formatted. */
export interface PublicationRecordFarm {
	/** The unit's id, or its position when the record holds none (the row's key). */
	key: string;
	name: string;
	/** Supplied ÷ demand over the season, "92%". */
	supplied: string;
	/** "900 / 1 000" (m³). */
	volumes: string;
	shortDays: string;
	/** The dam on dataUntil, "64%"; "–" without a dam. */
	dam: string;
	/** The model's band in words (OK, Watch, Short); "–" without one. */
	band: string;
}

/**
 * The season decision log's detail under a publication event (issue #119):
 * the restriction, the window, the run (engine version, inputs hash), the
 * notice in every language it was written in, the next date, the note, and
 * each hydrological unit's own figures, least supplied first. null for any
 * other event, and for an event recorded before the log widened (it holds
 * only the level, % and farm count, which the event's line already says).
 */
export interface PublicationRecord {
	lines: string[];
	notices: { language: string; text: string }[];
	farms: PublicationRecordFarm[];
}

const BAND_WORDS: Record<string, string> = { ok: 'OK', watch: 'Watch', short: 'Short' };
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** A notice's language code by its name ("Afrikaans"); a code the table no longer lists as itself. */
const languageName = (code: string): string => {
	const l = language(code);
	return l.code === code ? l.name : code;
};
/** The language table's order (English first), codes it no longer lists last: jsonb stores keys shortest first, then alphabetically. */
const languageRank = (code: string): number => {
	const i = (LOCALES as readonly string[]).indexOf(code);
	return i < 0 ? LOCALES.length : i;
};

export function publicationRecord(e: HistoryEvent): PublicationRecord | null {
	if (e.kind !== 'publication.published' && e.kind !== 'publication.notice_changed') return null;
	const s = e.subject;
	const lines: string[] = [];
	const r = rec(s.restriction);
	// The published event's line already says the level; a change's line doesn't.
	if (e.kind === 'publication.notice_changed' && 'notice' in r) {
		const pct = num(r.pct);
		lines.push(str(r.level) && str(r.level) !== 'none' ? `Restriction: ${str(r.level)}${pct !== null ? ` (${pct} %)` : ''}` : 'No restriction');
	}
	const w = rec(s.window);
	const season = rec(w.season);
	if (str(season.from) && str(season.to)) {
		const until = str(w.dataUntil);
		lines.push(
			`Season ${fmtDay(str(season.from))} to ${fmtDay(str(season.to))}${until && until !== str(season.to) ? `, data to ${fmtDay(until)}` : ''}${str(w.runStart) ? `; the run from ${fmtDay(str(w.runStart))}` : ''}`
		);
	}
	if (str(s.engineVersion)) {
		lines.push(`Run ${str(s.runId)}, engine ${str(s.engineVersion)}${str(s.runoffModel) ? ` (${str(s.runoffModel)})` : ''}`);
	}
	if (str(s.inputsSha256)) lines.push(`Inputs SHA-256 ${str(s.inputsSha256)}`);
	const notice = rec(r.notice);
	const notices = Object.entries(notice)
		.filter(([, t]) => typeof t === 'string' && t)
		.sort(([a], [b]) => languageRank(a) - languageRank(b))
		.map(([code, t]) => ({ language: languageName(code), text: t as string }));
	if ('notice' in r && !notices.length) lines.push('No notice text');
	if ('nextExpectedOn' in s) lines.push(s.nextExpectedOn ? `Next publication expected ${fmtDay(str(s.nextExpectedOn))}` : 'No next publication date');
	if (str(s.note)) lines.push(`Note: ${str(s.note)}`);
	const farms = (Array.isArray(s.perFarm) ? s.perFarm : [])
		.map((raw, i) => {
			const f = rec(raw);
			const fs = rec(f.season);
			const fraction = num(fs.fraction);
			const row: PublicationRecordFarm = {
				key: str(f.nodeId) || `#${i}`,
				name: str(f.name),
				supplied: fmtPct(fraction, 0),
				volumes: `${fmtNum(num(fs.suppliedM3))} / ${fmtNum(num(fs.demandM3))}`,
				shortDays: fmtNum(num(fs.shortDays)),
				dam: fmtPct(num(f.damPct), 0),
				band: BAND_WORDS[str(rec(f.model).band)] ?? '–'
			};
			return { row, fraction };
		})
		// Least supplied first, a unit without a share (no demand) last; then by name.
		.sort((a, b) => (a.fraction ?? Infinity) - (b.fraction ?? Infinity) || a.row.name.localeCompare(b.row.name))
		.map((x) => x.row);
	return lines.length || notices.length || farms.length ? { lines, notices, farms } : null;
}
