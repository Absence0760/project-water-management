// Every file and paste box's Expected format, gathered for the File formats
// help page (/help/formats, issue #477; docs/ui.md § Expected format). Each
// format is kept beside its box's parser, whose tests read its example back
// through it; the note beside the box (common/FormatHelp.svelte) and this
// page show the same object, so the two can't differ. A guard
// (fileFormats.test.ts) keeps every note on a format listed here.
import { INGEST_FORMAT } from '#lib/components/apiKeys/apiKeys.js';
import { ALLOCATIONS_FORMAT } from '#lib/components/allocations/allocations.js';
import type { FileFormat } from '#lib/components/common/formatHelp.js';
import { CROP_FACTORS_FORMAT, PLANTED_AREAS_FORMAT } from '#lib/components/crops/areaPaste.js';
import { B023_FACTORS_FORMAT, NODE_FACTORS_FORMAT } from '#lib/components/crops/loadFactors.js';
import { PLANTINGS_FORMAT } from '#lib/components/crops/plantingsImport.js';
import { SYSTEMS_FORMAT } from '#lib/components/crops/systemsPaste.js';
import { B023_WORKBOOK_FORMAT, PROJECT_FILE_FORMAT } from '#lib/components/import/importFormats.js';
import { GEOJSON_FORMAT } from '#lib/components/map/uploadFormat.js';
import { demandsFormat } from '#lib/components/network/demandsPaste.js';
import { NODE_TABLE_FORMAT } from '#lib/components/network/nodePaste.js';
import { inviteFormat } from '#lib/components/project/farmers.js';
import { drmFormat } from '#lib/components/settings/drmFormat.js';
import { MONTHLY_SETTINGS_FORMAT } from '#lib/components/settings/monthlyPaste.js';
import { TRANSFERS_FORMAT } from '#lib/components/transfers/transfersPaste.js';
import { SERIES_FILE_FORMAT, SERIES_PASTE_FORMAT } from '#lib/series/example.js';
import { gridFileFormat } from '#lib/spreadsheet/paste/grid.js';

/** A group of formats on the page, by where in the app their boxes are. */
export interface FormatGroup {
	id: string;
	title: string;
	formats: readonly FileFormat[];
}

/** Every format, by page, in the order a project is set up. */
export const FORMAT_GROUPS: readonly FormatGroup[] = [
	{ id: 'projects', title: 'New projects', formats: [B023_WORKBOOK_FORMAT, PROJECT_FILE_FORMAT] },
	{ id: 'data', title: 'Data', formats: [SERIES_FILE_FORMAT, SERIES_PASTE_FORMAT] },
	{ id: 'network', title: 'Network', formats: [gridFileFormat(NODE_TABLE_FORMAT), gridFileFormat(demandsFormat())] },
	{
		id: 'crops',
		title: 'Crops & demand',
		formats: [PLANTINGS_FORMAT, gridFileFormat(PLANTED_AREAS_FORMAT), gridFileFormat(CROP_FACTORS_FORMAT), B023_FACTORS_FORMAT, NODE_FACTORS_FORMAT, gridFileFormat(SYSTEMS_FORMAT)]
	},
	{ id: 'transfers', title: 'Transfers', formats: [gridFileFormat(TRANSFERS_FORMAT)] },
	{ id: 'settings', title: 'Settings & calibration', formats: [gridFileFormat(MONTHLY_SETTINGS_FORMAT), drmFormat('dailyEwr'), drmFormat('ruleTable')] },
	{ id: 'map', title: 'Map', formats: [GEOJSON_FORMAT] },
	{ id: 'allocations', title: 'Allocations', formats: [ALLOCATIONS_FORMAT] },
	// The page's invite example names no project's units.
	{ id: 'farmers', title: 'Farmers and loggers', formats: [inviteFormat([]), INGEST_FORMAT] }
];

/** Every format on the page, in its order. */
export const FILE_FORMATS: readonly FileFormat[] = FORMAT_GROUPS.flatMap((g) => g.formats);
