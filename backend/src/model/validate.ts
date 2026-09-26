import { BOREHOLE_MODES, BOREHOLE_RULES, BOREHOLE_TARGETS, DAM_CURVE_MAX_ROWS, DAM_RELEASE_RULES, LAND_COVER_CLASSES, modelRuleProblems, SUPPLY_RULES, upgradeLegacyModel, USER_PRIORITIES, type LandCoverClass, type ProjectModel } from '@water-management/engine';
import { z } from 'zod';

const uuid = z.string().uuid();
const frac = z.number().min(0).max(1);
const nonNeg = z.number().finite().min(0);

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
				// Supply rule and river pump (WP-3.8), farms only (a model rule); pump null = no limit.
				supplyRule: z.enum(SUPPLY_RULES).default('damFirst'),
				pumpCapacityM3Day: nonNeg.nullable().default(null),
				supplyTriggerPct: frac.default(0.4),
				supplyStopPct: frac.default(0.6)
			})
		)
		.max(500),
	crops: z
		.array(
			z.object({
				id: uuid,
				name: z.string().trim().min(1).max(100),
				sortOrder: z.number().int().optional(),
				cropFactor: z.array(z.number().finite().min(0)).length(12)
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
				priority: z.number().int().min(-1_000_000).max(1_000_000)
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
