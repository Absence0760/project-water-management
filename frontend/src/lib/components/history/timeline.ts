// The History tab's pure logic (WP-2.4, docs/ui.md § History): what each
// item says, grouping one request's items (a change set) into one entry, and
// entries into the viewer's calendar days. No DOM, no fetch.
import type { HistoryEvent, HistoryItem, HistoryRevision } from '$lib/api/types';
import { fmtDay, fmtNum, localIsoDate } from '$lib/format/number';
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
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-ZA')} ${n === 1 ? one : many}`;

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
	return p && typeof p === 'object' ? `; now ${str(p.to)}, was ${str(p.from)}` : '';
}

/** "green under 5 %, amber under 20 % (the defaults)": a team_thresholds.changed side. */
function trafficLights(v: unknown): string {
	const t = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
	const pct = (x: unknown) => `${fmtNum(num(x) ?? 0, 2, true)} %`;
	return `green under ${pct(t.green)}, amber under ${pct(t.amber)}${t.source === 'default' ? ' (the defaults)' : ''}`;
}

const UNLINK_CAUSES: Record<string, string> = {
	model_saved: ' (the farm was removed, or is no longer a farm)',
	member_removed: ' (they left, or were removed from the project)',
	restore: ' (by a restore)'
};

/** One sentence for an audit event, without its actor or time. */
export function eventLine(e: Pick<HistoryEvent, 'kind' | 'subject'>): string {
	const s = e.subject ?? {};
	const who = str(s.displayName) || 'someone';
	switch (e.kind) {
		case 'project.changed': {
			const fields = Array.isArray(s.fields) ? (s.fields as string[]) : [];
			const parts = [
				fields.includes('name') ? `renamed the project from “${str(s.from)}” to “${str(s.to)}”` : '',
				fields.includes('description') ? 'changed the description' : '',
				fields.includes('team') ? (s.team ? `moved the project into the team “${str(s.team)}”` : 'made the project personal') : ''
			].filter(Boolean);
			const text = parts.join(', ') || 'changed the project';
			return text[0]!.toUpperCase() + text.slice(1);
		}
		case 'member.added':
			return s.via === 'invite' ? `${who} joined as ${str(s.role)} (accepted an invite)` : `Added ${who} as ${str(s.role)}`;
		case 'member.removed':
			return s.self ? `${who} left the project` : `Removed ${who} (${str(s.role)})`;
		case 'member.role':
			return `Changed ${who}’s role from ${str(s.from)} to ${str(s.to)}`;
		case 'member.party':
			return s.to ? `Put ${who} in the applying party ${str(s.to)}` : `Took ${who} out of the applying party ${str(s.from)}`;
		case 'farmer.linked':
			return `Linked ${who} to the farm ${str(s.nodeName)}${s.cause === 'invite' ? ' (from their invite)' : ''}`;
		case 'farmer.unlinked':
			return `Unlinked ${who} from the farm ${str(s.nodeName)}${UNLINK_CAUSES[str(s.cause)] ?? ''}`;
		case 'invite.sent':
			return `Invited ${str(s.email)} as ${str(s.role)}`;
		case 'invite.revoked':
			return `Revoked the invite for ${str(s.email)}`;
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
			return `Held automatic runs: new days in ${seriesName(s)} look wrong (${parts.join(', ') || 'flagged days'}).${own} Check the data, then run the model`;
		}
		case 'series.labelled': {
			const p = (s.provenance ?? {}) as Record<string, unknown>;
			return `Marked ${seriesName(s)} as ${str(p.to)} (was ${str(p.from)})`;
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
		case 'signoff.created':
			return `Signed off a run as ${str(s.fullName)} (${str(s.registrationBody)} ${str(s.registrationNo)})`;
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
			return 'Created a share link';
		case 'share_link.revoked':
			return 'Revoked a share link';
		case 'api_key.created':
			return `Created an API key${str(s.name) ? ` “${str(s.name)}”` : ''}`;
		case 'api_key.revoked':
			return `Revoked an API key${str(s.name) ? ` “${str(s.name)}”` : ''}`;
		// A team admin changed the portfolio's traffic lights (D11, 055): recorded on each team project.
		case 'team_thresholds.changed':
			return `Changed the portfolio traffic lights of the team “${str(s.team)}” from ${trafficLights(s.from)} to ${trafficLights(s.to)}`;
		default:
			return e.kind;
	}
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
