// Which workspace tabs each role is shown (issue #6, followups.md § Roles and
// what each member sees). Presentation only: RLS still lets a viewer read every
// input, so a hidden tab still opens from a deep link (`?tab=settings`) and
// nothing is hidden "for privacy" here. Data a role must not see needs RLS.
//
// One entry per tab. Adding a tab is one line in TAB_GROUP; the page decides
// the order and which tabs it renders, and passes those ids in.
import type { Role } from '$lib/api/types';

/**
 * - `core`: every member sees it (Overview, results, data).
 * - `inputs`: the model inputs. Editors and owners see them; a viewer sees
 *   them behind "Show model inputs".
 * - `assess`: the assessors' work (the Applications list, WP-3.3). Editors
 *   and owners only; the API refuses a viewer anyway.
 */
export type TabGroup = 'core' | 'inputs' | 'assess';

export const TAB_GROUP = {
	overview: 'core',
	network: 'inputs',
	crops: 'inputs',
	transfers: 'inputs',
	series: 'core',
	settings: 'inputs',
	runs: 'core',
	// One run's river against its EWR (issue #17, option A): the Runs tab's River & Reserve group, moved.
	river: 'core',
	// Each unit's supply against its demand, curtailment and assurance of supply for a run (issue #17 option A · Outcomes): anyone who can read runs.
	supply: 'core',
	// Each dam's level and storage in the latest run (issue #17 option A · Outcomes): anyone who can read runs.
	dams: 'core',
	// Two runs side by side (the /compare page's view, issue #17): anyone who can read runs.
	compare: 'core',
	// Viewers can read scenarios (and compare them with the base run).
	scenarios: 'core',
	// Registered volumes vs modelled use (WP-3.10): viewers read volumes, not names.
	allocations: 'core',
	// What the project is and who can open it (issue #17 option A): the model's facts, details, import
	// record, notes, team, members, farmers and share links, moved from below the Summary's first screen.
	project: 'core',
	// Submitted applications, for the assessors to decide (WP-3.3).
	applications: 'assess',
	// The change log of the inputs, with restore actions a viewer can't use.
	history: 'inputs'
} as const satisfies Record<string, TabGroup>;

export type TabId = keyof typeof TAB_GROUP;

/**
 * Each tab's name, as the workspace's sidebar and the help pages show it
 * (lib/help/guides.ts TAB_TITLES picks from this), so a rename is one line.
 */
export const TAB_LABELS: Record<TabId, string> = {
	overview: 'Summary',
	network: 'Network',
	crops: 'Crops & demand',
	transfers: 'Transfers',
	series: 'Data',
	settings: 'Settings & calibration',
	runs: 'Runs & results',
	river: 'River & reserve',
	supply: 'Hydrological units',
	dams: 'Dams',
	compare: 'Compare runs',
	scenarios: 'Scenarios',
	allocations: 'Allocations',
	project: 'Project',
	applications: 'Applications',
	history: 'History'
};

/** Every known tab, in workflow order. */
export const ALL_TABS = Object.keys(TAB_GROUP) as TabId[];

/** The tab that can never be hidden: the project's landing page. */
export const ALWAYS_SHOWN: TabId = 'overview';

/**
 * Whether a viewer sees the model-input tabs before turning the toggle on.
 * A client question (followups.md), so a single constant: flip it here.
 */
export const VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT = false;

/**
 * The sections hidden from the sidebar until a person chooses their own
 * (their saved `hiddenTabs` is null: never chosen, or "Reset to default"):
 * the ones most days don't need. History is the model's change log,
 * Allocations the registered-volume comparison and Applications the
 * licensing inbox. Each still opens from a link and is one tick away in
 * Choose sections.
 */
export const DEFAULT_HIDDEN_TABS: readonly TabId[] = ['allocations', 'applications', 'history'];

/** The sections a person hides: their own choice, or the default when they never made one (null). */
export function hiddenChoice(stored: readonly string[] | null | undefined): readonly string[] {
	return stored ?? DEFAULT_HIDDEN_TABS;
}

export interface TabPrefs {
	/** A viewer's "Show model inputs" toggle. Undefined → the default above. */
	showModelInputs?: boolean;
	/**
	 * The sections this person hid from their sidebar (their own choice, kept
	 * in their account's preferences: `user.preferences.hiddenTabs`). Within
	 * what the role sees; the Summary is never hidden. Ids the role doesn't
	 * see, or no tab has, are ignored.
	 */
	hidden?: readonly string[];
}

/** True when this role gets the "Show model inputs" toggle at all. */
export function hasModelInputsToggle(role: Role | null | undefined): boolean {
	return role === 'viewer';
}

function groupOf(id: string): TabGroup {
	// A tab this table doesn't know yet counts as an input: shown to editors
	// and owners, and to viewers only behind the toggle.
	return Object.hasOwn(TAB_GROUP, id) ? TAB_GROUP[id as TabId] : 'inputs';
}

/**
 * The tabs to show, in the order of `rendered` (the tabs the page renders,
 * all known tabs by default). Owners and editors see every tab. A viewer sees
 * the core tabs, plus the model inputs when `prefs.showModelInputs` is on.
 * Anyone else (a farmer, whom the workspace redirects to the farm view, an
 * applicant, whom it shows the Applicant view, or no role yet) sees Overview
 * only. Then the sections the person hid themselves (`prefs.hidden`) go.
 * Overview is always included when rendered.
 */
export function visibleTabs<T extends string = TabId>(
	role: Role | null | undefined,
	prefs: TabPrefs = {},
	rendered: readonly T[] = ALL_TABS as readonly string[] as readonly T[]
): T[] {
	const seesInputs =
		role === 'owner' ||
		role === 'editor' ||
		(role === 'viewer' && (prefs.showModelInputs ?? VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT));
	const seesCore = role === 'owner' || role === 'editor' || role === 'viewer';
	const assesses = role === 'owner' || role === 'editor';
	const hidden = prefs.hidden ?? [];
	return rendered.filter((id) => {
		if (id === ALWAYS_SHOWN) return true;
		if (hidden.includes(id)) return false;
		const g = groupOf(id);
		return g === 'inputs' ? seesInputs : g === 'assess' ? assesses : seesCore;
	});
}

/**
 * The sections a person hid that their role would show here (`roleTabs`,
 * `visibleTabs` without `hidden`), in that order: the "Hidden (n)" menu's
 * count. A hidden id the role doesn't see here isn't counted (it is kept for
 * the catchments where it does).
 */
export function hiddenTabs<T extends string>(roleTabs: readonly T[], hidden: readonly string[] | undefined): T[] {
	return roleTabs.filter((id) => id !== ALWAYS_SHOWN && (hidden ?? []).includes(id));
}

/**
 * `hidden` with `id` hidden or shown again, as the account stores it: each id
 * once, never the Summary.
 */
export function withTabHidden(hidden: readonly string[] | undefined, id: string, hide: boolean): string[] {
	const rest = (hidden ?? []).filter((x) => x !== id && x !== ALWAYS_SHOWN);
	return hide && id !== ALWAYS_SHOWN ? [...rest, id] : rest;
}

/**
 * Whether `role` may open tab `id` at all, from a link as well as the
 * sidebar. Hiding is presentation (a viewer's hidden model inputs still open
 * from a deep link), except for the assessors' tabs, which the API refuses a
 * viewer: an old or shared `?tab=applications` link lands on the Summary
 * instead of an error.
 */
export function canOpenTab(role: Role | null | undefined, id: string): boolean {
	return groupOf(id) !== 'assess' || role === 'owner' || role === 'editor';
}

/**
 * The strip's tabs: `visible`, plus the open tab when a deep link opened one
 * that is hidden, in its `rendered` place, so the strip always shows where you
 * are (and the tab body's aria-labelledby has its tab).
 */
export function stripTabs<T extends string>(visible: readonly T[], open: T, rendered: readonly T[]): T[] {
	if (visible.includes(open) || !rendered.includes(open)) return [...visible];
	return rendered.filter((id) => id === open || visible.includes(id));
}

/**
 * The sidebar's sections: what the model produced, then what it is made of,
 * then the review work. Outcomes leads because a project opens on its Summary
 * (issue #17's option A; issue #162 restored it after the 2026-09-27 order put
 * it last, below the page you land on), and Help's "Getting around a project"
 * lists them in this order. Purely layout: which tabs a role sees is still
 * `visibleTabs`, and the URLs stay `?tab=<id>`.
 */
export const NAV_SECTIONS = [
	{ id: 'outcomes', label: 'Outcomes', tabs: ['overview', 'river', 'supply', 'runs', 'dams', 'compare', 'scenarios', 'allocations'] },
	{ id: 'model', label: 'Build the model', tabs: ['network', 'crops', 'transfers', 'series', 'settings'] },
	{ id: 'review', label: 'Review', tabs: ['project', 'applications', 'history'] }
] as const satisfies readonly { id: string; label: string; tabs: readonly TabId[] }[];

export type NavSectionId = (typeof NAV_SECTIONS)[number]['id'];

export interface NavSection<T extends string> {
	id: NavSectionId;
	label: string;
	tabs: T[];
}

/**
 * `shown` split into the sidebar's sections, in section order and, inside a
 * section, in `NAV_SECTIONS` order. Empty sections are dropped. A tab no
 * section lists goes at the end of "Build the model", as `groupOf` counts an
 * unknown tab as an input.
 */
export function navSections<T extends string>(shown: readonly T[]): NavSection<T>[] {
	const known = new Set<string>(NAV_SECTIONS.flatMap((s) => s.tabs));
	return NAV_SECTIONS.map((s) => {
		const listed = (s.tabs as readonly string[]).filter((id) => shown.includes(id as T)) as T[];
		const extra = s.id === 'model' ? shown.filter((id) => !known.has(id)) : [];
		return { id: s.id, label: s.label, tabs: [...listed, ...extra] };
	}).filter((s) => s.tabs.length > 0);
}
