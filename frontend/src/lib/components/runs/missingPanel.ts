// A link to a results panel the shown run doesn't have (issue #586): the
// model-checks line, a note or the report links `#res-wr2012` on a run made
// without a WR2012 reference, say. The panel isn't drawn at all, so the link
// would land nowhere and say nothing; RunsTab shows this line instead, with a
// link to where the panel's input is set (playbook § 2: a one-line stub
// saying what it needs). Calibration shows it the same way for the Model
// quality panels, which moved there (issue #586 Round 3,
// calibration/CalibrationResults.svelte).
import { resultSections } from './sections';
import { modelQualitySections } from './modelQuality';
import { calibrationHref } from '#lib/components/calibration/links.js';

type SectionInput = Parameters<typeof resultSections>[0] & Parameters<typeof modelQualitySections>[0];

export interface MissingPanel {
	/** The line: what the panel is and what it needs. */
	text: string;
	/** Where that is set, when it is a setting. */
	link: { href: string; label: string } | null;
}

/** The panels drawn only on some runs, each with what it needs. */
const NEEDS: Record<string, MissingPanel> = {
	'res-forecast': {
		text: 'This run is not a forecast, so it has no forecast panel. A forecast run needs forecast rain: upload it, or turn on the CHIRPS-GEFS feed, then use Run forecast.',
		link: { href: '?tab=series#data-feeds', label: 'Data feeds' }
	},
	'res-gauges': {
		text: 'This run checks no gauge inside the network. It needs a flow record at a gauge that is not a ticked calibration location.',
		link: { href: '?tab=series', label: 'Data' }
	},
	'res-runoff': {
		text: 'This run has no runoff model balance. It is shown for a conceptual runoff model (GR4J), chosen under Flow generation.',
		link: { href: '?tab=settings#set-share', label: 'Flow generation' }
	},
	'res-unit-rain': {
		text: 'This run has no rain for each unit. Every unit runs on its own rain now, so the run was made before that (under Fragmentation), or the model has no land unit with a GR4J runoff model. Run the model again to see it.',
		link: { href: '?tab=settings#set-share', label: 'Flow generation' }
	},
	'res-gap-rain': {
		text: 'This run filled no rain gaps from another product. It needs ERA5-Land or IMERG Late chosen as the gap-filling product, under Rain gaps.',
		link: { href: '?tab=settings#set-rain', label: 'Rain gaps' }
	},
	'res-wr2012': {
		text: 'This run has no WR2012 check. It needs a WR2012 reference for the catchment, set under WR2012 check.',
		link: { href: calibrationHref(null, 'set-wr2012'), label: 'WR2012 check' }
	},
	'res-plausibility': {
		text: 'This run has no plausibility checks: it was made by an older version of the model. Run the model again to get them.',
		link: null
	}
};

/** What to say for a `#res-…` fragment (without the `#`) that names a panel this run doesn't draw; null when the panel is drawn, or isn't one that can be missing. */
export function missingPanel(hash: string, summary: SectionInput): MissingPanel | null {
	const needs = NEEDS[hash];
	if (!needs) return null;
	const drawn = [...resultSections(summary, true), ...modelQualitySections(summary)];
	return drawn.some((s) => s.id === hash) ? null : needs;
}
