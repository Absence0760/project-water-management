// Paste from a spreadsheet into the monthly evaporation rows (issue #477;
// docs/ui.md § Model settings, § Calibration): Model settings → Demand's
// monthly A-pan (mm), and Calibration → Flow calibration's pan coefficients,
// while GR4J runs on pan coefficient × A-pan. Each row's paste fills its own
// row (issue #586 round 3: the rows are on two pages now): a row per setting,
// its name first, under a heading row of months.
// The block is mapped by $lib/spreadsheet/paste/monthlyRows.ts, as the
// transfers' rates are.
import type { GridFormat, PasteAnchor, PastePlan } from '#lib/spreadsheet/paste/grid.js';
import { monthlyRowsCsv, planMonthlyPaste, type MonthlyRow } from '#lib/spreadsheet/paste/monthlyRows.js';
import { PE_MONTH_MAX_MM } from './peInput';

/** Headings the first column goes by. */
const NAME_HEADINGS = ['Parameter', 'Setting', 'Name', 'Month'];
const INFO_HEADINGS = ['Unit'];

export type MonthlySettingId = 'apanMm' | 'panCoefficient';

/** Which rows a paste fills: Demand's A-pan, Flow calibration's pan coefficient, or both. */
export type MonthlyPasteRows = 'apan' | 'pan' | 'both';

/**
 * The rows the paste fills: Demand's paste the A-pan (`apan`), Flow calibration's the pan coefficient (`pan`, shown
 * only while GR4J's PE is pan coefficient × A-pan, not a monthly PE row), or both.
 */
export function monthlySettingRows(s: { apanMm: readonly number[]; panCoefficient: readonly number[] }, which: MonthlyPasteRows): MonthlyRow[] {
	const rows: MonthlyRow[] = [];
	if (which !== 'pan') rows.push({ id: 'apanMm', name: 'A-pan evaporation', aliases: ['A-pan', 'Apan', 'A-pan evaporation (mm)', 'A-pan (mm)'], unit: 'mm', values: s.apanMm, max: PE_MONTH_MAX_MM });
	if (which !== 'apan') rows.push({ id: 'panCoefficient', name: 'Pan coefficient', aliases: ['Pan coefficients', 'Kp'], unit: '', values: s.panCoefficient, max: 2 });
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
	where: 'Model settings → Demand → Paste from a spreadsheet… (the A-pan), or Calibration → Flow calibration → Paste from a spreadsheet… (the pan coefficients, under Fill or edit the row)',
	rules: [
		'A heading row: Parameter, then the months Oct to Sep (or October to September). A Unit column may stay; the paste leaves it out.',
		'A row per setting, its name first: A-pan evaporation (or A-pan), in mm a month, 0 to 10 000, into Demand; Pan coefficient (or Kp), × A-pan, 0 to 2, into Flow calibration, while GR4J runs on pan coefficient × A-pan.',
		'Each paste fills its own row and leaves the other out, so one file can hold both. A blank or a dash leaves a month as it is.'
	],
	example: 'Parameter,Unit,Oct,Nov,Dec,Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep\r\nA-pan evaporation,mm,180,200,230,235,190,170,120,95,75,80,110,145\r\nPan coefficient,× A-pan,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7,0.7\r\n',
	exampleName: 'monthly-evaporation-example.csv'
};
