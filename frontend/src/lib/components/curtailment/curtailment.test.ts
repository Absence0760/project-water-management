import { describe, expect, it } from 'vitest';
import type { CurtailmentFarm, CurtailmentSummary } from '@water-management/engine';
import { actionOf, curtailmentRows, cutCount, ewrSiteRows, fmtSigned, fmtVol } from './curtailment';

const farm = (over: Partial<CurtailmentFarm>): CurtailmentFarm => ({
	nodeId: 'n',
	name: 'Farm',
	demandM3Day: 100,
	suppliedM3Day: 100,
	deficitM3Day: 0,
	fractionSupplied: 1,
	targetM3Day: 100,
	reduceGainM3Day: 0,
	reduceGainLs: 0,
	targetFraction: 1,
	ewrShortfallM3Day: 0,
	totalChangeM3Day: 0,
	totalChangeLs: 0,
	volumeLeftM3Day: 100,
	fractionOfDemandLeft: 1,
	...over
});

const summary = (farms: CurtailmentFarm[]): CurtailmentSummary => ({
	reportStart: '2020-01-01',
	reportEnd: '2020-12-31',
	days: 366,
	equitableFraction: 2 / 3,
	farms,
	totals: {
		demandM3Day: 0,
		suppliedM3Day: 0,
		deficitM3Day: 0,
		targetM3Day: 0,
		reduceGainM3Day: 0,
		reduceGainLs: 0,
		ewrShortfallM3Day: 0,
		totalChangeM3Day: 0,
		volumeLeftM3Day: 0
	}
});

describe('fmtSigned', () => {
	it('prefixes gains with + and keeps the minus on cuts', () => {
		expect(fmtSigned(33.3)).toBe('+33.3');
		expect(fmtSigned(-38.3)).toBe('-38.3');
		expect(fmtSigned(-1234.5)).toBe('-1,234.5');
	});
	it('trims a trailing .0 and never shows a signed zero', () => {
		expect(fmtSigned(12)).toBe('+12');
		expect(fmtSigned(0)).toBe('0');
		expect(fmtSigned(-0)).toBe('0');
		expect(fmtSigned(-0.04)).toBe('0'); // rounds to 0 at 1 dp
		expect(fmtSigned(-12.4, 0)).toBe('-12');
	});
	it('shows a dash for missing values', () => {
		expect(fmtSigned(null)).toBe('–');
		expect(fmtSigned(NaN)).toBe('–');
	});
});

describe('fmtVol', () => {
	it('shows at most one decimal with separators', () => {
		expect(fmtVol(12345)).toBe('12,345');
		expect(fmtVol(66.7)).toBe('66.7');
	});
});

describe('actionOf', () => {
	it('classifies the total change', () => {
		expect(actionOf(-0.1)).toBe('cut');
		expect(actionOf(0)).toBe('none');
		expect(actionOf(3)).toBe('gain');
	});
});

describe('curtailmentRows', () => {
	const c = summary([
		farm({
			nodeId: 'a',
			name: 'Old name',
			reduceGainM3Day: -33.3,
			reduceGainLs: -0.3,
			ewrShortfallM3Day: -5,
			totalChangeM3Day: -38.3,
			totalChangeLs: -0.4,
			fractionOfDemandLeft: 0.617
		}),
		farm({
			nodeId: 'b',
			name: 'B',
			demandM3Day: 0,
			fractionSupplied: null,
			fractionOfDemandLeft: null,
			reduceGainM3Day: 12.5,
			totalChangeM3Day: 12.5
		}),
		farm({ nodeId: 'c', name: 'C' })
	]);

	it('formats each column and summarises what the farm must do', () => {
		const [a, b, cc] = curtailmentRows(c, { a: 'Renamed' });
		expect(a).toMatchObject({
			name: 'Renamed',
			action: 'cut',
			reduceGain: '-33.3',
			reduceGainLs: '-0.3',
			ewrShortfall: '-5',
			totalChange: '-38.3',
			totalChangeLs: '-0.4',
			demandLeftPct: '61.7%',
			verdict: 'cut 38.3 m³/day'
		});
		expect(b).toMatchObject({ name: 'B', action: 'gain', suppliedPct: '–', demandLeftPct: '–', verdict: 'may gain 12.5 m³/day' });
		expect(cc).toMatchObject({ action: 'none', totalChange: '0', verdict: 'no change' });
	});

	it('counts the farms that must cut', () => {
		expect(cutCount(c)).toBe(1);
	});

	it('shows "–" for the EWR split on a run made before engine 0.17.0', () => {
		const [a] = curtailmentRows(c);
		expect(a).toMatchObject({ ewrIrrigation: '–', ewrStorage: '–', supplyCut: '–', supplyCutLs: '–', bindingSite: '' });
	});
});

describe('EWR attribution columns and sites (Q17, engine 0.17.0)', () => {
	const c: CurtailmentSummary = {
		...summary([
			farm({
				nodeId: 'a',
				ewrShortfallM3Day: -30,
				ewrChargeIrrigationM3Day: -12,
				ewrChargeStorageM3Day: -18,
				ewrSupplyCutM3Day: -16,
				ewrSupplyCutLs: -16 / 86.4,
				ewrBindingSiteId: 'g'
			}),
			farm({ nodeId: 'b', ewrChargeIrrigationM3Day: 0, ewrChargeStorageM3Day: 0, ewrSupplyCutM3Day: 0, ewrSupplyCutLs: 0, ewrBindingSiteId: null })
		]),
		ewrAttribution: 'netImpactProRata',
		ewrSites: [
			{ nodeId: 'o', name: 'Outlet gauge', isOutlet: true, farmCount: 2, daysNotMet: 40, shortfallM3Day: -50, chargedM3Day: -30, naturalM3Day: -20 },
			{ nodeId: 'g', name: 'Weir', isOutlet: false, farmCount: 1, daysNotMet: 3, shortfallM3Day: -30, chargedM3Day: -30, naturalM3Day: 0 }
		]
	};

	it('splits the charge into irrigate less and store less, with the supply cut and the binding site', () => {
		const [a, b] = curtailmentRows(c, { g: 'Weir (renamed)' });
		expect(a).toMatchObject({ ewrShortfall: '-30', ewrIrrigation: '-12', ewrStorage: '-18', supplyCut: '-16', supplyCutLs: '-0.2', bindingSite: 'Weir (renamed)' });
		expect(b).toMatchObject({ ewrIrrigation: '0', ewrStorage: '0', supplyCut: '0', bindingSite: '' });
	});

	it('lists each EWR site with its days not met, shortfall, charged and natural parts', () => {
		expect(ewrSiteRows(c)).toEqual([
			{ nodeId: 'o', name: 'Outlet gauge (outlet)', farmCount: 2, daysNotMet: '40', shortfall: '-50', charged: '-30', natural: '-20' },
			{ nodeId: 'g', name: 'Weir', farmCount: 1, daysNotMet: '3', shortfall: '-30', charged: '-30', natural: '0' }
		]);
		expect(ewrSiteRows(summary([]))).toEqual([]);
	});
});
