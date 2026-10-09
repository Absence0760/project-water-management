// The series upload's example (UploadForm's "Expected format", issue #456):
// invented values, read by the same parser as an upload (example.test.ts), so
// what the note shows is always a file the form takes.
import type { ExampleFile } from '$lib/components/common/formatHelp';

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
