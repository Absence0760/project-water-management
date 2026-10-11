// Paste from a spreadsheet into Settings' monthly evaporation rows (issue
// #477; docs/ui.md § Settings): the monthly A-pan (mm) and, when GR4J runs on
// pan coefficient × A-pan, the pan coefficients. One paste fills either row
// or both: a row per setting, its name first, under a heading row of months.
// The block is mapped by $lib/spreadsheet/paste/monthlyRows.ts, as the
// transfers' rates are.
import type { GridFormat, PasteAnchor, PastePlan } from '$lib/spreadsheet/paste/grid';
import { monthlyRowsCsv, planMonthlyPaste, type MonthlyRow } from '$lib/spreadsheet/paste/monthlyRows';
import { PE_MONTH_MAX_MM } from './peInput';

/** Headings the first column goes by. */
const NAME_HEADINGS = ['Parameter', 'Setting', 'Name', 'Month'];
const INFO_HEADINGS = ['Unit'];

export type MonthlySettingId = 'apanMm' | 'panCoefficient';

/**
 * The rows the paste fills: the A-pan always, the pan coefficient only when
 * the form shows it (`pan`: GR4J's PE is pan coefficient × A-pan, not a
 * monthly PE row).
 */
export function monthlySettingRows(s: { apanMm: readonly number[]; panCoefficient: readonly number[] }, pan: boolean): MonthlyRow[] {
	const rows: MonthlyRow[] = [{ id: 'apanMm', name: 'A-pan evaporation', aliases: ['A-pan', 'Apan', 'A-pan evaporation (mm)', 'A-pan (mm)'], unit: 'mm', values: s.apanMm, max: PE_MONTH_MAX_MM }];
	if (pan) rows.push({ id: 'panCoefficient', name: 'Pan coefficient', aliases: ['Pan coefficients', 'Kp'], unit: '', values: s.panCoefficient, max: 2 });
	return rows;
}

/** What pasting `text` would change (A-pan 0–10 000 mm, a pan coefficient 0–2). */
export function planSettingsPaste(text: string, rows: readonly MonthlyRow[], anchor?: PasteAnchor | null): PastePlan | { error: string } {
	return planMonthlyPaste(text, rows, { anchor, nameHeadings: NAME_HEADINGS, ignoreHeadings: INFO_HEADINGS });
}

/** The rows as a CSV to fill in and paste back: Parameter, Unit, then Oct … Sep. */
export function monthlySettingsCsv(rows: readonly MonthlyRow[]): string {
	return monthlyRowsCsv(rows, NAME_HEADINGS[0]!, [{ heading: 'Unit', value: (r) => r.unit || '× A-pan' }]);
}

/** The Expected format of the monthly evaporation paste (issue #477). */
export const MONTHLY_SETTINGS_FORMAT: GridFormat = {
	id: 'monthly-settings-grid',
	title: 'Monthly A-pan and pan coefficients',
	where: 'Settings & calibration → Demand → Paste from a spreadsheet',
	rules: [
		'A heading row: Parameter, then the months Oct to Sep (or October to September). A Unit column may stay; the paste leaves it out.',
		'A row per setting, its name first: A-pan evaporation (or A-pan), in mm a month, 0 to 10 000; Pan coefficient (or Kp), × A-pan, 0 to 2, only while GR4J runs on pan coefficient × A-pan.',
		'One row is enough. A blank or a dash leaves a month as it is.'
	],
	example: 'Parameter,Unit,Oct,Nov,Dec,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep\r\nA-pan evaporation,mm,180,200,230,235,190,170,120,95,75,80,110,145\r\nPan coefficient,× A-pan,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7\r\n',
	exampleName: 'monthly-evaporation-example.csv'
};
