// The Settings & calibration form's unsaved settings. The workspace page holds
// it (routes/projects/[id]/+page.svelte), not the Settings tab, as it holds the
// project details (project/detailsDraft.svelte.ts): the edits survive a tab
// change, the page's one save bar saves or discards them with the model and
// the details, the leave guard and the header's "Unsaved changes" count them,
// and their problems are links in the bar. The tab edits `s` in place and
// reports what blocks the save (`blockers`, with where each is fixed); the
// page saves `snapshot()`.
import type { CalibrationParams, ChirpsQuantileMap, ProjectSettings } from '@water-management/engine';
import type { AutoRunSettings, OutcomeSettings, OutlookSettings } from '$lib/api/types';
import { resolveAutoRun } from '$lib/components/autorun/autoRun';
import { resolveOutcomes } from '$lib/components/outcomes/outcomeSettings';
import { resolveOutlook } from '$lib/components/outlook/settings';
import type { EditableArealRain } from './arealRain';
import type { EditablePe } from './peInput';
import type { SaveBlocker } from './sections';

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
};

type SavedSettings = ProjectSettings & { autoRun?: Partial<AutoRunSettings>; outcomes?: OutcomeSettings; outlook?: OutlookSettings };

/** A deep copy the form can edit, with the defaults an older API leaves out filled in. */
export function editableSettings(v: SavedSettings): EditableSettings {
	const c = JSON.parse(JSON.stringify(v)) as EditableSettings;
	c.autoRun = resolveAutoRun(v);
	c.outcomes = resolveOutcomes(v);
	c.outlook = resolveOutlook(v);
	return c;
}

/**
 * The form after the saved settings changed under it (another tab or a team
 * member saved, a fit was applied): the new saved settings, with the
 * top-level settings the form changed from `before` kept as the form has
 * them. Settings it didn't touch follow the new save, so a save of the form
 * never puts back a setting someone else changed.
 */
export function rebaseSettings(draft: EditableSettings, before: EditableSettings, after: EditableSettings): EditableSettings {
	const out = JSON.parse(JSON.stringify(after)) as Record<string, unknown>;
	const d = draft as unknown as Record<string, unknown>;
	const b = before as unknown as Record<string, unknown>;
	for (const k of new Set([...Object.keys(d), ...Object.keys(b)])) {
		if (JSON.stringify(d[k]) === JSON.stringify(b[k])) continue;
		if (d[k] === undefined) delete out[k];
		else out[k] = JSON.parse(JSON.stringify(d[k]));
	}
	return out as unknown as EditableSettings;
}

/** The problems child sections report through `bind:error` (each its own check). */
export const CHILD_ERRORS = [
	'calWindow',
	'exclusions',
	'qualityFlags',
	'rules',
	'zeroRain',
	'fitPeriod',
	'rainSource',
	'wr2012',
	'reserve',
	'evidence',
	'restrict'
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
	/** What blocks a save, by group in page order: the Settings tab reports it while it is shown. */
	blockers = $state.raw<SaveBlocker[]>([]);

	/** Start over from the saved settings (the project loaded, saved, or a fit was applied). */
	load(settings: SavedSettings): void {
		const c = editableSettings(settings);
		this.#saved = JSON.stringify(c);
		this.s = editableSettings(settings);
		this.#reset();
	}

	/** The saved settings changed elsewhere: they follow it, and the form keeps its own edits (rebaseSettings). */
	rebase(settings: SavedSettings): void {
		if (!this.dirty) {
			this.load(settings);
			return;
		}
		const before = JSON.parse(this.#saved) as EditableSettings;
		const after = editableSettings(settings);
		this.s = rebaseSettings($state.snapshot(this.s) as EditableSettings, before, after);
		this.#saved = JSON.stringify(after);
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

	#reset(): void {
		this.x2Open = this.s.gr4j?.x2 !== 0;
		this.lastMonthlyPe = null;
		this.lastAreal = null;
		this.lastGapMap = null;
		this.lastLakeMonthly = null;
		this.saveError = null;
		this.errors = noErrors();
		this.blockers = [];
		this.kept = {};
	}
}
