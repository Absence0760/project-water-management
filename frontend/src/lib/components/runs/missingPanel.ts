// A link to a results panel the shown run doesn't have (issue #586): the
// model-checks line, a note or the report links `#res-wr2012` on a run made
// without a WR2012 reference, say. The panel isn't drawn at all, so the link
// would land nowhere and say nothing; RunsTab shows this line instead, with a
// link to where the panel's input is set (playbook § 2: a one-line stub
// saying what it needs).
import { resultSections } from './sections';

type SectionInput = Parameters<typeof resultSections>[0];

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
		text: 'This run checks no gauge inside the network. It needs a flow record at a gauge that is not the calibration site.',
		link: { href: '?tab=series', label: 'Data' }
	},
	'res-runoff': {
		text: 'This run has no runoff model balance. It is shown for a conceptual runoff model (GR4J), chosen under Flow generation.',
		link: { href: '?tab=settings#set-share', label: 'Flow generation' }
	},
	'res-unit-rain': {
		text: 'This run has no rain for each unit. It needs Per unit flow generation, with rain for each unit or rainfall stations, set under Flow generation.',
		link: { href: '?tab=settings#set-share', label: 'Flow generation' }
	},
	'res-wr2012': {
		text: 'This run has no WR2012 check. It needs a WR2012 reference for the catchment, set under WR2012 check.',
		link: { href: '?tab=settings#set-wr2012', label: 'WR2012 check' }
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
	return resultSections(summary, true).some((s) => s.id === hash) ? null : needs;
}
