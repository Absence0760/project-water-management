// The Data page's "On this page" menu (common/SectionNav): its panels run to
// two or three screens under the table and the chart (double mass, data
// checks, what the model uses). The ids are set on the panels in
// SeriesTab.svelte. Data feeds (feeds/DataFeedsPanel.svelte, moved here from
// Settings in issue #586) is always drawn: it is how series fill themselves. Uploading is the header's Add data dialog; the Upload CSV
// panel that repeated it is gone, and its `#upload-csv` is a retired id.
import type { NavGroup } from '#lib/components/common/sectionNav.js';

/** Every panel id, in page order. */
export const DATA_ANCHORS = ['data-series', 'data-chart', 'data-feeds', 'data-agreement', 'data-double-mass', 'data-gap-rain', 'data-checks', 'data-uses'] as const;

/** True for a fragment (without the `#`) naming one of the Data page's panels. */
export function dataAnchor(hash: string): boolean {
	return (DATA_ANCHORS as readonly string[]).includes(hash);
}

/**
 * Where a retired panel id now lands, or null: `#upload-csv` (the removed
 * Upload CSV panel) goes to the series list. SeriesTab opens Add data for an
 * editor instead.
 */
export function retiredDataAnchor(hash: string): (typeof DATA_ANCHORS)[number] | null {
	return hash === 'upload-csv' ? 'data-series' : null;
}

/** Which of the page's conditional panels are drawn. */
export interface DataPanels {
	/** A series is picked, so its chart shows. */
	chart: boolean;
	/** Gauge vs logger agreement: both an observed gauge and a logger. */
	agreement: boolean;
	/** Double mass: catchment rain and CHIRPS, long enough to compare. */
	doubleMass: boolean;
	/** Rain products side by side: settings.gapRain chooses ERA5-Land or IMERG Late (issue #604 R4-E). Optional: absent is off. */
	gapRain?: boolean;
	/** Data checks: once the series' values are in. */
	checks: boolean;
}

/** The menu's groups, only the panels the page draws, in page order; empty groups left out. */
export function dataNavGroups(p: DataPanels): NavGroup[] {
	const groups: NavGroup[] = [
		{
			label: 'Series',
			// Each link says its panel's heading, on the bar too: "Series" there read as the group's own name (issue #586).
			sections: [
				{ id: 'data-series', label: 'Input time series' },
				...(p.chart ? [{ id: 'data-chart', label: 'Series chart' }] : []),
				// The feeds that fill the series daily (issue #586: from Settings); its heading word for word.
				{ id: 'data-feeds', label: 'Data feeds' }
			]
		},
		{
			label: 'Checks',
			// Each by its heading word for word, on the bar too (issue #586 R4-M): all seven still fit two rows at 1280 px.
			sections: [
				...(p.agreement ? [{ id: 'data-agreement', label: 'Gauge vs logger agreement' }] : []),
				...(p.doubleMass ? [{ id: 'data-double-mass', label: 'Double mass: catchment rain vs CHIRPS' }] : []),
				...(p.gapRain ? [{ id: 'data-gap-rain', label: 'Rain products side by side' }] : []),
				...(p.checks ? [{ id: 'data-checks', label: 'Data checks' }] : [])
			]
		},
		{
			label: 'Reference',
			sections: [{ id: 'data-uses', label: 'What the model uses' }]
		}
	];
	return groups.filter((g) => g.sections.length > 0);
}
