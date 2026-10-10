// The project list's import boxes' Expected formats (ImportProjectDialog,
// issue #456; the File formats help page, issue #477).
import type { FileFormat } from '$lib/components/common/formatHelp';
import { WORKBOOK_MAX_MB } from './workbookFile';

export const B023_WORKBOOK_FORMAT: FileFormat = {
	id: 'b023-workbook',
	title: 'A b023 workbook, as a new project',
	where: 'Projects → Import b023 workbook',
	accepts: `A b023 Water Balance Tool workbook (.xlsm or .xlsx), up to ${WORKBOOK_MAX_MB} MB, from a b02x build (b022, b023 …).`,
	rules: [
		'The whole tool: the importer finds its tables through the workbook’s named ranges, so a workbook without them is refused, and the message lists the ones missing.',
		'It reads [Network], [Farm spec], [Crop demand], [Farm demand], [Transfers], [Flow Calibration Cfg] and [Flow data]; the per-farm result sheets are left out.',
		'A cell it can’t get past is named by its sheet and cell; what it imported with a caveat is listed in the review, each with its sheet and cell.'
	]
};

export const PROJECT_FILE_FORMAT: FileFormat = {
	id: 'project-file',
	title: 'A project file (.json)',
	where: 'Projects → Import project file (.json)',
	accepts: 'A project file (.json), at most 5 MB, in UTF-8.',
	rules: [
		'One JSON object: a `name`; a `model` with lists of `nodes`, `crops`, `cropAreas` and `transfers`; and optionally `settings` and `series`.',
		'Each series is `kind`, `name`, `unit`, `startDate` (YYYY-MM-DD) and `values`, one a day from that date, `null` for no reading.',
		'The surest way to one is *Download project (JSON)* on any project’s Overview. JSON that doesn’t parse is refused with the line and column where it stops; the server checks the rest and lists every problem before anything is created.'
	]
};
