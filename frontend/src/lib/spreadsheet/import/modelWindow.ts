// The run's window from [Home] zHome_CalcDate1 / CalcDateN (extract_project.py
// model_window, issue #54): the window the workbook last calculated. [Flow
// data] can hold a gauge record decades longer than the rain, and a run over
// all of it has decades with no rain. Each end is used only when it lies
// inside [Flow data] and cuts some of it off; otherwise the run covers the
// flow record, as before.
import { XlDateTime } from './cells';
import { InvalidWorkbookError } from './errors';
import type { B023Workbook } from './workbook';

export interface ModelWindow {
	simulationStart: string | null;
	simulationEnd: string | null;
	note: string;
}

function dateAt(wb: B023Workbook, name: string): string | null {
	if (!wb.has(name)) return null;
	try {
		const r = wb.ref(name);
		const v = wb.cell(r.sheet, r.c1, r.r1);
		return v instanceof XlDateTime ? v.iso : null;
	} catch (e) {
		// A name pointing at a missing sheet or an odd range: no window, the import goes on.
		if (e instanceof InvalidWorkbookError) return null;
		throw e;
	}
}

/** The window to run, with its note; null when the run should cover the whole flow record. */
export function modelWindow(wb: B023Workbook, dates: readonly string[]): ModelWindow | null {
	if (!dates.length) return null;
	const first = dates[0]!;
	const last = dates[dates.length - 1]!;
	const d1 = dateAt(wb, 'zHome_CalcDate1');
	const dn = dateAt(wb, 'zHome_CalcDateN');
	const start = d1 && first < d1 && d1 <= last ? d1 : null;
	const end = dn && first <= dn && dn < last ? dn : null;
	if ((start && end && start > end) || (!start && !end)) return null;
	return {
		simulationStart: start,
		simulationEnd: end,
		note:
			`[Home] the workbook calculates ${start ?? first} to ${end ?? last}, inside [Flow data]'s ${first} to ` +
			`${last}: runs cover that window (settings.simulationStart / End); every series keeps its full record`
	};
}
