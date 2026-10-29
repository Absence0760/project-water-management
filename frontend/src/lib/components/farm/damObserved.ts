// The dam page's "Your dam, seen from space" (issue #604 R5-B; docs/ui.md §
// Farmer view, docs/design/farmer-view.md §3 Q3). The newest clear satellite
// view of the farm's dam (GET …/farm/:nodeId/dam-observed), in plain words:
// its date and the water's area against the area the dam covers when full
// (area with area: the page's percentage is the dam's volume). A radar view
// (Sentinel-1, issue #624) says it is radar, "about", and never says the
// water spreads past the full area (radar is never alone the reason to call a
// dam full). Copernicus's credit joins DE Africa's when the view is Sentinel's.
// Pure wording, from the message catalogue ($lib/i18n, WP-2.5).
import type { FarmDamObserved } from '#lib/api/types.js';
import { t } from '#lib/i18n/locale.svelte.js';
import { hectares } from './farmMap';
import { fmtDay } from './format';

export interface DamObservedVm {
	heading: string;
	/** The newest clear view in words, or why there is none yet. */
	line: string;
	/** What a satellite can and can't tell. */
	about: string;
	/** The credit the data's licence asks for (CC BY 4.0; and Copernicus's for a Sentinel view). */
	credit: string;
}

/** null when none of the farm's dams is drawn as an outline on the map: the page shows nothing. */
export function damObservedCard(d: FarmDamObserved | null): DamObservedVm | null {
	if (!d || d.outlines < 1) return null;
	// i18n-section: farm.damPage
	const l = d.latest;
	// Area against area, never a percentage: the page above already says how full the dam is (its volume, "34 % full"),
	// and a second percentage of its area read as the same thing (the R5-B review).
	const full = d.fullAreaM2 && d.fullAreaM2 > 0 ? d.fullAreaM2 : null;
	const line = !l
		? t('No clear view of your dam from space yet. Clouds often hide it; the next clear view will show here.')
		: l.source === 's1'
			? full === null || l.wetAreaM2 > full
				? t('On {date} a radar satellite, which sees through cloud, saw water over about {area} of your dam.', { date: fmtDay(l.date), area: hectares(l.wetAreaM2) })
				: t('On {date} a radar satellite, which sees through cloud, saw water over about {area} of the {full} your dam covers when full.', { date: fmtDay(l.date), area: hectares(l.wetAreaM2), full: hectares(full) })
		: full === null
			? t('On {date} a satellite saw water over {area} of your dam.', { date: fmtDay(l.date), area: hectares(l.wetAreaM2) })
			: l.wetAreaM2 > full
				? t('On {date} a satellite saw water over {area}, more than the {full} your dam covers when full.', { date: fmtDay(l.date), area: hectares(l.wetAreaM2), full: hectares(full) })
				: t('On {date} a satellite saw water over {area} of the {full} your dam covers when full.', { date: fmtDay(l.date), area: hectares(l.wetAreaM2), full: hectares(full) });
	return {
		heading: t('Your dam, seen from space'),
		line,
		about: t('A satellite sees the water’s surface, not how deep it is: a check on the model, not a measurement of the water in your dam.'),
		credit: t('Satellite views: {credit}.', { credit: d.sentinelCredit ? `${d.attribution}. ${d.sentinelCredit}` : d.attribution })
	};
}
