// The Expected format of the EWR and Reserve upload points (issue #455,
// DrmFormatHelp.svelte; the File formats help page, issue #477): what each
// part of a Desktop Reserve Model file fills, for the daily EWR at the outlet
// and for a Reserve rule table, with synthetic example files (the .rul in
// m³/s and in Mm³, the .tab, and each form's CSV layouts).
import type { FileFormat } from '$lib/components/common/formatHelp';
import { drmExampleFiles } from './drmFiles';
import { exampleDailyCsv } from './ewrDailySource';
import { exampleGridCsv } from './ewrRules';

export type DrmTarget = 'ruleTable' | 'dailyEwr';

export function drmFormat(target: DrmTarget): FileFormat {
	const table = target === 'ruleTable';
	return {
		id: table ? 'reserve-rule-table' : 'daily-ewr-outlet',
		title: table ? 'A Reserve rule table (DRM .rul, .tab or CSV)' : 'The daily EWR at the outlet (DRM .tab or .rul)',
		where: table ? 'Settings & calibration → Reserve rule tables' : 'Settings & calibration → EWR → Daily EWR at the outlet',
		accepts: table
			? 'A Desktop Reserve Model rule-curve file (.rul) or summary (.tab), plain text; or a CSV (.csv, .tsv, .txt) of the 12 month rows, which goes into the paste box below the table.'
			: 'A Desktop Reserve Model summary (.tab) or rule-curve file (.rul), plain text. A CSV isn’t loaded here: paste its rows into the box below the tables.',
		rules: [
			'**Rule curves (.rul)**: the header (`Ecological Category = B`), a unit line (`Data are given in m^3/s mean monthly flow`, or `… m^3 * 10^6 monthly flow volume` for Mm³ a month), the `% Points` line (10% … 99%), then three blocks of 12 month rows, a month name and one number per point: the total Reserve (right after the points), `Reserve Flows without High Flows` and `Natural Duration curves`. ' +
				(table
					? 'They fill the EWR (total flow), the low flows and the natural flows at each point, in the file’s unit, the % points and the REC.'
					: 'The total Reserve and the natural duration curve fill the two percentile tables, converted to m³/s when the file is in Mm³ (a month’s volume ÷ its days × 86 400 s, February 28 days). The method you picked stays as it is.'),
			'**Summary (.tab)**: `MAR = …` (Mm³ a year), `Ecological Category = …` and the `Monthly Distributions (Mill. cu. m.)` table (Month, natural mean, SD, CV, then low flows maint. and drought, high flows maint., total flows maint.). ' +
				(table
					? 'It fills the determination’s natural MAR and the REC.'
					: 'The last column, *Total Flows, Maint.*, in Mm³ a month, becomes the TAB flows in m³/s (÷ the month’s days × 86 400 s, February 28 days); the MAR fills the table MAR. You see the converted values before they are used; under the percentile tables only its MAR is offered.'),
			`**A spreadsheet paste or CSV**: 12 month rows (Oct … Sep, or month names in the first column), optionally with a heading row of % points${table ? '' : ', in m³/s'}. A comma between digits in a tab-separated paste is a decimal comma.`,
			'Either line ending (Windows CRLF or LF) is read. A line that doesn’t fit is named in the message, with its line number.'
		],
		after: 'The example files hold synthetic numbers.',
		files: [
			...drmExampleFiles(),
			...(table
				? [
						{ name: 'ewr-total-example.csv', text: exampleGridCsv('total'), label: 'Example CSV (total-flow table)' },
						{ name: 'ewr-low-flow-example.csv', text: exampleGridCsv('lowFlow'), label: 'Example CSV (low-flow table)' }
					]
				: [{ name: 'ewr-example.csv', text: exampleDailyCsv(), label: 'Example CSV (percentile table, m³/s)' }])
		]
	};
}
