import { BOREHOLE_MODES, DAM_SEDIMENT_MAX_PER_YEAR, BOREHOLE_RULES, BOREHOLE_TARGETS, DAM_CURVE_MAX_ROWS, DEMAND_OBJECT_CATEGORIES, DEMAND_OBJECT_DESTINATIONS, DEMAND_OBJECT_PRIORITIES, DEMAND_OBJECT_SIZINGS, DEMAND_SCHEDULE_MAX_FACTOR, DEMAND_SCHEDULE_MAX_WINDOWS, DEMAND_SCHEDULE_SPANS, DAM_RELEASE_RULES, GA538_GROUNDWATER_RATES, isGa538Rate, LAND_COVER_CLASSES, modelRuleProblems, SUPPLY_RULES, TRANSFER_SIZINGS, TRANSFER_SOURCES, upgradeLegacyModel, USER_PRIORITIES, type LandCoverClass, type ProjectModel } from '@water-management/engine';
import { z } from 'zod';

const uuid = z.string().uuid();
const frac = z.number().min(0).max(1);
const nonNeg = z.number().finite().min(0);
/** A day as YYYY-MM-DD; whether it is a real date is a model rule (developmentProblem). */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date (YYYY-MM-DD)');

/**
 * A project model as PUT /model and a project document carry it. A model from
 * an older engine (a document exported before 0.16.0, a stale browser tab) is
 * read as migration 006 stored the database: `returnFlowPct` becomes irrigation
 * efficiency and loss return, missing dam fields get their defaults and a
 * transfer without a priority gets its list position (upgradeLegacyModel).
 */
export const ModelBody = z.preprocess((v) => (v && typeof v === 'object' ? upgradeLegacyModel(v as { nodes?: unknown }) : v), z.object({
	nodes: z
		.array(
			z.object({
				id: uuid,
				name: z.string().trim().min(1).max(100),
				kind: z.enum(['farm', 'gauge', 'user']),
				downstreamNodeId: uuid.nullable(),
				sortOrder: z.number().int(),
				areaKm2: nonNeg,
				areaHiKm2: nonNeg,
				areaLoKm2: nonNeg,
				flowShareManual: frac.nullable(),
				pctUpstreamToDam: frac,
				pctRunoffToDam: frac,
				damCapacityM3: nonNeg,
				damInitialPct: frac,
				damMinPct: frac,
				divertCapacityM3Day: nonNeg,
				// 0 < e ≤ 1: abstraction demand is the crop requirement ÷ e (audit N1).
				irrigationEfficiency: z.number().gt(0).max(1),
				lossReturnFraction: frac,
				// Dam evaporation and seepage (audit N2): area null = estimated by the run.
				damAreaFullM2: nonNeg.nullable(),
				damAreaExponent: z.number().gt(0).max(3),
				damSeepagePerDay: frac,
				// Other water users (WP-1.33): monthly demand (water-year months), return share, priority.
				userDemandM3Day: z.array(nonNeg).length(12).nullable().default(null),
				userReturnPct: frac.default(0),
				userPriority: z.enum(USER_PRIORITIES).default('senior'),
				// Boreholes (WP-1.34): capacity null = none; depletion share and lag of the river's loss.
				boreholeCapacityM3Day: nonNeg.nullable().default(null),
				boreholeRule: z.enum(BOREHOLE_RULES).default('supplemental'),
				boreholeTriggerPct: frac.default(0.3),
				streamDepletionFrac: frac.default(0),
				streamDepletionLagDays: nonNeg.max(36_500).default(0),
				// Dam storage (WP-3.5): survey rows (shape and monotonicity are a model rule,
				// modelRuleProblems), a release rule by water-year month, the outlet, the
				// share of seepage returning below the dam.
				damCurve: z
					.array(z.object({ levelM: z.number().finite(), areaM2: nonNeg, volumeM3: nonNeg }).strict())
					.max(DAM_CURVE_MAX_ROWS)
					.nullable()
					.default(null),
				damReleaseRule: z.enum(DAM_RELEASE_RULES).default('none'),
				damReleaseM3Day: z.array(nonNeg).length(12).nullable().default(null),
				damOutletCapacityM3Day: nonNeg.nullable().default(null),
				damSeepageReturnPct: frac.default(1),
				// Development over the run (engine ≥ 1.30.0, issue #67): the survey date and sediment rate, the
				// in-service date (farms), the abstraction start (farms and users). Which kinds and a rate
				// needing its survey date are model rules (developmentProblem, via modelRuleProblems).
				damSurveyDate: isoDay.nullable().default(null),
				damSedimentPctPerYear: z.number().min(0).max(DAM_SEDIMENT_MAX_PER_YEAR).nullable().default(null),
				damInServiceFrom: isoDay.nullable().default(null),
				abstractionFrom: isoDay.nullable().default(null),
				// Supply rule and river pump (WP-3.8), farms only (a model rule); pump null = no limit.
				supplyRule: z.enum(SUPPLY_RULES).default('damFirst'),
				pumpCapacityM3Day: nonNeg.nullable().default(null),
				supplyTriggerPct: frac.default(0.4),
				supplyStopPct: frac.default(0.6),
				// Hands-off flow and River to dam by month (engine ≥ 1.32.0, issue #204), m³/day by water-year
				// month; null = none / the one divertCapacityM3Day. Farms only is a model rule (operatingKind).
				handsOffM3Day: z.array(nonNeg).length(12).nullable().default(null),
				handsOffEwr: z.boolean().default(false),
				divertMonthlyM3Day: z.array(nonNeg).length(12).nullable().default(null),
				// Gauges: whether the EWR is assessed there (engine ≥ 1.5.0); the outlet always, a model rule.
				ewrSite: z.boolean().default(true),
				// GN 538 context (engine ≥ 1.12.0): the property's size and its quaternary's Table 2 rate; null = unknown.
				gaPropertyAreaHa: nonNeg.max(10_000_000).nullable().default(null),
				gaRateM3HaYear: z
					.number()
					.refine(isGa538Rate, { message: `must be one of the GN 538 Table 2 rates: ${GA538_GROUNDWATER_RATES.join(', ')}` })
					.nullable()
					.default(null)
			})
		)
		.max(500),
	crops: z
		.array(
			z.object({
				id: uuid,
				name: z.string().trim().min(1).max(100),
				sortOrder: z.number().int().optional(),
				cropFactor: z.array(z.number().finite().min(0)).length(12),
				// The crop's own irrigation efficiency (engine ≥ 0.43.0, issue #54): 0 < e ≤ 1,
				// as the farm's; null / absent = the farm's.
				irrigationEfficiency: z.number().gt(0).max(1).nullable().optional()
			})
		)
		.max(200),
	cropAreas: z.array(z.object({ nodeId: uuid, cropId: uuid, areaM2: nonNeg })).max(20_000),
	transfers: z
		.array(
			z.object({
				id: uuid,
				fromNodeId: uuid,
				toNodeId: uuid,
				months: z.array(z.number().int().min(1).max(12)).max(12),
				maxRateM3s: nonNeg,
				dailyCapM3: nonNeg.nullable(),
				minStoragePct: frac,
				enabled: z.boolean(),
				// Lower moves first; equal priorities share a source dam pro rata (audit Q18).
				priority: z.number().int().min(-1_000_000).max(1_000_000),
				// The max rate per water-year month, m³/s, Oct–Sep (engine ≥ 1.14.0); 0 = off that month.
				// null / absent = maxRateM3s in the listed months. months and maxRateM3s must agree with it (modelRuleIssues).
				monthlyRateM3s: z.array(nonNeg).length(12).nullable().default(null),
				// A river off-take (engine ≥ 1.14.0, migration 091, docs/model.md §2.6a); the defaults are a dam transfer.
				source: z.enum(TRANSFER_SOURCES).default('dam'),
				handsOffM3Day: nonNeg.nullable().default(null),
				handsOffEwr: z.boolean().default(false),
				lossPct: z.number().finite().min(0).lt(1).default(0),
				sizing: z.enum(TRANSFER_SIZINGS).default('demand'),
				topUpDam: z.boolean().default(false)
			})
		)
		.max(500),
	// Land-cover patches (WP-1.35): part of the model document, like crop areas.
	landCover: z
		.array(
			z.object({
				id: uuid,
				nodeId: uuid,
				coverClass: z.enum(LAND_COVER_CLASSES.map((c) => c.id) as [LandCoverClass, ...LandCoverClass[]]),
				areaKm2: nonNeg,
				densityPct: frac,
				factors: z.object({ mar: frac, lowFlow: frac }).nullable()
			})
		)
		.max(5_000)
		.default([]),
	// Individual boreholes (WP-3.9): part of the model document, like land cover. Absent = none.
	boreholes: z
		.array(
			z.object({
				id: uuid,
				nodeId: uuid,
				name: z.string().trim().min(1).max(200),
				capacityM3Day: nonNeg,
				annualCapM3: nonNeg.nullable().default(null),
				mode: z.enum(BOREHOLE_MODES).default('supplemental'),
				emergencyBelowPct: frac.default(0.3),
				target: z.enum(BOREHOLE_TARGETS).default('direct'),
				depletionFactor: frac.default(0)
			})
		)
		.max(5_000)
		.optional(),
	// Demand objects (engine 1.7.0, issue #54 item 2b): part of the model document, like boreholes. Absent = none.
	demandObjects: z
		.array(
			z.object({
				id: uuid,
				nodeId: uuid,
				name: z.string().trim().min(1).max(200),
				category: z.enum(DEMAND_OBJECT_CATEGORIES).default('other'),
				sizing: z.enum(DEMAND_OBJECT_SIZINGS).default('monthly'),
				monthlyM3Day: z.array(nonNeg).length(12).nullable().default(null),
				count: nonNeg.nullable().default(null),
				litresPerUnitDay: nonNeg.nullable().default(null),
				lossPct: z.number().min(0).lt(1).default(0),
				monthlyFactor: z.array(nonNeg).length(12).nullable().default(null),
				returnPct: frac.default(0),
				priority: z.enum(DEMAND_OBJECT_PRIORITIES).default('shared'),
				destination: z.enum(DEMAND_OBJECT_DESTINATIONS).default('internal'),
				enabled: z.boolean().default(true),
				// Date windows with a factor (engine 1.17.0, issue #90 Q4): the shape here, the meaning
				// (real dates, spans in order) in the engine's modelRuleProblems. Absent = none.
				schedule: z
					.array(
						z.object({
							label: z.string().trim().max(200).default(''),
							span: z.enum(DEMAND_SCHEDULE_SPANS),
							from: z.string().max(10).nullable().default(null),
							to: z.string().max(10).nullable().default(null),
							easterFrom: z.number().int().nullable().default(null),
							easterTo: z.number().int().nullable().default(null),
							weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7).nullable().default(null),
							factor: z.number().min(0).max(DEMAND_SCHEDULE_MAX_FACTOR)
						})
					)
					.max(DEMAND_SCHEDULE_MAX_WINDOWS)
					.nullable()
					.default(null),
				note: z.string().max(1000).default('')
			})
		)
		.max(5_000)
		.optional()
}));

/**
 * Structural rules zod can't express. Returns human-readable problems; empty
 * means valid. The rules live in the engine (`modelRuleProblems`,
 * packages/engine/src/modelRules.ts), their one home: applyScenario refuses an
 * op that would break one, so a scenario's model is always one a save here
 * would accept. Shared expectations with the frontend's client-side check.
 */
export const modelProblems = (m: ProjectModel): string[] => modelRuleProblems(m);
