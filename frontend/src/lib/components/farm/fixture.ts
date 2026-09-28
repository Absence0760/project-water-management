// A FarmView for "Vaalbank" on the synthetic Sandspruit example catchment,
// with the figures of docs/design/farmer-view.md §3 (an engine 0.27.0 run of
// backend/scripts/examples, 1 Oct 2023 to 10 Jan 2024; figures.ts prints
// them). Invented data only: the repo is public. Used by the view-model tests
// to pin the rendered strings to the design's boards.
import type { FarmView } from '@water-management/engine';

const ML = 1000;
/** [month, needed ML, received ML, dam % at month end] (design §3, "Last 12 months"). */
const MONTHS: [string, number, number, number][] = [
	['2023-02', 104.4, 83.1, 16],
	['2023-03', 33.3, 26.5, 82],
	['2023-04', 71.8, 71.8, 100],
	['2023-05', 48.3, 48.3, 100],
	['2023-06', 40.6, 40.6, 100],
	['2023-07', 42.1, 42.1, 100],
	['2023-08', 76.8, 76.8, 82],
	['2023-09', 116.5, 116.5, 45],
	['2023-10', 111.3, 111.3, 20],
	['2023-11', 106.1, 67.5, 17],
	['2023-12', 110.0, 96.3, 25],
	['2024-01', 49.2, 49.2, 24]
];

export function vaalbankFixture(): FarmView {
	return {
		project: { id: 'p-sandspruit', name: 'Sandspruit (example catchment)' },
		farm: {
			nodeId: 'n-vaalbank',
			name: 'Vaalbank (example)',
			damCapacityM3: 350_000,
			damMinPct: 0.15,
			irrigationEfficiency: 0.75,
			dataUntil: '2024-01-10',
			season: {
				from: '2023-10-01',
				to: '2024-01-10',
				demandM3: 376_466,
				suppliedM3: 324_247,
				fraction: 324_247 / 376_466,
				shortDays: 16,
				shortMonths: ['2023-11', '2023-12'],
				shortDaysAtStopLevel: 16
			},
			last30: { from: '2023-12-12', to: '2024-01-10', demandM3: 113_810, suppliedM3: 113_283, fraction: 113_283 / 113_810 },
			dam: {
				pct: 0.2426,
				storageM3: 83_640,
				usableM3: 32_412,
				pct30dAgo: 0.15,
				lastSpill: '2023-07-27',
				use14M3Day: 5_074,
				usableDays: 32_412 / 5_074
			},
			lastSeason: { from: '2022-10-01', to: '2023-01-10', fraction: 0.646, damPct: 0.168 },
			monthly: MONTHS.map(([month, need, got, dam]) => ({
				month,
				demandM3: need * ML,
				suppliedM3: got * ML,
				damPctEnd: dam / 100
			})),
			river: {
				demandM3Day: 3690.8,
				suppliedM3Day: 3178.9,
				supplyCutM3Day: 121.2,
				storageM3Day: 65.4,
				chargedDays: 56,
				windowDays: 102,
				perChargedDaySupplyCutM3: (121.2 * 102) / 56,
				perChargedDayStorageM3: (65.4 * 102) / 56,
				headline: 0.8285,
				band: 'watch',
				equitableFraction: 0.893,
				aboveBelowShareM3Day: 118.0,
				cutBeyondShare: false,
				sites: [
					{ name: 'Sandspruit Outlet', daysNotMet: 52, daysOnlyNatural: 0 },
					{ name: 'Melkhout Gauge', daysNotMet: 44, daysOnlyNatural: 0 }
				],
				bindingSite: 'Sandspruit Outlet'
			}
		},
		context: { farmsUpstream: 1, farmsDownstream: 2, farmCount: 8 },
		publication: {
			publishedAt: '2024-01-12T08:00:00Z',
			publishedBy: 'Example WUA',
			engineVersion: '0.27.0',
			restriction: {
				level: 'advisory',
				pct: null,
				notice: {
					en: 'Please cut back where you can\nThe river at the outlet is below its reserve. Irrigate at night and cut back where you can. The board meets on 20 Jan to decide on restrictions.'
				}
			},
			nextExpectedOn: null
		},
		outlet30: { name: 'Sandspruit Outlet', daysNotMet: 30, days: 30 },
		stale: false
	};
}
