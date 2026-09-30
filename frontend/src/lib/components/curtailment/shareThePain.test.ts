import { describe, expect, it } from 'vitest';
import { DEMAND_PCT_FLOOR_M3_DAY, runModel, type CurtailmentFarm, type CurtailmentSummary, type CurtailmentUser, type ModelOutput } from '@water-management/engine';
import { randomInput } from '@water-management/engine/testing';
import { shareThePain, stageCell, userLeftM3Day } from './shareThePain';

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
		expect(stageCell(75, 100)).toEqual({ volumeM3Day: 75, fraction: 0.75, pct: '75%', pctTitle: null, volume: '75' });
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

describe('shareThePain: farms', () => {
	// Supplied 150 of 200 m³/day in all: the equal share is 75 % of each farm's demand.
	const upper = farm({ nodeId: 'a', name: 'Upper', demandM3Day: 100, suppliedM3Day: 100, targetM3Day: 75, volumeLeftM3Day: 60, ewrChargeStorageM3Day: 0 });
	const lower = farm({ nodeId: 'b', name: 'Lower', demandM3Day: 100, suppliedM3Day: 50, targetM3Day: 75, volumeLeftM3Day: 75 });
	const board = shareThePain(summary([upper, lower], 0.75));

	it('reads the two stages from the engine summary', () => {
		expect(board.farms.map((r) => [r.name, r.today.pct, r.ewr.pct])).toEqual([
			['Upper', '100%', '60%'],
			['Lower', '50%', '75%']
		]);
	});

	it('states the equal share once, as the equitable fraction', () => {
		expect(board.sharePct).toBe('75%');
		expect(board.farms[0]).not.toHaveProperty('share');
	});

	it('totals each stage over the farms', () => {
		expect(board.farmTotals.demand).toBe('200');
		expect(board.farmTotals.today).toMatchObject({ volumeM3Day: 150, pct: '75%' });
		expect(board.farmTotals).not.toHaveProperty('share');
		expect(board.farmTotals.ewr).toMatchObject({ volumeM3Day: 135, pct: '68%' });
		expect(board.userTotals).toBeNull();
		expect(board.users).toEqual([]);
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

	it('totals the users apart from the farms', () => {
		expect(board.userTotals).toMatchObject({ demand: '1\u202f100', today: { volumeM3Day: 880, pct: '80%' }, ewr: { volumeM3Day: 650, pct: '59%' } });
		expect(board.farmTotals.demand).toBe('100');
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
					expect(cell.pct.startsWith('-')).toBe(false);
				}
			}
			// The identity that made the equal share one sentence rather than a stage (issue #177): its total is today's.
			expect(c.totals.targetM3Day).toBeCloseTo(c.totals.suppliedM3Day, 6);
			if (b.shareTooSmall) expect([b.sharePct, b.farmTotals.today.pct]).toEqual([null, '—']);
			else expect(b.sharePct).toBe(b.farmTotals.today.pct);
			expect(b.farmTotals.today.volumeM3Day).toBeCloseTo(c.totals.suppliedM3Day, 6);
			expect(b.farmTotals.ewr.volumeM3Day).toBeCloseTo(c.totals.volumeLeftM3Day, 6);
		}
		// Positive control: some seeded runs had farms with demand.
		expect(checked).toBeGreaterThan(0);
	});
});
