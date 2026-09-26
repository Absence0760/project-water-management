// Seeded random scenario op lists (roadmap WP-3.2) for the property tests in
// ../scenario/*.test.ts. Ops mostly target elements the input has, with
// in-range values, and now and then a missing id, an edit that breaks the
// network (a duplicate name, a loop-free but invalid transfer end) or a
// target an earlier op removed, so applyScenario's problem path runs too.
// A pure function of the seed.
import { fromEpochDay, toEpochDay } from '../calendar';
import { BOREHOLE_RULES, DAM_RELEASE_RULES, LAND_COVER_CLASSES, USER_PRIORITIES, type ModelInput, type NetworkNode } from '../project';
import { Rng } from '../random';
import { NODE_SET_FIELDS, SCALABLE_SERIES_KINDS, type NodeSetField, type ScenarioOp, type SettingsPath } from '../scenario/ops';

const monthly = (g: Rng, f: () => number) => Array.from({ length: 12 }, f);

function nodeValue(g: Rng, field: NodeSetField, n: NetworkNode): unknown {
	switch (field) {
		case 'name':
			return g.bool(0.1) ? g.pick(['Node 0', 'Node 1', 'node 2']) : `${n.name} (scenario ${g.int(0, 999)})`;
		case 'areaKm2':
		case 'areaHiKm2':
		case 'areaLoKm2':
			return g.bool(0.1) ? 0 : g.logFloat(0.01, 150);
		case 'flowShareManual':
			return g.bool(0.2) ? null : g.frac();
		case 'damCapacityM3':
			return g.bool(0.2) ? 0 : n.damCapacityM3 > 0 && g.bool(0.5) ? n.damCapacityM3 * 1.2 : g.logFloat(10, 3e6);
		case 'divertCapacityM3Day':
			return g.bool(0.2) ? 0 : g.logFloat(1, 1e5);
		case 'damAreaFullM2':
			return g.pick([null, 0, g.logFloat(1, 1e6)]);
		case 'damAreaExponent':
			return g.float(0.05, 3);
		case 'irrigationEfficiency':
			return g.bool(0.2) ? 1 : g.float(0.05, 1);
		case 'boreholeCapacityM3Day':
			return g.pick([null, 0, g.logFloat(1, 1e5)]);
		case 'boreholeRule':
			return g.pick(BOREHOLE_RULES);
		case 'damReleaseRule':
			return g.pick(DAM_RELEASE_RULES);
		case 'damReleaseM3Day':
			return g.bool(0.3) ? null : monthly(g, () => (g.bool(0.2) ? 0 : g.float(0, 1e4)));
		case 'damOutletCapacityM3Day':
			return g.pick([null, 0, g.logFloat(1, 1e5)]);
		case 'streamDepletionLagDays':
			return g.pick([0, g.float(0, 30)]);
		case 'userDemandM3Day':
			return g.bool(0.1) ? null : monthly(g, () => (g.bool(0.2) ? 0 : g.float(0, 1e5)));
		case 'userPriority':
			return g.pick(USER_PRIORITIES);
		default:
			// Every other editable node field is a fraction 0–1.
			return g.frac();
	}
}

function settingsOp(g: Rng, input: ModelInput): ScenarioOp {
	const rain = input.series.rain_catchment_mm ?? input.series.rain_chirps_mm;
	const start = rain ? toEpochDay(rain.startDate) : toEpochDay('2000-01-01');
	const len = rain ? rain.values.length : 365;
	const date = () => (g.bool(0.2) ? null : fromEpochDay(start + g.int(0, Math.max(0, len - 1))));
	const choices: [SettingsPath, () => unknown][] = [
		['effectiveRainFraction', () => g.frac()],
		['effectiveRainStoreMm', () => g.pick([0, 25, g.float(0, 500)])],
		['lakeEvapFactor', () => g.float(0, 2)],
		['apanMm', () => monthly(g, () => g.float(0, 300))],
		['panCoefficient', () => monthly(g, () => g.float(0.3, 1.2))],
		['pe', () => (g.bool(0.3) ? { kind: 'pan' } : { kind: 'monthly', mm: monthly(g, () => g.float(0, 250)), source: g.pick(['station ET₀', 'A-pan × 0.8, corrected']) })],
		['ewrPragmaticM3PerDay', () => monthly(g, () => g.pick([0, g.float(0, 1e5)]))],
		['flowShareMethod', () => g.pick(['area', 'hiLo', 'manual'])],
		['hiLoSplit.hi', () => g.frac()],
		['runoffModel', () => g.pick(['legacy', 'gr4j'])],
		['gr4j.x1', () => g.float(10, 3000)],
		['gr4j.x4', () => g.float(0.5, 10)],
		['chirpsBiasCorrection', () => g.pick(['monthly', 'none'])],
		['zeroRainRuns.mode', () => g.pick(['missing', 'asRecorded'])],
		['calibration.a', () => g.logFloat(0.001, 1)],
		['calibration.summerMonths', () => [...new Set(Array.from({ length: g.int(0, 8) }, () => g.int(1, 12)))]],
		['reportStart', date],
		['reportEnd', date],
		['calibrationStart', date],
		['calibrationEnd', date],
		['calibrationFlowKind', () => g.pick([null, 'flow_observed_m3s', 'flow_logger_m3s'])]
	];
	const [path, value] = g.pick(choices);
	return { op: 'settings.set', path, value: value() } as ScenarioOp;
}

/**
 * `count` random ops (default 1–8) against `input`. Ids of new elements are
 * "sn<k>", "sc<k>", "st<k>", "sl<k>", unique within one list.
 */
export function randomOps(input: ModelInput, seed: number, count?: number): ScenarioOp[] {
	const g = new Rng(seed ^ 0x7f4a7c15);
	const n = count ?? g.int(1, 8);
	const ops: ScenarioOp[] = [];
	// Ids seen so far, including ones earlier ops add (removed ones stay: a stale target is a case too).
	const nodes = [...input.model.nodes];
	const crops = input.model.crops.map((c) => c.id);
	const transfers = input.model.transfers.map((t) => t.id);
	const patches = (input.model.landCover ?? []).map((p) => p.id);
	const missing = () => `missing-${g.int(0, 99)}`;
	for (let k = 0; k < n; k++) {
		const kind = g.pick(['node.set', 'node.set', 'node.set', 'node.add', 'node.remove', 'cropArea.set', 'cropArea.set', 'crop.add', 'transfer.add', 'transfer.set', 'transfer.remove', 'landCover.add', 'landCover.remove', 'settings.set', 'series.scale'] as const);
		const node = () => (nodes.length && !g.bool(0.05) ? g.pick(nodes) : null);
		switch (kind) {
			case 'node.set': {
				const x = node();
				if (!x) {
					ops.push({ op: 'node.set', nodeId: missing(), field: 'damCapacityM3', value: 1 });
					break;
				}
				// Now and then a field the node's kind doesn't have (a problem).
				const fields: readonly NodeSetField[] = g.bool(0.05) ? NODE_SET_FIELDS.farm : NODE_SET_FIELDS[x.kind];
				const field = g.pick(fields);
				ops.push({ op: 'node.set', nodeId: x.id, field, value: nodeValue(g, field, x) } as ScenarioOp);
				break;
			}
			case 'node.add': {
				const into = node();
				const id = `sn${k}`;
				const kindOf = g.pick(['farm', 'farm', 'user', 'gauge'] as const);
				const added: NetworkNode = {
					id,
					name: `Scenario node ${k}`,
					kind: kindOf,
					downstreamNodeId: into?.id ?? missing(),
					sortOrder: g.int(-10, 100),
					areaKm2: kindOf === 'farm' && g.bool(0.5) ? g.logFloat(0.1, 20) : 0,
					areaHiKm2: 0,
					areaLoKm2: 0,
					flowShareManual: kindOf === 'farm' && g.bool(0.2) ? g.frac() : null,
					pctUpstreamToDam: kindOf === 'farm' ? g.frac() : 0,
					pctRunoffToDam: kindOf === 'farm' ? g.frac() : 0,
					damCapacityM3: kindOf === 'farm' && g.bool(0.7) ? g.logFloat(100, 1e6) : 0,
					damInitialPct: g.frac(),
					damMinPct: g.frac(0.5, 0),
					divertCapacityM3Day: kindOf === 'farm' ? g.logFloat(1, 1e5) : 0,
					irrigationEfficiency: g.float(0.5, 1),
					lossReturnFraction: g.frac(),
					damAreaFullM2: null,
					damAreaExponent: 0.7,
					damSeepagePerDay: 0,
					...(kindOf === 'user' ? { userDemandM3Day: monthly(g, () => g.float(0, 1e4)), userReturnPct: g.frac(), userPriority: g.pick(USER_PRIORITIES) } : {})
				};
				ops.push({ op: 'node.add', node: added });
				nodes.push(added);
				break;
			}
			case 'node.remove': {
				const x = node();
				ops.push({ op: 'node.remove', nodeId: x?.id ?? missing() });
				break;
			}
			case 'cropArea.set': {
				const x = node();
				const crop = crops.length && !g.bool(0.05) ? g.pick(crops) : missing();
				ops.push({ op: 'cropArea.set', nodeId: x?.id ?? missing(), cropId: crop, areaM2: g.bool(0.2) ? 0 : g.float(0, 1e6) });
				break;
			}
			case 'crop.add': {
				const id = `sc${k}`;
				ops.push({ op: 'crop.add', crop: { id, name: g.bool(0.05) ? 'Crop 0' : `Scenario crop ${k}`, cropFactor: monthly(g, () => g.float(0, 1.3)) } });
				crops.push(id);
				break;
			}
			case 'transfer.add': {
				const a = node();
				const b = node();
				const id = `st${k}`;
				ops.push({
					op: 'transfer.add',
					transfer: {
						id,
						fromNodeId: a?.id ?? missing(),
						toNodeId: b?.id ?? missing(),
						months: [...new Set(Array.from({ length: g.int(0, 12) }, () => g.int(1, 12)))],
						maxRateM3s: g.logFloat(1e-4, 2),
						dailyCapM3: g.bool(0.5) ? null : g.logFloat(1, 1e5),
						minStoragePct: g.frac(),
						enabled: g.bool(0.9),
						priority: g.int(0, 3)
					}
				});
				transfers.push(id);
				break;
			}
			case 'transfer.set': {
				const id = transfers.length && !g.bool(0.05) ? g.pick(transfers) : missing();
				const field = g.pick(['months', 'maxRateM3s', 'dailyCapM3', 'minStoragePct', 'enabled', 'priority', 'toNodeId'] as const);
				const value =
					field === 'months'
						? [...new Set(Array.from({ length: g.int(0, 12) }, () => g.int(1, 12)))]
						: field === 'maxRateM3s'
							? g.logFloat(1e-4, 2)
							: field === 'dailyCapM3'
								? g.pick([null, g.logFloat(1, 1e5)])
								: field === 'minStoragePct'
									? g.frac()
									: field === 'enabled'
										? g.bool()
										: field === 'priority'
											? g.int(0, 5)
											: (node()?.id ?? missing());
				ops.push({ op: 'transfer.set', transferId: id, field, value } as ScenarioOp);
				break;
			}
			case 'transfer.remove':
				ops.push({ op: 'transfer.remove', transferId: transfers.length && !g.bool(0.05) ? g.pick(transfers) : missing() });
				break;
			case 'landCover.add': {
				const x = node();
				const id = `sl${k}`;
				ops.push({
					op: 'landCover.add',
					patch: {
						id,
						nodeId: x?.id ?? missing(),
						coverClass: g.pick(LAND_COVER_CLASSES.map((c) => c.id)),
						areaKm2: g.float(0, Math.max(0.1, x?.areaKm2 ?? 1)),
						densityPct: g.frac(),
						factors: g.bool(0.7) ? null : { mar: g.frac(), lowFlow: g.frac() }
					}
				});
				patches.push(id);
				break;
			}
			case 'landCover.remove':
				ops.push({ op: 'landCover.remove', patchId: patches.length && !g.bool(0.05) ? g.pick(patches) : missing() });
				break;
			case 'settings.set':
				ops.push(settingsOp(g, input));
				break;
			case 'series.scale': {
				const kindS = g.pick(SCALABLE_SERIES_KINDS);
				const s = input.series[kindS];
				const factor = g.pick([0, 0.9, 1.1, g.float(0, 3)]);
				if (!s || g.bool(0.5)) ops.push({ op: 'series.scale', kind: kindS, factor });
				else {
					const start = toEpochDay(s.startDate);
					const a = start + g.int(-30, s.values.length);
					ops.push({ op: 'series.scale', kind: kindS, factor, from: fromEpochDay(a), to: fromEpochDay(a + g.int(0, 400)) });
				}
				break;
			}
		}
	}
	// Borehole ops (WP-3.9), from their own stream so every seed's other ops are
	// what they were; only when the caller didn't ask for an exact count.
	const h = new Rng(seed ^ 0x2545f491);
	if (count === undefined && h.bool(0.3)) {
		const bores = (input.model.boreholes ?? []).map((b) => b.id);
		for (let k = h.int(1, 3); k > 0; k--) {
			if (bores.length && h.bool(0.3)) {
				ops.push({ op: 'borehole.remove', boreholeId: h.bool(0.9) ? h.pick(bores) : missing() });
				continue;
			}
			const x = nodes.length && !h.bool(0.05) ? h.pick(nodes) : null;
			const id = `sb${k}`;
			ops.push({
				op: 'borehole.add',
				borehole: {
					id,
					nodeId: x?.id ?? missing(),
					name: `Scenario borehole ${k}`,
					capacityM3Day: h.pick([0, h.logFloat(1, 1e4), 1e9]),
					annualCapM3: h.bool(0.5) ? null : h.logFloat(1, 1e6),
					mode: h.pick(['none', 'supplemental', 'primary', 'emergency'] as const),
					emergencyBelowPct: h.frac(),
					target: h.pick(['direct', 'dam'] as const),
					depletionFactor: h.frac()
				}
			});
			bores.push(id);
		}
	}
	return ops;
}
