// [Flow Calibration Cfg] → settings.calibration (the rain threshold and catchment area), and the calibration window
// and flow record (scripts/wbt-import/calibration.py).
import type { CalibrationParams } from '@water-management/engine';
import { type Cell, XlDateTime, pyFloat, pyRepr, pyStr } from './cells';
import { InvalidWorkbookError, NotB023WorkbookError } from './errors';
import type { B023Workbook } from './workbook';

/**
 * calibration.py _num(): like num(), but text that isn't a number stops the
 * import (the Python raises ValueError) instead of reading as 0.
 */
function strictNum(v: Cell, name: string): number {
	if (v === null || v === '') return 0;
	if (typeof v === 'boolean') return v ? 1 : 0;
	if (typeof v === 'number') return v;
	const n = pyFloat(pyStr(v));
	if (n === null) throw new InvalidWorkbookError(`[Flow Calibration Cfg] ${name}: expected a number, got ${pyRepr(v)}`, 'Flow Calibration Cfg');
	return n;
}

/**
 * calibration.py _column(): the first column of a named range, stopping at
 * the sheet's last row (openpyxl's read-only rows end there, unpadded).
 */
function column(wb: B023Workbook, name: string): Cell[] {
	const { sheet, c1, r1, r2 } = wb.ref(name);
	const last = Math.min(r2, wb.lastRow(sheet));
	const out: Cell[] = [];
	for (let r = r1; r <= last; r++) out.push(wb.cell(sheet, c1, r));
	return out;
}

/** A named range wholly below its sheet's last row: the Python's IndexError, which nothing catches. */
class OffSheetError extends InvalidWorkbookError {}

function cell(wb: B023Workbook, name: string): Cell {
	const col = column(wb, name);
	if (!col.length) throw new OffSheetError(`The named range ${name} is below the last row of its sheet`);
	return col[0]!;
}

const num = (wb: B023Workbook, name: string) => strictNum(cell(wb, name), name);

/**
 * extract_calibration(): CalibrationParams, keys in the Python's order: the
 * rain threshold and the catchment area. The rest of [Flow Calibration Cfg]
 * configured the legacy runoff model, removed in engine 1.0.0 (issue #16),
 * and is not read.
 */
export function extractCalibration(wb: B023Workbook): CalibrationParams {
	return {
		rainThresholdMm: num(wb, 'rCalibration_RainThreshold'),
		catchmentAreaKm2: num(wb, 'rFarmSpec_AreaTotal')
	};
}

/** [Flow data] rUseFlow picks Flow A/B/C = columns F/G/H; 1 (Pitman) is kept so the caller can warn. */
const USE_FLOW_KINDS: Record<number, string> = { 1: 'flow_pitman_m3s', 2: 'flow_observed_m3s', 3: 'flow_logger_m3s' };

export interface CalibrationWindow {
	calibrationStart: string | null;
	calibrationEnd: string | null;
	/** Can be 'flow_pitman_m3s' here; extractProject() warns and unsets it. */
	calibrationFlowKind: string | null;
}

/** Python's except (KeyError, ValueError): a missing name, a non-plain reference or a missing sheet reads as null. */
function optional<T>(read: () => T): T | null {
	try {
		return read();
	} catch (e) {
		if (e instanceof NotB023WorkbookError || (e instanceof InvalidWorkbookError && !(e instanceof OffSheetError))) return null;
		throw e;
	}
}

/** extract_calibration_window(): calibrationStart / End from zCalibration_Date1 / DateN, calibrationFlowKind from rUseFlow. */
export function extractCalibrationWindow(wb: B023Workbook): CalibrationWindow {
	const out: CalibrationWindow = { calibrationStart: null, calibrationEnd: null, calibrationFlowKind: null };
	const iso = (v: Cell) => (v instanceof XlDateTime ? v.iso : null);
	out.calibrationStart = optional(() => iso(cell(wb, 'zCalibration_Date1')));
	out.calibrationEnd = optional(() => iso(cell(wb, 'zCalibration_DateN')));
	out.calibrationFlowKind = optional(() => {
		const use = cell(wb, 'rUseFlow');
		const n = typeof use === 'number' ? use : typeof use === 'boolean' ? Number(use) : null;
		return n === null ? null : (USE_FLOW_KINDS[Math.trunc(n)] ?? null);
	});
	if (out.calibrationStart && out.calibrationEnd && out.calibrationStart > out.calibrationEnd) {
		out.calibrationStart = out.calibrationEnd = null;
	}
	return out;
}
