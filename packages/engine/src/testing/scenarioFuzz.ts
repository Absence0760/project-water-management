// Seeded random scenario op lists (roadmap WP-3.2) for the property tests in
// ../scenario/*.test.ts. Ops mostly target elements the input has, with
// in-range values, and now and then a missing id, an edit that breaks the
// network (a duplicate name, a loop-free but invalid transfer end) or a
// target an earlier op removed, so applyScenario's problem path runs too.
// A pure function of the seed.
import { fromEpochDay, toEpochDay } from '../calendar';
import { BOREHOLE_RULES, DAM_RELEASE_RULES, DEMAND_OBJECT_CATEGORIES, DEMAND_OBJECT_PRIORITIES, DEMAND_PARTS, LAND_COVER_CLASSES, SUPPLY_RULES, USER_PRIORITIES, type ModelInput, type NetworkNode } from '../project';
import { Rng } from '../random';
import { CROP_SET_FIELDS, DEMAND_OBJECT_SET_FIELDS, LAND_COVER_SET_FIELDS, NODE_SET_FIELDS, SCALABLE_SERIES_KINDS, type NodeSetField, type ScenarioOp, type SettingsPath } from '../scenario/ops';

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
		case 'supplyRule':
			// Any rule: trigger on a dam-less farm, or run of river on one with a dam, is a problem applyScenario reports.
			return g.pick(SUPPLY_RULES);
		case 'pumpCapacityM3Day':
			return g.pick([null, 0, g.logFloat(1, 1e5)]);
		case 'handsOffM3Day':
		case 'divertMonthlyM3Day':
			return g.bool(0.3) ? null : monthly(g, () => (g.bool(0.2) ? 0 : g.logFloat(1, 1e5)));
		case 'handsOffEwr':
			return g.bool(0.5);
		case 'damCurve': {
			// None (the power law), a curve topping out near the capacity, or now and then one row (a model-rule problem).
			if (g.bool(0.2)) return null;
			const top = (n.damCapacityM3 > 0 ? n.damCapacityM3 : g.logFloat(10, 3e6)) * g.pick([1, g.float(0.9, 1.5)]);
			const rows = g.bool(0.05) ? 1 : g.int(2, 8);
			const depth = g.logFloat(0.5, 30);
			return Array.from({ length: rows }, (_, k) => {
				const f = rows === 1 ? 1 : k / (rows - 1);
				return { levelM: 100 + depth * f, areaM2: (top / depth) * f, volumeM3: top * f };
			});
		}
		case 'damSurveyDate':
		case 'damInServiceFrom':
		case 'abstractionFrom':
			return g.bool(0.3) ? null : fromEpochDay(toEpochDay('1985-01-01') + g.int(0, 40 * 365));
		case 'damSedimentPctPerYear':
			return g.pick([null, 0, g.float(0, 0.05)]);
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
		['gr4j.x3', () => g.float(1, 1000)],
		['gr4j.x1', () => g.float(10, 3000)],
		['gr4j.x4', () => g.float(0.5, 10)],
		['chirpsBiasCorrection', () => g.pick(['monthly', 'none'])],
		['zeroRainRuns.mode', () => g.pick(['missing', 'asRecorded'])],
		['calibration.rainThresholdMm', () => g.pick([0, 2, 5])],
		['calibration.catchmentAreaKm2', () => (g.bool(0.5) ? null : g.logFloat(0.1, 1000))],
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
				const field = g.pick(['months', 'maxRateM3s', 'dailyCapM3', 'minStoragePct', 'enabled', 'priority', 'toNodeId', 'monthlyRateM3s', 'source', 'handsOffM3Day', 'handsOffEwr', 'lossPct', 'sizing', 'topUpDam'] as const);
				const value =
					field === 'source'
						? g.pick(['dam', 'river'] as const)
						: field === 'handsOffM3Day'
							? g.pick([null, g.logFloat(1, 1e5)])
							: field === 'lossPct'
								? g.float(0, 0.9)
								: field === 'sizing'
									? g.pick(['demand', 'capacity'] as const)
									: field === 'handsOffEwr' || field === 'topUpDam'
										? g.bool()
										: field === 'monthlyRateM3s'
						? g.bool(0.2)
							? null
							: Array.from({ length: 12 }, () => (g.bool(0.3) ? 0 : g.logFloat(1e-4, 2)))
						: field === 'months'
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
	// Demand-object ops (engine ≥ 1.45.0), from a stream of their own for the same reason: an object
	// added on a unit (now and then on a user or gauge, or a missing node: a problem), fields set
	// one or a few at a time on one object (an edit group), and removals. A sizing switched without
	// its numbers, or a return from an object piped out, breaks a model rule (a problem).
	const o = new Rng(seed ^ 0x7feb352d);
	if (count === undefined && o.bool(0.3)) {
		const objects = (input.model.demandObjects ?? []).map((x) => x.id);
		for (let k = o.int(1, 3); k > 0; k--) {
			const roll = o.float(0, 1);
			if (objects.length && roll < 0.2) {
				ops.push({ op: 'demandObject.remove', demandObjectId: o.bool(0.9) ? o.pick(objects) : missing() });
				continue;
			}
			if (objects.length && roll < 0.6) {
				const demandObjectId = o.bool(0.95) ? o.pick(objects) : missing();
				for (let f = o.int(1, 3); f > 0; f--) {
					const field = o.pick(DEMAND_OBJECT_SET_FIELDS);
					const value =
						field === 'name'
							? `Scenario object ${k}.${f}`
							: field === 'category'
								? o.pick(DEMAND_OBJECT_CATEGORIES)
								: field === 'sizing'
									? o.pick(['monthly', 'perUnit'] as const)
									: field === 'monthlyM3Day' || field === 'monthlyFactor'
										? o.bool(0.2)
											? null
											: monthly(o, () => o.float(0, field === 'monthlyFactor' ? 2 : 500))
										: field === 'count'
											? o.pick([null, o.int(0, 5000)])
											: field === 'litresPerUnitDay'
												? o.pick([null, o.float(0, 400)])
												: field === 'lossPct'
													? o.float(0, 0.5)
													: field === 'returnPct'
														? o.frac()
														: field === 'priority'
															? o.pick(DEMAND_OBJECT_PRIORITIES)
															: field === 'destination'
																? o.pick(['internal', 'external'] as const)
																: field === 'enabled'
																	? o.bool(0.8)
																	: field === 'population'
																		? o.pick([null, o.int(0, 20_000)])
																		: field === 'schedule'
																		? o.bool(0.4)
																			? null
																			: [{ label: 'Scenario window', span: 'always' as const, from: null, to: null, easterFrom: null, easterTo: null, weekdays: [6, 7], factor: o.float(0, 2) }]
																		: o.pick(['Scenario note', ' Scenario note ', '']);
					ops.push({ op: 'demandObject.set', demandObjectId, field, value } as ScenarioOp);
				}
				continue;
			}
			const units = nodes.filter((x) => x.kind === 'farm');
			const x = o.bool(0.9) && units.length ? o.pick(units) : o.bool(0.5) && nodes.length ? o.pick(nodes) : null;
			const id = `so${k}`;
			const perUnit = o.bool(0.4);
			const external = o.bool(0.15);
			ops.push({
				op: 'demandObject.add',
				demandObject: {
					id,
					nodeId: x?.id ?? missing(),
					name: `Scenario object ${k}`,
					category: o.pick(DEMAND_OBJECT_CATEGORIES),
					sizing: perUnit ? 'perUnit' : 'monthly',
					monthlyM3Day: perUnit ? null : monthly(o, () => o.float(0, 500)),
					count: perUnit ? o.int(0, 5000) : null,
					litresPerUnitDay: perUnit ? o.float(0, 400) : null,
					lossPct: perUnit ? o.float(0, 0.3) : 0,
					monthlyFactor: perUnit && o.bool(0.3) ? monthly(o, () => o.float(0.5, 1.5)) : null,
					returnPct: external ? (o.bool(0.1) ? 0.2 : 0) : o.frac(),
					priority: o.pick(DEMAND_OBJECT_PRIORITIES),
					destination: external ? 'external' : 'internal',
					enabled: o.bool(0.9),
					note: ''
				}
			});
			objects.push(id);
		}
	}
	// demand.scale (issue #53 R1), from a stream of its own for the same reason.
	const q = new Rng(seed ^ 0x5bd1e995);
	if (count === undefined && q.bool(0.3)) {
		for (let k = q.int(1, 2); k > 0; k--) {
			const category = q.pick(['farm', 'farm', 'user'] as const);
			const op: ScenarioOp & { op: 'demand.scale' } = { op: 'demand.scale', factor: q.pick([0, 0.7, 0.85, 1, 1.2, q.float(0, 2)]) };
			if (q.bool(0.5)) op.category = category;
			const pool = nodes.filter((x) => x.kind === (op.category ?? 'farm'));
			if (q.bool(0.5)) {
				// Now and then a node of the wrong kind or a missing one (a problem).
				const picked = [...new Set(Array.from({ length: q.int(1, 3) }, () => (pool.length && !q.bool(0.05) ? q.pick(pool).id : q.bool(0.5) && nodes.length ? q.pick(nodes).id : missing())))];
				op.nodeIds = picked;
			}
			if (q.bool(0.4)) op.months = [...new Set(Array.from({ length: q.int(1, 6) }, () => q.int(1, 12)))];
			// One part of a unit's demand (engine ≥ 1.45.0), from its own stream so the draws above are what they were;
			// now and then on a user op (a problem).
			const qp = new Rng(seed ^ 0x2f3a91c7 ^ k);
			if (qp.bool(0.5) && (op.category !== 'user' || qp.bool(0.1))) op.part = qp.pick(DEMAND_PARTS);
			ops.push(op);
		}
	}
	// ewrRule.set (engine ≥ 1.6.0, WP-3.7), from a stream of its own for the same reason: a
	// table at the outlet, a gauge, and now and then a farm or a missing node (a problem),
	// any kind of source, the natural flows from the run or the table, low and high flows.
	const r = new Rng(seed ^ 0x68e31da4);
	if (count === undefined && r.bool(0.25)) {
		for (let k = r.int(1, 2); k > 0; k--) {
			const gauges = nodes.filter((x) => x.kind === 'gauge').map((x) => x.id);
			const siteNodeId = r.bool(0.1) ? (nodes.length && r.bool(0.5) ? r.pick(nodes).id : missing()) : r.bool(0.5) || !gauges.length ? null : r.pick(gauges);
			const points = r.bool(0.7) ? [10, 20, 30, 40, 50, 60, 70, 80, 90, 99] : [...new Set(Array.from({ length: r.int(2, 8) }, () => r.int(1, 100)))].sort((a, b) => a - b);
			const size = r.pick([0.001, 1, 100]);
			const grid = () => Array.from({ length: 12 }, () => points.map(() => r.logFloat(1e-6, 1) * size).sort((a, b) => b - a));
			const component = r.pick(['total', 'lowFlow'] as const);
			const naturalSource = r.pick(['run', 'run', 'table'] as const);
			const ewr = grid();
			ops.push({
				op: 'ewrRule.set',
				table: {
					siteNodeId,
					source: `Scenario table ${k}`,
					sourceKind: r.pick(['gazetted', 'desktop', 'other', null] as const),
					component,
					unit: r.pick(['mcm', 'm3s'] as const),
					points,
					ewr,
					naturalSource,
					natural: naturalSource === 'table' || r.bool(0.2) ? grid() : null,
					scale: r.pick([1, r.logFloat(0.01, 100)]),
					lowFlow: component === 'total' && r.bool(0.4) ? ewr.map((row) => row.map((v) => v * 0.5)) : null,
					highFlows: r.bool(0.4) ? [{ label: 'Scenario freshet', months: [11, 12], peakM3s: r.logFloat(1e-3, 10), durationDays: r.int(1, 5), perYear: r.int(1, 2) }] : []
				}
			});
		}
	}
	// The later ops (engine ≥ 1.35.0): node.move, node.insert, crop.set, crop.remove, landCover.set,
	// ewrRule.remove, allocation.set and allocation.remove, from a stream of their own for the same
	// reason. Moves often make a loop and now and then name a missing node (problems); an insert
	// re-points some of the nodes that drain into its downstream node, now and then one that doesn't.
	const v = new Rng(seed ^ 0x27d4eb2f);
	if (count === undefined && v.bool(0.45)) {
		const crops2 = [...crops];
		const patches2 = [...patches];
		const allocs = (input.model.allocations ?? []).map((a) => a.id);
		const pickNode = () => (nodes.length && !v.bool(0.05) ? v.pick(nodes) : null);
		for (let k = v.int(1, 3); k > 0; k--) {
			const kind = v.pick(['node.move', 'node.move', 'node.insert', 'node.insert', 'crop.set', 'crop.set', 'crop.remove', 'landCover.set', 'landCover.set', 'ewrRule.remove', 'allocation.set', 'allocation.set', 'allocation.remove'] as const);
			switch (kind) {
				case 'node.move': {
					const x = pickNode();
					const to = pickNode();
					ops.push({ op: 'node.move', nodeId: x?.id ?? missing(), downstreamNodeId: to?.id ?? missing() });
					break;
				}
				case 'node.insert': {
					const into = pickNode();
					const kids = nodes.filter((x) => x.downstreamNodeId === into?.id);
					const ups = kids.filter(() => v.bool(0.6));
					if (!ups.length) ups.push(kids.length ? kids[0]! : (pickNode() ?? nodes[0]!));
					if (v.bool(0.05) && nodes.length) ups.push(v.pick(nodes));
					const id = `si${k}`;
					const kindOf = v.pick(['farm', 'farm', 'user', 'gauge'] as const);
					const added: NetworkNode = {
						id,
						name: v.bool(0.05) && nodes.length ? v.pick(nodes).name : `Inserted node ${k}`,
						kind: kindOf,
						downstreamNodeId: into?.id ?? missing(),
						sortOrder: v.int(0, 100),
						areaKm2: kindOf === 'farm' && v.bool(0.3) ? v.logFloat(0.1, 20) : 0,
						areaHiKm2: 0,
						areaLoKm2: 0,
						flowShareManual: null,
						pctUpstreamToDam: kindOf === 'farm' ? v.frac() : 0,
						pctRunoffToDam: kindOf === 'farm' ? v.frac() : 0,
						damCapacityM3: kindOf === 'farm' && v.bool(0.7) ? v.logFloat(100, 1e6) : 0,
						damInitialPct: v.frac(),
						damMinPct: v.frac(0.5, 0),
						divertCapacityM3Day: kindOf === 'farm' ? v.logFloat(1, 1e5) : 0,
						irrigationEfficiency: v.float(0.5, 1),
						lossReturnFraction: v.frac(),
						damAreaFullM2: null,
						damAreaExponent: 0.7,
						damSeepagePerDay: 0,
						...(kindOf === 'user' ? { userDemandM3Day: monthly(v, () => v.float(0, 1e4)), userReturnPct: v.frac(), userPriority: v.pick(USER_PRIORITIES) } : {})
					};
					ops.push({ op: 'node.insert', node: added, upstreamNodeIds: [...new Set(ups.map((x) => x.id))] });
					nodes.push(added);
					break;
				}
				case 'crop.set': {
					const cropId = crops2.length && !v.bool(0.05) ? v.pick(crops2) : missing();
					const field = v.pick(CROP_SET_FIELDS);
					const value = field === 'name' ? (v.bool(0.1) ? 'Crop 0' : `Renamed crop ${k}`) : field === 'cropFactor' ? monthly(v, () => v.float(0, 1.3)) : v.bool(0.3) ? null : v.float(0.5, 1);
					ops.push({ op: 'crop.set', cropId, field, value } as ScenarioOp);
					break;
				}
				case 'crop.remove':
					ops.push({ op: 'crop.remove', cropId: crops2.length && !v.bool(0.05) ? v.pick(crops2) : missing() });
					break;
				case 'landCover.set': {
					const patchId = patches2.length && !v.bool(0.05) ? v.pick(patches2) : missing();
					const field = v.pick(LAND_COVER_SET_FIELDS);
					const value =
						field === 'coverClass'
							? v.pick(LAND_COVER_CLASSES.map((c) => c.id))
							: field === 'areaKm2'
								? v.float(0, 5)
								: field === 'densityPct'
									? v.frac()
									: v.bool(0.4)
										? null
										: { mar: v.frac(), lowFlow: v.frac() };
					ops.push({ op: 'landCover.set', patchId, field, value } as ScenarioOp);
					break;
				}
				case 'ewrRule.remove': {
					const sited = (Array.isArray(input.settings.ewrRules) ? input.settings.ewrRules : []).map((t) => t?.siteNodeId ?? null);
					ops.push({ op: 'ewrRule.remove', siteNodeId: sited.length && !v.bool(0.1) ? v.pick(sited) : v.bool(0.5) ? null : missing() });
					break;
				}
				case 'allocation.set': {
					const x = pickNode();
					const replace = allocs.length && v.bool(0.5);
					const id = replace ? v.pick(allocs) : `sa${k}`;
					const from = v.bool(0.6) ? null : fromEpochDay(v.int(16000, 20000));
					const to = v.bool(0.6) ? null : fromEpochDay(v.int(16000, 20000));
					ops.push({
						op: 'allocation.set',
						allocation: {
							id,
							nodeId: x?.id ?? missing(),
							waterSource: v.pick(['surface', 'groundwater'] as const),
							volumeM3PerYear: v.pick([0, v.logFloat(1, 1e7)]),
							...(v.bool(0.3) ? { storageM3: v.bool(0.3) ? null : v.logFloat(1, 1e6) } : {}),
							...(from ? { validFrom: from } : {}),
							...(to ? { validTo: to } : {}),
							...(v.bool(0.2) ? { months: [...new Set(Array.from({ length: v.int(1, 6) }, () => v.int(1, 12)))] } : {}),
							...(v.bool(0.2) ? { maxRateM3s: v.logFloat(1e-4, 2) } : {})
						}
					});
					if (!replace) allocs.push(id);
					break;
				}
				case 'allocation.remove':
					ops.push({ op: 'allocation.remove', allocationId: allocs.length && !v.bool(0.05) ? v.pick(allocs) : missing() });
					break;
			}
		}
	}
	return ops;
}
