import { GR4J_PARAMS, OBJECTIVE_LABELS, type FitRecord, type Gr4jParams, type ParamSpec } from '@water-management/engine';
import { fmtDay, fmtNum } from '$lib/format/number';

// The Flow calibration form (settings.calibration, settings.gr4j). GR4J is the
// only runoff model since engine 1.0.0 removed the legacy b023 recession model
// (issue #16), so there is no model to pick and no legacy parameters to edit.

/** settings.calibration keys the Settings tab has a control for: all of them since engine 1.0.0. */
export const KNOWN_CAL_KEYS = new Set(['rainThresholdMm', 'catchmentAreaKm2']);

/** The one runoff model, as the form names it. */
export const RUNOFF_MODEL_LABEL = 'GR4J (Perrin et al. 2003)';
export const RUNOFF_MODEL_HELP =
	'A published daily model with four parameters that conserves water: rain leaves as evaporation or flow, or stays in a store. Needs potential evaporation. The legacy b023 workbook model was removed in engine 1.0.0; runs made with it still open, labelled, but cannot be re-run.';

export interface Gr4jField extends ParamSpec<Gr4jParams> {
	help: string;
	step: number;
}

const GR4J_HELP: Record<keyof Gr4jParams, string> = {
	x1: 'Soil-moisture store. A larger store absorbs more rain before the river responds and evaporates more in dry spells.',
	x2: 'Water gained (+) from or lost (−) to groundwater outside the catchment. Normally 0 (a closed catchment).',
	x3: 'Routing store. A larger store gives a slower, more sustained recession and higher base flow.',
	x4: 'How many days a rain pulse takes to pass the outlet. Small catchments are near 1 day; larger or flatter ones take longer.'
};

/** GR4J parameters for the Settings form: engine bounds plus help. */
export const GR4J_FIELDS: Gr4jField[] = GR4J_PARAMS.map((p) => ({ ...p, help: GR4J_HELP[p.key], step: p.key === 'x4' ? 0.05 : p.key === 'x2' ? 0.01 : 1 }));

/** "Typical 100–1200 mm" for a parameter hint. */
export function typicalRange(p: ParamSpec<Gr4jParams>): string {
	return `Typical ${p.typical[0]}–${p.typical[1]} ${p.unit}; allowed ${p.min}–${p.max}.`;
}

/**
 * The Settings & calibration header's line (issue #17): where the GR4J
 * parameters in the form came from. The fit's day and its in-sample score on
 * its own objective ("KGE′ 0.93 in calibration"), and whether anything the fit
 * depends on has changed since (the fit record under Fit automatically says
 * what); without a record, that the parameters weren't fitted here.
 */
export function fitSummary(record: FitRecord | null | undefined, changedSinceFit: boolean): string {
	if (!record) return 'GR4J · no fit record: the parameters were set by hand or imported';
	const score = record.fit?.scores?.[record.objective];
	const objective = (OBJECTIVE_LABELS[record.objective] ?? record.objective).replace(/ \(.*\)$/, '');
	return [
		'GR4J',
		`fitted ${fmtDay(record.fittedAt)}`,
		score == null ? null : `${objective} ${fmtNum(score, 2)} in calibration`,
		changedSinceFit ? 'changed since the fit' : null
	]
		.filter(Boolean)
		.join(' · ');
}
