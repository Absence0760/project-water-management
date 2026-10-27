// The dam page's "Your dam, seen from space" (issue #604 R5-B; docs/ui.md §
// Farmer view, docs/design/farmer-view.md §3 Q3). The newest clear satellite
// view of the farm's dam (GET …/farm/:nodeId/dam-observed), in plain words:
// its date and the water's area against the area the dam covers when full.
// Pure wording, from the message catalogue ($lib/i18n, WP-2.5).
import type { FarmDamObserved } from '#lib/api/types.js';
import { t } from '#lib/i18n/locale.svelte.js';
import { hectares } from './farmMap';
import { fmtDay, fmtPct } from './format';

export interface DamObservedVm {
	heading: string;
	/** The newest clear view in words, or why there is none yet. */
	line: string;
	/** What a satellite can and can't tell. */
	about: string;
	/** The credit the data's licence asks for (CC BY 4.0). */
	credit: string;
}

/** null when none of the farm's dams is drawn as an outline on the map: the page shows nothing. */
export function damObservedCard(d: FarmDamObserved | null): DamObservedVm | null {
	if (!d || d.outlines < 1) return null;
	// i18n-section: farm.damPage
	const l = d.latest;
	const line = !l
		? t('No clear view of your dam from space yet. Clouds often hide it; the next clear view will show here.')
		: d.fullAreaM2 && d.fullAreaM2 > 0
			? t('On {date} a satellite saw water over {area} of your dam, about {pct} of the area it covers when full.', {
					date: fmtDay(l.date),
					area: hectares(l.wetAreaM2),
					pct: fmtPct(l.wetAreaM2 / d.fullAreaM2)
				})
			: t('On {date} a satellite saw water over {area} of your dam.', { date: fmtDay(l.date), area: hectares(l.wetAreaM2) });
	return {
		heading: t('Your dam, seen from space'),
		line,
		about: t('A satellite sees the water’s surface, not how deep it is: a check on the model, not a measurement of the water in your dam.'),
		credit: t('Satellite views: {credit}.', { credit: d.attribution })
	};
}
