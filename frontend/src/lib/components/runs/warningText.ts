// The places a run's warnings name, as links (issue #586, D19). The engine
// writes each place as "<page> → <panel>" (packages/engine/src/places.ts
// WARNING_PLACES) and finds them in a warning's text (placesIn), runs before
// engine 1.98.0 included; this says where each place is in the workspace, so
// the Summary's things to check link straight to the panel. The printable
// report and the CSV keep the plain words.
import { placesIn, type WarningPlace } from '@water-management/engine';
import { calibrationHref } from '#lib/components/calibration/links.js';

/** Each place's anchor in the workspace: Model settings' panels, then Calibration's (the fit's and Plausibility checks). */
const ANCHOR: Record<WarningPlace, { tab: 'settings' | 'calibration'; id: string }> = {
	period: { tab: 'settings', id: 'set-period' },
	rain: { tab: 'settings', id: 'set-rain' },
	quality: { tab: 'settings', id: 'set-quality' },
	demand: { tab: 'settings', id: 'set-demand' },
	share: { tab: 'settings', id: 'set-share' },
	reserve: { tab: 'settings', id: 'set-reserve' },
	evidence: { tab: 'settings', id: 'set-evidence' },
	flow: { tab: 'calibration', id: 'set-flow' },
	record: { tab: 'calibration', id: 'set-record' },
	fit: { tab: 'calibration', id: 'set-fit' },
	wr2012: { tab: 'calibration', id: 'set-wr2012' },
	plausibility: { tab: 'calibration', id: 'res-plausibility' }
};

/** Where a place is: its panel's anchor on its page; a Calibration link keeps the run, so a result panel shows that run. */
export function warningPlaceHref(place: WarningPlace, runId: string | null): string {
	const a = ANCHOR[place];
	return a.tab === 'calibration' ? calibrationHref(runId, a.id) : `?tab=settings#${a.id}`;
}

/** A warning's text in pieces: plain words, and each place it names with its link. */
export type WarningPart = { text: string; href?: string };

export function warningParts(text: string, href: (place: WarningPlace) => string): WarningPart[] {
	const out: WarningPart[] = [];
	let at = 0;
	for (const m of placesIn(text)) {
		if (m.start > at) out.push({ text: text.slice(at, m.start) });
		out.push({ text: text.slice(m.start, m.end), href: href(m.place) });
		at = m.end;
	}
	if (at < text.length) out.push({ text: text.slice(at) });
	return out;
}
