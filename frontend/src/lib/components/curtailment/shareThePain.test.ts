import { describe, expect, it } from 'vitest';
import { DEMAND_PCT_FLOOR_M3_DAY, runModel, type CurtailmentFarm, type CurtailmentSummary, type CurtailmentUser, type ModelOutput } from '@water-management/engine';
import { randomInput } from '@water-management/engine/testing';
import { change, shareBand, shareThePain, stageCell, userLeftM3Day } from './shareThePain';

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

const user = (over: Partial<CurtailmentUser>): CurtailmentUser => ({
	nodeId: 'u',
	name: 'User',
	priority: 'senior',
	demandM3Day: 100,
	suppliedM3Day: 100,
	deficitM3Day: 0,
	fractionSupplied: 1,
	returnedM3Day: 0,
	ewrChargeM3Day: 0,
	curtailed: false,
	supplyCutM3Day: 0,
	supplyCutLs: 0,
	uncurtailedChargeM3Day: 0,
	...over
});

const summary = (farms: CurtailmentFarm[], equitableFraction: number | null, otherUsers?: CurtailmentUser[]): CurtailmentSummary => ({
	reportStart: '2020-01-01',
	reportEnd: '2020-12-31',
	days: 366,
	equitableFraction,
	farms,
	...(otherUsers ? { otherUsers } : {}),
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

describe('stageCell', () => {
	it('is the volume as a share of demand, as a whole %', () => {
		expect(stageCell(75, 100)).toEqual({ volumeM3Day: 75, fraction: 0.75, pct: '75%', pctTitle: null, volume: '75', band: 'short' });
	});
	it('never goes below 0 or above 100 %', () => {
		// A run before engine 0.17.0 could store a negative volume left (U = M + R).
		expect(stageCell(-40, 100)).toMatchObject({ volumeM3Day: 0, fraction: 0, pct: '0%', volume: '0' });
		expect(stageCell(120, 100)).toMatchObject({ fraction: 1, pct: '100%' });
	});
	it('says "no demand" for a group with no demand, never a %', () => {
		expect(stageCell(0, 0)).toMatchObject({ fraction: null, pct: 'no demand', volume: '0' });
		expect(stageCell(-30, 0)).toMatchObject({ volumeM3Day: 0, fraction: null, pct: 'no demand' });
	});
	it('marks a demand under the floor, where a % is not meaningful', () => {
		expect(stageCell(0.2, 0.5)).toMatchObject({ pct: '—', pctTitle: 'demand under 1 m³/day; % not meaningful' });
	});
});

describe('shareBand and change', () => {
	it('bands a share as every supply view does: 95 % and up, 70–95 %, under 70 %, none without demand', () => {
		expect([1, 0.95, 0.9499, 0.7, 0.6999, 0].map(shareBand)).toEqual(['met', 'met', 'short', 'short', 'low', 'low']);
		expect(shareBand(null)).toBe('none');
	});
	it('signs a change and points its arrow: down to reduce, up below the share, none when it rounds to 0', () => {
		expect(change(-197.54)).toEqual({ m3Day: -197.54, text: '−197.5', direction: 'down' });
		expect(change(314.9)).toEqual({ m3Day: 314.9, text: '+314.9', direction: 'up' });
		expect(change(0.01).direction).toBe('none');
		expect(change(Number.NaN)).toEqual({ m3Day: 0, text: '0', direction: 'none' });
	});
});

describe('shareThePain: farms', () => {
	// Supplied 150 of 200 m³/day in all: the equal share is 75 % of each farm's demand.
	const upper = farm({ nodeId: 'a', name: 'Upper', demandM3Day: 100, suppliedM3Day: 100, targetM3Day: 75, reduceGainM3Day: -25, ewrShortfallM3Day: -20, totalChangeM3Day: -40, volumeLeftM3Day: 60, ewrChargeStorageM3Day: 0 });
	const lower = farm({ nodeId: 'b', name: 'Lower', demandM3Day: 100, suppliedM3Day: 50, targetM3Day: 75, reduceGainM3Day: 25, totalChangeM3Day: 25, volumeLeftM3Day: 75 });
	const board = shareThePain(summary([upper, lower], 0.75));

	it('reads the three stages from the engine summary', () => {
		expect(board.farms.map((r) => [r.name, r.today.pct, r.share?.target.volume, r.share?.change.text, r.share?.target.pct, r.ewrStage.charge, r.ewrStage.totalChange.text, r.ewr.pct])).toEqual([
			['Upper', '100%', '75', '−25', '75%', '20', '−40', '60%'],
			['Lower', '50%', '75', '+25', '75%', '0', '+25', '75%']
		]);
		expect(board.farms.map((r) => [r.today.band, r.ewr.band])).toEqual([
			['met', 'low'],
			['low', 'short']
		]);
	});

	it('states the equal share once, as the equitable fraction, and every farm has it at stage 2', () => {
		expect(board.sharePct).toBe('75%');
		expect(board.farms.map((r) => r.share?.target.pct)).toEqual(['75%', '75%']);
	});

	it('totals each stage over the farms', () => {
		expect(board.farmTotals.demand).toBe('200');
		expect(board.farmTotals.today).toMatchObject({ volumeM3Day: 150, pct: '75%' });
		expect(board.farmTotals.share).toMatchObject({ target: { volumeM3Day: 150, pct: '75%' }, change: { text: '0', direction: 'none' } });
		expect(board.farmTotals.ewrStage).toMatchObject({ charge: '20', totalChange: { text: '−15' } });
		expect(board.farmTotals.ewr).toMatchObject({ volumeM3Day: 135, pct: '68%' });
		expect(board.userTotals).toBeNull();
		expect(board.users).toEqual([]);
	});

	it('cards each stage: short of demand today, what the equal share moves (net 0), the further cut for the EWR', () => {
		expect(board.cards).toEqual({
			deficit: { m3Day: 50, volume: '50', pct: '25%' },
			moved: { m3Day: 25, volume: '25', net: '0' },
			// 150 at the share, 135 left: 15 more for the EWR.
			ewrCut: { m3Day: 15, volume: '15', pct: '8%', storeLess: null }
		});
	});

	it('uses current names for renamed farms', () => {
		expect(shareThePain(summary([upper], 0.75), { a: 'Renamed' }).farms[0]!.name).toBe('Renamed');
	});

	it('shows a farm with no demand as "no demand" at every stage, never a negative demand, with its charge as store less', () => {
		// The client's sketch charged the EWR to a group with no demand and printed a negative final demand (planning-outputs.md).
		const dry = farm({
			nodeId: 'z',
			name: 'No crops',
			demandM3Day: 0,
			suppliedM3Day: 0,
			targetM3Day: 0,
			volumeLeftM3Day: 0,
			fractionSupplied: null,
			fractionOfDemandLeft: null,
			ewrShortfallM3Day: -12,
			ewrChargeIrrigationM3Day: 0,
			ewrChargeStorageM3Day: -12,
			ewrSupplyCutM3Day: 0
		});
		const [row] = shareThePain(summary([dry], 0.75)).farms;
		expect([row!.today.pct, row!.ewr.pct]).toEqual(['no demand', 'no demand']);
		expect(row!.ewr.volumeM3Day).toBe(0);
		expect(row!.ewrNotes).toEqual(['store less / pass inflow 12 m³/day']);
	});

	it('bounds a pre-0.17.0 negative volume left at 0', () => {
		const [row] = shareThePain(summary([farm({ demandM3Day: 10, targetM3Day: 7.5, volumeLeftM3Day: -20, fractionOfDemandLeft: -2 })], 0.75)).farms;
		expect(row!.ewr).toMatchObject({ volumeM3Day: 0, fraction: 0, pct: '0%' });
	});

	it('notes an EWR cut beyond the equitable share, and leaves out a charge that rounds to 0', () => {
		const [row] = shareThePain(summary([farm({ targetM3Day: 20, volumeLeftM3Day: 0, ewrCutBeyondShareM3Day: 5, ewrChargeStorageM3Day: -0.01 })], 0.2)).farms;
		expect(row!.ewrNotes).toEqual(['EWR cut exceeds its equitable share by 5 m³/day']);
	});

	it('notes what the basic-needs floor keeps of the cut (engine 1.44.0), and nothing when it keeps nothing', () => {
		const [row] = shareThePain(summary([farm({ targetM3Day: 20, volumeLeftM3Day: 25, basicNeedsM3Day: 25, basicNeedsHeldM3Day: 25 })], 0.2)).farms;
		expect(row!.ewr).toMatchObject({ volumeM3Day: 25, pct: '25%' });
		expect(row!.ewrNotes).toEqual(['basic needs keep 25 m³/day of the cut (floor 25 m³/day, 25 litres a person a day)']);
		const [held0] = shareThePain(summary([farm({ targetM3Day: 20, volumeLeftM3Day: 20, basicNeedsM3Day: 5, basicNeedsHeldM3Day: 0 })], 0.2)).farms;
		expect(held0!.ewrNotes).toEqual([]);
	});

	it('has no share, not "no demand", when farm demand is 0 but the engine still gave a fraction', () => {
		const b = shareThePain(summary([farm({ demandM3Day: 0, suppliedM3Day: 0, targetM3Day: 0, volumeLeftM3Day: 0 })], 0.5));
		expect(b.sharePct).toBeNull();
		expect(b.shareTooSmall).toBe(false);
	});

	it('flags a share too small to be a % when farm demand is under the floor, and gives one above it', () => {
		const under = shareThePain(summary([farm({ demandM3Day: DEMAND_PCT_FLOOR_M3_DAY / 2, suppliedM3Day: 0, targetM3Day: 0, volumeLeftM3Day: 0 })], 0.5));
		expect(under.sharePct).toBeNull();
		expect(under.shareTooSmall).toBe(true);
		const over = shareThePain(summary([farm({ demandM3Day: DEMAND_PCT_FLOOR_M3_DAY * 2, suppliedM3Day: 0, targetM3Day: 0, volumeLeftM3Day: 0 })], 0.5));
		expect(over.sharePct).toBe('50%');
		expect(over.shareTooSmall).toBe(false);
	});

	it('has no share with no farm demand, and zero totals', () => {
		const b = shareThePain(summary([farm({ demandM3Day: 0, suppliedM3Day: 0, targetM3Day: 0, volumeLeftM3Day: 0 })], null));
		expect(b.sharePct).toBeNull();
		expect(b.shareTooSmall).toBe(false);
		expect(b.farmTotals.today.pct).toBe('no demand');
		expect(b.farmTotals.ewr.pct).toBe('no demand');
		expect(b.cards.moved).toBeNull();
		expect(b.cards.deficit.pct).toBeNull();
	});

	it('cards the charge met by storing less, which takes no supply', () => {
		const c = summary([farm({ ewrShortfallM3Day: -12, ewrChargeStorageM3Day: -12 })], 1);
		c.totals.ewrChargeStorageM3Day = -12;
		expect(shareThePain(c).cards.ewrCut).toMatchObject({ m3Day: 0, storeLess: '12' });
	});
});

describe('shareThePain: other water users', () => {
	// A senior town: not curtailed, its charge stands. A junior user: cut for its charge, part of it beyond what it takes.
	const town = user({ nodeId: 't', name: 'Town', priority: 'senior', curtailed: false, demandM3Day: 800, suppliedM3Day: 600, ewrChargeM3Day: -50, uncurtailedChargeM3Day: -50 });
	const mill = user({
		nodeId: 'm',
		name: 'Mill',
		priority: 'junior',
		curtailed: true,
		demandM3Day: 200,
		suppliedM3Day: 200,
		ewrChargeM3Day: -300,
		supplyCutM3Day: -200,
		uncurtailedChargeM3Day: -150
	});
	const packer = user({ nodeId: 'p', name: 'Packer', priority: 'junior', curtailed: true, demandM3Day: 100, suppliedM3Day: 80, ewrChargeM3Day: -20, supplyCutM3Day: -30 });
	const board = shareThePain(summary([farm({})], 1, [town, mill, packer]));

	it('lists each user as its own row, marked senior or junior, after the farms', () => {
		expect(board.farms).toHaveLength(1);
		expect(board.users.map((r) => [r.name, r.kind, r.priority])).toEqual([
			['Town', 'user', 'senior'],
			['Mill', 'user', 'junior'],
			['Packer', 'user', 'junior']
		]);
	});

	it('leaves a senior user all it takes and says its charge stands', () => {
		const [row] = board.users;
		expect([row!.today.pct, row!.ewr.pct]).toEqual(['75%', '75%']);
		expect(row!.ewrNotes).toEqual(['not curtailed: its EWR charge of 50 m³/day stands']);
	});

	it('cuts a junior user by its supply cut, never below 0', () => {
		const mRow = board.users[1]!;
		expect(mRow.ewr).toMatchObject({ volumeM3Day: 0, pct: '0%' });
		expect(mRow.ewrNotes).toEqual(['150 m³/day of its EWR charge is more than it takes and stands']);
		const pRow = board.users[2]!;
		expect(pRow.ewr).toMatchObject({ volumeM3Day: 50, pct: '50%' });
		expect(pRow.ewrNotes).toEqual([]);
		expect(userLeftM3Day(user({ curtailed: true, suppliedM3Day: 10, supplyCutM3Day: -12 }))).toBe(0);
	});

	it('a priority user with a fixed restriction % (engine 1.86.0): cut by its supply cut, marked fixed %, no basic-needs floor', () => {
		const city = user({ nodeId: 'c', name: 'City', priority: 'senior', curtailed: true, restrictionPct: 0.3, demandM3Day: 1000, suppliedM3Day: 1000, ewrChargeM3Day: -500, supplyCutM3Day: -300, uncurtailedChargeM3Day: -200 });
		const [row] = shareThePain(summary([farm({})], 1, [city])).users;
		expect(row!.priority).toBe('senior');
		expect(row!.priorityLabel).toBe('priority, fixed 30 %');
		expect(row!.ewr).toMatchObject({ volumeM3Day: 700, pct: '70%' });
		expect(row!.ewrNotes).toEqual(['30 % fixed restriction, no basic-needs floor', '200 m³/day of its EWR charge is beyond its fixed % and stands']);
		expect(board.users.map((r) => r.priorityLabel)).toEqual(['priority, not curtailed', 'non-priority, curtailed', 'non-priority, curtailed']);
	});

	it('totals the users apart from the farms', () => {
		expect(board.userTotals).toMatchObject({ demand: '1\u202f100', today: { volumeM3Day: 880, pct: '80%' }, ewr: { volumeM3Day: 650, pct: '59%' } });
		expect(board.farmTotals.demand).toBe('100');
	});

	it('has no stage 2 for a user (outside the share); stage 3 is its charge and its cut from today', () => {
		expect(board.users.map((r) => [r.name, r.share, r.ewrStage.charge, r.ewrStage.totalChange.text])).toEqual([
			['Town', null, '50', '0'],
			['Mill', null, '300', '−200'],
			['Packer', null, '20', '−30']
		]);
		expect(board.userTotals!.share).toBeNull();
		// The cards count the users too: 220 of 1 200 short today, and the users' 230 cut on top of the farm's 0.
		expect(board.cards.deficit).toMatchObject({ m3Day: 220, pct: '18%' });
		expect(board.cards.ewrCut).toMatchObject({ m3Day: 230 });
	});
});

describe('shareThePain over seeded engine runs', () => {
	it('every stage stays in 0–100 %, the equal share is today\'s total %, and the farm totals match the engine', () => {
		let checked = 0;
		for (let seed = 1; seed < 200 && checked < 20; seed++) {
			const input = randomInput(seed, { maxDays: 300 });
			let run: ModelOutput;
			try {
				run = runModel({ ...input, settings: { ...input.settings, reportStart: null, reportEnd: null } });
			} catch {
				continue;
			}
			const c = run.summary.curtailment;
			if (!c?.farms.length || c.equitableFraction === null) continue;
			checked++;
			const b = shareThePain(c);
			for (const r of [...b.farms, ...b.users]) {
				for (const cell of [r.today, r.ewr]) {
					expect(cell.volumeM3Day).toBeGreaterThanOrEqual(0);
					if (cell.fraction !== null) {
						expect(cell.fraction).toBeGreaterThanOrEqual(0);
						expect(cell.fraction).toBeLessThanOrEqual(1);
					}
					expect(/^[-−]/.test(cell.pct)).toBe(false);
				}
			}
			// The identity issue #177 noted: the equal share's total is today's, so stage 2 moves water between farms and its net change is 0.
			expect(c.totals.targetM3Day).toBeCloseTo(c.totals.suppliedM3Day, 6);
			expect(b.farmTotals.share!.target.volumeM3Day).toBeCloseTo(c.totals.targetM3Day, 6);
			expect(b.farmTotals.share!.change.m3Day).toBeCloseTo(0, 6);
			for (const r of b.farms) {
				expect(r.share!.target.volumeM3Day).toBeGreaterThanOrEqual(0);
				// U = I + S: the volume left is today's supply plus the total change (bounded at 0).
				expect(r.ewr.volumeM3Day).toBeCloseTo(Math.max(r.today.volumeM3Day + r.ewrStage.totalChange.m3Day, 0), 6);
			}
			expect(b.cards.ewrCut.m3Day).toBeGreaterThanOrEqual(0);
			expect(b.cards.deficit.m3Day).toBeGreaterThanOrEqual(0);
			if (b.shareTooSmall) expect([b.sharePct, b.farmTotals.today.pct]).toEqual([null, '—']);
			else expect(b.sharePct).toBe(b.farmTotals.today.pct);
			expect(b.farmTotals.today.volumeM3Day).toBeCloseTo(c.totals.suppliedM3Day, 6);
			expect(b.farmTotals.ewr.volumeM3Day).toBeCloseTo(c.totals.volumeLeftM3Day, 6);
		}
		// Positive control: some seeded runs had farms with demand.
		expect(checked).toBeGreaterThan(0);
	});
});
