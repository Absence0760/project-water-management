// The settings' unsaved edits, on both pages that edit them: Model settings
// (SettingsTab.svelte) and Calibration's "Set up the fit"
// (CalibrationSettings.svelte, issue #586 round 3). The workspace page holds
// it (routes/projects/[id]/+page.svelte), not either tab, as it holds the
// project details (project/detailsDraft.svelte.ts): the edits survive a tab
// change, so an edit on one page and one on the other are one draft; the
// page's one save bar saves or discards them with the model and the details;
// the leave guard and the header's "Unsaved changes" count them; and their
// problems are links in the bar, each to its panel on its page. The tabs edit
// `s` in place; what blocks the save (`blockers`) is worked out here, from `s`
// and the sections' reported `errors` (blockers.ts), so it holds whichever
// page is shown; the page saves `snapshot()`.
import type { CalibrationParams, ChirpsQuantileMap, ProjectSettings } from '@water-management/engine';
import type { AutoRunSettings, EwrHeadline, OutcomeSettings, OutlookSettings } from '#lib/api/types.js';
import { resolveAutoRun } from '#lib/components/autorun/autoRun.js';
import { resolveOutcomes } from '#lib/components/outcomes/outcomeSettings.js';
import { resolveOutlook } from '#lib/components/outlook/settings.js';
import { resolveEwrHeadline } from '#lib/components/ewr/headline.js';
import type { EditableArealRain } from './arealRain';
import type { EditablePe } from './peInput';
import { settingsBlockers } from './blockers';

/** Mutable view of the settings (the engine's Monthly type is a readonly tuple). */
export type EditableSettings = Omit<ProjectSettings, 'apanMm' | 'ewrPragmaticM3PerDay' | 'panCoefficient' | 'calibration' | 'pe' | 'lakeEvapFactorMonthly'> & {
	apanMm: number[];
	/** Monthly lake factors (WP-3.5); null = lakeEvapFactor in every month. */
	lakeEvapFactorMonthly?: number[] | null;
	ewrPragmaticM3PerDay: number[];
	panCoefficient: number[];
	calibration: CalibrationParams & Record<string, unknown>;
	/** Absent on settings saved before engine 0.31.0: pan coefficient × A-pan. */
	pe?: EditablePe;
	/** When the project re-runs itself after new data (WP-2.11); defaults filled in for an older API. */
	autoRun: AutoRunSettings;
	/** How the outcome matrix reads a sweep (issue #53 R4); defaults filled in for an older API. */
	outcomes: OutcomeSettings;
	/** How a seasonal outlook is set up (issue #53 R5); defaults filled in for an older API. */
	outlook: OutlookSettings;
	/** Which EWR test the results are judged by (issue #444); `auto` for an older API. */
	ewrHeadline: EwrHeadline;
};

type SavedSettings = ProjectSettings & { autoRun?: Partial<AutoRunSettings>; outcomes?: OutcomeSettings; outlook?: OutlookSettings; ewrHeadline?: EwrHeadline };

/** A deep copy the form can edit, with the defaults an older API leaves out filled in. */
export function editableSettings(v: SavedSettings): EditableSettings {
	const c = JSON.parse(JSON.stringify(v)) as EditableSettings;
	c.autoRun = resolveAutoRun(v);
	c.outcomes = resolveOutcomes(v);
	c.outlook = resolveOutlook(v);
	c.ewrHeadline = resolveEwrHeadline(v);
	return c;
}

/**
 * The form after the saved settings changed under it (another tab or a team
 * member saved, a fit was applied, the form's own save came back): the new
 * saved settings, with the top-level settings the form changed from `before`
 * kept as the form has them. Settings it didn't touch follow the new save, so
 * a save of the form never puts back a setting someone else changed. A
 * setting both changed is the form's, unless `prefer` is 'saved' (an applied
 * fit or proposal, which the person asked for: its values show).
 *
 * The unit is a top-level setting: an edit anywhere in a nested one
 * (`calibration`, `gr4j`, `pe`) keeps that whole object. Deliberately: their
 * fields go together (a fit's parameter set, a PE kind and its values), and
 * merging them field by field could make a combination neither side wrote.
 */
export function rebaseSettings(draft: EditableSettings, before: EditableSettings, after: EditableSettings, prefer: 'draft' | 'saved' = 'draft'): EditableSettings {
	const out = JSON.parse(JSON.stringify(after)) as Record<string, unknown>;
	const d = draft as unknown as Record<string, unknown>;
	const b = before as unknown as Record<string, unknown>;
	const a = after as unknown as Record<string, unknown>;
	for (const k of new Set([...Object.keys(d), ...Object.keys(b)])) {
		if (JSON.stringify(d[k]) === JSON.stringify(b[k])) continue;
		if (prefer === 'saved' && JSON.stringify(a[k]) !== JSON.stringify(b[k])) continue;
		if (d[k] === undefined) delete out[k];
		else out[k] = JSON.parse(JSON.stringify(d[k]));
	}
	return out as unknown as EditableSettings;
}

/**
 * The settings a patch replaces whole rather than merging one level deep: the server's own list
 * (backend/src/projects/settings.ts REPLACED_WHOLE, which settingsDraft.test.ts checks this against).
 */
export const PATCH_REPLACED_WHOLE: ReadonlySet<string> = new Set([
	'fitRecord',
	'pe',
	'arealRain',
	'chirpsQuantileMap',
	'gapRain',
	'calibrationRules',
	'evidenceUncertaintyRule',
	'droughtRestriction',
	'ewrHeadline',
	'ewrDailySource',
	'unitRain',
	'rainStations',
	'flowMissing'
]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * `settings` with a settings patch over it, as the project save applies one (patchSettings): a top-level
 * setting replaces, and a nested object (gr4j, dataQuality, wr2012, …) merges one level deep, except the
 * ones the server replaces whole (PATCH_REPLACED_WHOLE). A deep copy; neither argument changes.
 */
export function withPatch(settings: EditableSettings, patch: Record<string, unknown>): EditableSettings {
	const out = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
	for (const [k, v] of Object.entries(patch)) {
		const copy = v === undefined ? undefined : (JSON.parse(JSON.stringify(v)) as unknown);
		out[k] = !PATCH_REPLACED_WHOLE.has(k) && isObj(copy) && isObj(out[k]) ? { ...(out[k] as Record<string, unknown>), ...copy } : copy;
	}
	return out as unknown as EditableSettings;
}

/** The problems child sections report through `bind:error` (each its own check). */
export const CHILD_ERRORS = [
	'calWindow',
	'exclusions',
	'flowMissing',
	'lowFlow',
	'qualityFlags',
	'rules',
	'zeroRain',
	'fitPeriod',
	'rainSource',
	'rainUnreliable',
	'wr2012',
	'reserve',
	'evidence',
	'restrict',
	'ewrSource'
] as const;
export type ChildError = (typeof CHILD_ERRORS)[number];

const noErrors = (): Record<ChildError, string | null> => Object.fromEntries(CHILD_ERRORS.map((k) => [k, null])) as Record<ChildError, string | null>;

export class SettingsDraft {
	/** The form's settings, edited in place by the Settings tab. */
	s = $state<EditableSettings>({} as EditableSettings);
	/** The saved settings as the form copies them (JSON), what `dirty` compares with. */
	#saved = $state('{}');
	/** Parsed once per save, for the parts of the form that read the saved value (the evidence rule, automated calibration's rules). */
	readonly saved = $derived(JSON.parse(this.#saved) as ProjectSettings);
	/** GR4J's X2 is fixed at 0 unless this is ticked. */
	x2Open = $state(false);
	/**
	 * What a switch turned off, kept until the form is saved or discarded, so
	 * switching it back on brings it back: GR4J's monthly PE row, the areal
	 * correction, the CHIRPS gap map's threshold, the monthly lake factors.
	 */
	lastMonthlyPe = $state<EditablePe | null>(null);
	lastAreal = $state<EditableArealRain | null>(null);
	lastGapMap = $state<ChirpsQuantileMap | null>(null);
	lastLakeMonthly = $state<number[] | null>(null);
	/**
	 * The same for the sections' own switches, by section (bind:last): the
	 * WR2012 reference and its MAR band, the evidence rule, the flow gaps and
	 * automated calibration's flagged-days share.
	 */
	kept = $state<Record<string, unknown>>({});
	saving = $state(false);
	saveError = $state<string | null>(null);
	/** The child sections' problems (their `bind:error`), kept here so they outlive the tab. */
	errors = $state(noErrors());
	/** Whether the saved settings have loaded (before, `s` is empty and nothing is checked). */
	#loaded = $state(false);
	/** What blocks a save, by panel in page order (Model settings', then Calibration's), whichever page is shown. */
	readonly blockers = $derived(this.#loaded ? settingsBlockers(this.s, this.errors) : []);

	/** Start over from the saved settings (the project loaded, saved, or a fit was applied). */
	load(settings: SavedSettings): void {
		const c = editableSettings(settings);
		this.#saved = JSON.stringify(c);
		this.s = editableSettings(settings);
		this.#loaded = true;
		this.#reset();
	}

	/**
	 * The saved settings changed elsewhere: they follow it, and the form keeps its own edits (rebaseSettings).
	 * `prefer: 'saved'` after an applied fit or proposal: a setting it changed shows its value even over an
	 * edit typed while it was applied.
	 */
	rebase(settings: SavedSettings, prefer: 'draft' | 'saved' = 'draft'): void {
		if (!this.dirty) {
			this.load(settings);
			return;
		}
		const before = JSON.parse(this.#saved) as EditableSettings;
		const after = editableSettings(settings);
		this.s = rebaseSettings($state.snapshot(this.s) as EditableSettings, before, after, prefer);
		this.#saved = JSON.stringify(after);
		this.#openX2();
	}

	/**
	 * The form's save came back: `sent` is the `snapshot()` the server saved, `settings` what it now holds.
	 * Edits typed while the save was in flight (the form differs from `sent`) stay unsaved; everything else
	 * takes the server's value. With none, the form starts over as after a load.
	 */
	afterSave(sent: ProjectSettings, settings: SavedSettings): void {
		const after = editableSettings(settings);
		this.s = rebaseSettings($state.snapshot(this.s) as EditableSettings, editableSettings(sent), after);
		this.#saved = JSON.stringify(after);
		if (!this.dirty) this.#reset();
		else {
			this.saveError = null;
			this.#openX2();
		}
	}

	/**
	 * A recommended change (the assistant's proposal, issue #610) put into the form, unsaved: its settings take
	 * the patch's values over the saved ones and over any edit typed to them (the person asked for it), every
	 * other edit stays, and the person saves it with the normal Save (or discards it). Nothing is sent here.
	 */
	applyPatch(patch: Record<string, unknown>): void {
		this.s = withPatch($state.snapshot(this.s) as EditableSettings, patch);
		this.saveError = null;
		this.#openX2();
	}

	/**
	 * Read the saved settings and the form in another shape that means the same, so it isn't an edit: the
	 * Calibration page reads settings from before engine 1.110.0 as calibration locations (issue #659,
	 * calibration/zones.ts normalizedLocations), on both, so the form is never dirty for it. `f` must return its
	 * argument (the same object) when there is nothing to change.
	 */
	adopt(f: (s: EditableSettings) => EditableSettings): void {
		const saved = JSON.parse(this.#saved) as EditableSettings;
		const next = f(saved);
		if (next !== saved) this.#saved = JSON.stringify(next);
		const form = $state.snapshot(this.s) as EditableSettings;
		const nextForm = f(form);
		if (nextForm !== form) this.s = nextForm;
	}

	get dirty(): boolean {
		return JSON.stringify(this.s) !== this.#saved;
	}

	/** Put the saved settings back. */
	revert(): void {
		this.s = editableSettings(JSON.parse(this.#saved) as SavedSettings);
		this.#reset();
	}

	/** The settings to send, as plain data. */
	snapshot(): ProjectSettings {
		return $state.snapshot(this.s) as unknown as ProjectSettings;
	}

	/** A rebase that brought a non-zero X2 (an applied GR4J fit) shows it; one that kept the form's never closes it. */
	#openX2(): void {
		if (this.s.gr4j && this.s.gr4j.x2 !== 0) this.x2Open = true;
	}

	#reset(): void {
		this.x2Open = this.s.gr4j?.x2 !== 0;
		this.lastMonthlyPe = null;
		this.lastAreal = null;
		this.lastGapMap = null;
		this.lastLakeMonthly = null;
		this.saveError = null;
		this.errors = noErrors();
		this.kept = {};
	}
}
