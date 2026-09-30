import { describe, expect, it } from 'vitest';
import { runModel, type CurtailmentFarm, type CurtailmentSummary, type ModelOutput } from '@water-management/engine';
import { randomInput } from '@water-management/engine/testing';
import { fmtNum } from '$lib/format/number';
import { actionOf, curtailmentRows, cutCount, ewrSiteRows, fmtCharged, fmtDemandLeft, fmtSigned, fmtVol } from './curtailment';

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
		expect(fmtSigned(-1234.5)).toBe('-1\u202f234.5');
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
		expect(fmtVol(12345)).toBe('12\u202f345');
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
			ewrShortfall: '5',
			totalChange: '-38.3',
			totalChangeLs: '-0.4',
			demandLeftPct: '62%',
			verdict: 'cut 38.3 m³/day'
		});
		expect(b).toMatchObject({ name: 'B', action: 'gain', suppliedPct: '–', demandLeftPct: 'no demand', verdict: 'below its equitable share by 12.5 m³/day' });
		// Q11: the fair share is a benchmark, so no row ever says a farm may "gain" water.
		for (const r of curtailmentRows(c)) expect(r.verdict).not.toMatch(/gain/i);
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

describe('demand left % (Q13)', () => {
	it('says "no demand" for a farm without demand', () => {
		expect(fmtDemandLeft(0, null)).toEqual({ text: 'no demand', title: null });
	});
	it('shows a dash with a tooltip below the 1 m³/day floor', () => {
		expect(fmtDemandLeft(0.4, 0.5)).toEqual({ text: '—', title: 'demand under 1 m³/day; % not meaningful' });
	});
	it('shows whole percentages, <1% and >99% at the ends, never outside 0–100', () => {
		const t = (f: number) => fmtDemandLeft(100, f).text;
		expect([t(0), t(0.004), t(0.005), t(0.617), t(0.994), t(0.995), t(1)]).toEqual(['0%', '<1%', '1%', '62%', '99%', '>99%', '100%']);
		// A run from before engine 0.17.0 could hold a negative volume left.
		expect([t(-0.3), t(1.2)]).toEqual(['0%', '100%']);
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
		// The charge and its parts are volumes charged (positive, issue #45); the supply cut is a change (negative).
		expect(a).toMatchObject({ ewrShortfall: '30', ewrIrrigation: '12', ewrStorage: '18', supplyCut: '-16', supplyCutLs: '-0.2', bindingSite: 'Weir (renamed)' });
		expect(b).toMatchObject({ ewrIrrigation: '0', ewrStorage: '0', supplyCut: '0', bindingSite: '' });
	});

	it('Q13: a farm with only a storage charge is told to store less / pass inflow, and a cut beyond its share is flagged', () => {
		const [z, f] = curtailmentRows(
			summary([
				farm({ nodeId: 'z', demandM3Day: 0, fractionOfDemandLeft: null, ewrShortfallM3Day: -10, ewrChargeIrrigationM3Day: 0, ewrChargeStorageM3Day: -10, ewrSupplyCutM3Day: 0 }),
				farm({ nodeId: 'f', totalChangeM3Day: -50, volumeLeftM3Day: 0, fractionOfDemandLeft: 0, ewrCutBeyondShareM3Day: 40 })
			])
		);
		expect(z).toMatchObject({ action: 'store', verdict: 'store less / pass inflow 10 m³/day', demandLeftPct: 'no demand', beyondShare: '' });
		expect(f).toMatchObject({ action: 'cut', demandLeftPct: '0%', beyondShare: '40' });
	});

	it('shows what the basic-needs floor keeps of the cut (engine 1.38.0), and nothing without a floor', () => {
		const [held, none, old] = curtailmentRows(
			summary([
				farm({ nodeId: 'h', totalChangeM3Day: -75, volumeLeftM3Day: 25, basicNeedsM3Day: 25, basicNeedsHeldM3Day: 25 }),
				farm({ nodeId: 'n', basicNeedsM3Day: 5, basicNeedsHeldM3Day: 0 }),
				farm({ nodeId: 'o' })
			])
		);
		expect(held).toMatchObject({ basicNeedsHeld: '25', basicNeeds: '25', volumeLeft: '25' });
		expect(none).toMatchObject({ basicNeedsHeld: '', basicNeeds: '5' });
		expect(old).toMatchObject({ basicNeedsHeld: '', basicNeeds: '' });
	});

	it('lists each EWR site with its days not met, shortfall, charged and natural parts', () => {
		expect(ewrSiteRows(c)).toEqual([
			{ nodeId: 'o', name: 'Outlet gauge (outlet)', farmCount: 2, daysNotMet: '40', shortfall: '50', charged: '30', natural: '20' },
			{ nodeId: 'g', name: 'Weir', farmCount: 1, daysNotMet: '3', shortfall: '30', charged: '30', natural: '0' }
		]);
		expect(ewrSiteRows(summary([]))).toEqual([]);
	});
});

describe('the EWR charge reads the same in the Farms table and the curtailment table (issue #45)', () => {
	it('shows one farm the same positive volume in both, over the whole run', () => {
		expect(fmtCharged(-30)).toBe('30');
		expect(fmtCharged(0)).toBe('0');
		expect(fmtCharged(null)).toBe('–');
		let charged = 0;
		for (let seed = 1; seed < 400 && charged < 5; seed++) {
			const input = randomInput(seed, { maxDays: 400 });
			let run: ModelOutput;
			try {
				run = runModel({ ...input, settings: { ...input.settings, reportStart: null, reportEnd: null } });
			} catch {
				continue;
			}
			const c = run.summary.curtailment;
			if (!c?.farms.length) continue;
			const rows = curtailmentRows(c);
			for (const f of run.summary.farms) {
				const i = c.farms.findIndex((x) => x.nodeId === f.nodeId);
				if (!(f.avgEwrShortfallM3Day > 0.5)) continue;
				charged++;
				// The Farms table shows FarmSummary.avgEwrShortfallM3Day as it is; the curtailment table the same farm's R.
				expect(f.avgEwrShortfallM3Day).toBeGreaterThan(0);
				expect(0 - c.farms[i]!.ewrShortfallM3Day).toBeCloseTo(f.avgEwrShortfallM3Day, 6);
				expect(rows[i]!.ewrShortfall).toBe(fmtNum(f.avgEwrShortfallM3Day, 0, true));
				expect(rows[i]!.ewrShortfall.startsWith('-')).toBe(false);
			}
		}
		// Positive control: some seeded farms were charged.
		expect(charged).toBeGreaterThan(0);
	});
});
