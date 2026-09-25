// --gauge-as-reference (extract_project.py gauge_as_reference): the [Flow
// data] gauge column is a gauge on another river, so it becomes a
// flow_reference_m3s series the engine never reads (docs/model.md §2.10),
// optionally with a known scaling undone.
import { toEpochDay } from '@water-management/engine';
import { pyFormatG } from './cells';
import { InvalidImportOptionsError } from './errors';
import type { ImportedSeries } from './flowData';
import type { Report } from './report';

const GAUGE_KIND = 'flow_observed_m3s';
const REFERENCE_KIND = 'flow_reference_m3s';
const LOGGER_KIND = 'flow_logger_m3s';

/** Undo a scaling of the gauge column: values on or after `scalingFrom` (YYYY-MM-DD) are divided by `scaleFactor` (> 0). */
export interface GaugeScaling {
	scalingFrom: string;
	scaleFactor: number;
}

/** A calendar date in the only form the option takes, YYYY-MM-DD. */
function isIsoDate(s: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
	const t = Date.parse(`${s}T00:00:00Z`);
	return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** Reject the combinations the Python CLI rejects. */
export function validateScaling(scaling: Partial<GaugeScaling> | undefined): GaugeScaling | null {
	if (!scaling) return null;
	const { scalingFrom, scaleFactor } = scaling;
	if ((scalingFrom === undefined) !== (scaleFactor === undefined)) {
		throw new InvalidImportOptionsError('The gauge scaling date and factor go together.');
	}
	if (scalingFrom === undefined || scaleFactor === undefined) return null;
	if (!isIsoDate(scalingFrom)) throw new InvalidImportOptionsError(`The gauge scaling date is not a YYYY-MM-DD date: ${scalingFrom}`);
	if (!(Number.isFinite(scaleFactor) && scaleFactor > 0)) {
		throw new InvalidImportOptionsError(`The gauge scale factor must be a positive number, got ${scaleFactor}`);
	}
	return { scalingFrom, scaleFactor };
}

/**
 * Re-label the gauge series as a reference gauge, in place, and undo the
 * scaling if one is given. If rUseFlow pointed calibration at the gauge,
 * calibrationFlowKind is left unset with a warning.
 */
export function gaugeAsReference(
	series: ImportedSeries[],
	settings: { calibrationFlowKind: string | null },
	scaling: GaugeScaling | null,
	report: Report
): void {
	const gauge = series.find((s) => s.kind === GAUGE_KIND);
	if (!gauge) {
		report.note('gauge-as-reference-no-gauge', '--gauge-as-reference: the workbook has no gauge values; nothing to re-label', { sheet: 'Flow data' });
	} else {
		gauge.kind = REFERENCE_KIND;
		let msg =
			`[Flow data] gauge column imported as ${REFERENCE_KIND} (a reference gauge on another river), ` +
			`not ${GAUGE_KIND}: runs never calibrate against it`;
		if (scaling) {
			const first = Math.max(0, toEpochDay(scaling.scalingFrom) - toEpochDay(gauge.startDate));
			let changed = 0;
			for (let i = first; i < gauge.values.length; i++) {
				const v = gauge.values[i];
				if (v !== null && v !== undefined) {
					gauge.values[i] = v / scaling.scaleFactor;
					changed++;
				}
			}
			msg += `; values from ${scaling.scalingFrom} divided by ${pyFormatG(scaling.scaleFactor)} (${changed} days)`;
		}
		report.note('gauge-as-reference', msg, { sheet: 'Flow data' });
	}
	if (settings.calibrationFlowKind === GAUGE_KIND) {
		settings.calibrationFlowKind = null;
		const hasLogger = series.some((s) => s.kind === LOGGER_KIND);
		report.note(
			'gauge-as-reference-calibration-unset',
			'WARNING: [Flow data] rUseFlow calibrates against the gauge column, which --gauge-as-reference says is ' +
				'another river. calibrationFlowKind is left unset' +
				(hasLogger
					? ', so runs use the logger record. Check that choice in Settings -> calibration flow series'
					: ' and the project has no observed flow record to calibrate against'),
			{ sheet: 'Flow data' }
		);
	}
}
