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
 */
export type TabGroup = 'core' | 'inputs';

export const TAB_GROUP = {
	overview: 'core',
	network: 'inputs',
	crops: 'inputs',
	transfers: 'inputs',
	series: 'core',
	settings: 'inputs',
	runs: 'core',
	// Viewers can read scenarios (and compare them with the base run).
	scenarios: 'core',
	// Registered volumes vs modelled use (WP-3.10): viewers read volumes, not names.
	allocations: 'core',
	// The change log of the inputs, with restore actions a viewer can't use.
	history: 'inputs'
} as const satisfies Record<string, TabGroup>;

export type TabId = keyof typeof TAB_GROUP;

/** Every known tab, in workflow order. */
export const ALL_TABS = Object.keys(TAB_GROUP) as TabId[];

/** The tab that can never be hidden: the project's landing page. */
export const ALWAYS_SHOWN: TabId = 'overview';

/**
 * Whether a viewer sees the model-input tabs before turning the toggle on.
 * A client question (followups.md), so a single constant: flip it here.
 */
export const VIEWER_SEES_MODEL_INPUTS_BY_DEFAULT = false;

export interface TabPrefs {
	/** A viewer's "Show model inputs" toggle. Undefined → the default above. */
	showModelInputs?: boolean;
	// "Members choose their own tabs" (app_user.preferences) will add its
	// hidden-tab list here; it is out of scope for now.
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
 * Anyone else (a farmer, whom the workspace redirects to the farm view, or no
 * role yet) sees Overview only. Overview is always included when rendered.
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
	return rendered.filter((id) => {
		if (id === ALWAYS_SHOWN) return true;
		const g = groupOf(id);
		return g === 'inputs' ? seesInputs : seesCore;
	});
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
