// The series upload's example (UploadForm's "Expected format", issue #456):
// invented values, read by the same parser as an upload (example.test.ts), so
// what the note shows is always a file the form takes.
import type { ExampleFile, FileFormat } from '$lib/components/common/formatHelp';

/** The few lines the note shows. */
export const SERIES_EXAMPLE = 'date,value\n2025-04-01,0.0\n2025-04-02,12.4\n2025-04-03,';

/** The file it offers: a week of invented daily rainfall, with the three ways of writing "no reading". */
export const SERIES_EXAMPLE_FILE: ExampleFile = {
	name: 'example-daily-rainfall.csv',
	text: [
		'# Invented example: daily rainfall in mm. Lines starting with # are skipped.',
		'date,value',
		'2025-04-01,0.0',
		'2025-04-02,12.4',
		'2025-04-03,',
		'2025-04-04,3.6',
		'2025-04-05,NA',
		'2025-04-06,-999',
		'2025-04-07,0.8',
		''
	].join('\r\n')
};

const SERIES_RULES = [
	'Dates: YYYY-MM-DD (safest), YYYY/MM/DD, YYYYMMDD, DD/MM/YYYY or MM/DD/YYYY (the last two with slashes, dots or dashes). The order is worked out from the whole file; if no day is above 12, day/month is assumed and the summary says so.',
	'Several readings a day (an hourly or 10-minute logger): a time after each date, `2025-04-01 09:00` (seconds and am/pm are read too). The form then asks how to add them up into days.',
	'Separators: comma, semicolon or tab, worked out from the file. Quote a value that holds the separator.',
	'Numbers: 12.5 or 12,5 (a decimal comma in a semicolon or tab file, or quoted), with or without thousands separators (1 234,5 · 1,234.5). The decimal separator is worked out from the whole file; a file that mixes them, or where 1,234 could be either, is refused.',
	'Blank, NA, NaN, null or - = no reading (stored as a gap). A negative value (-999, -1) is a “no reading” placeholder and is stored as a gap too; the summary counts them.',
	'DWS hydrology exports load as they are: the daily table from the DWS site (`DATE D AVG F/R QUAL`, dates as YYYYMMDD), as text or the saved page. Days whose quality code says the data is missing (151, 165, 170, 172, 246, 247, 255), and blank or negative values such as -999, are stored as gaps; the summary counts them.',
	'Units: pick the file’s unit below and the values are converted; flow is stored as the daily mean in m³/s, rain and evaporation in mm per day.'
];
const SERIES_LEAD = 'Two columns, `date,value`, one row per day; a header row is optional and lines starting with # are skipped.';
const SERIES_LAST = 'A row that can’t be read stops the upload, and the message names its line (“Line 12: …”).';

/** The Data page's series upload, as a file (UploadForm's Expected format; issue #456). */
export const SERIES_FILE_FORMAT: FileFormat = {
	id: 'daily-series-file',
	title: 'Daily series (rain, flow, evaporation), as a file',
	where: 'Data → Add data → A file',
	accepts: 'A .csv, .tsv or .txt file, or a DWS daily export saved as text or as the web page (.htm, .html). At most 60 000 days from the first date to the last.',
	lead: SERIES_LEAD,
	rules: [...SERIES_RULES, 'Name the file after the series (e.g. `Weir flow.csv`) and it is picked for you.', SERIES_LAST],
	example: SERIES_EXAMPLE,
	files: [SERIES_EXAMPLE_FILE]
};

/** The same upload as rows pasted from a spreadsheet. */
export const SERIES_PASTE_FORMAT: FileFormat = {
	id: 'daily-series-paste',
	title: 'Daily series, rows pasted from a spreadsheet',
	where: 'Data → Add data → Rows pasted from a spreadsheet',
	accepts: 'Rows copied from a spreadsheet (Excel and LibreOffice copy them tab-separated) or typed as date,value. At most 60 000 days from the first date to the last; a longer record goes in as a file.',
	lead: SERIES_LEAD,
	rules: [
		...SERIES_RULES,
		'Copy the date column and the value column together, with or without their headings. A heading that names the series (e.g. `Weir flow`) picks it for you.',
		'A blank cell is no reading: merged into a stored series, it leaves that day as it is. To clear a stored day, use Edit a day under the chart.',
		SERIES_LAST
	],
	example: SERIES_EXAMPLE,
	files: [SERIES_EXAMPLE_FILE]
};
