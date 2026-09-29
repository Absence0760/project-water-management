// Seasonal outlooks (issue #53 R5, docs/api.md § Seasonal outlooks,
// docs/model.md §2.15): the request body and the limits. A level's ops are
// checked by the same validation as a scenario's (scenarios/schema.ts
// checkOps: the engine's validateScenarioOps plus UUID ids), and must all be
// `demand.scale` (the engine's outlookLevelProblems: any other op would
// change the history the season starts from). Whether they *apply* to the
// base run (the node ids exist) is the job's to find out, per level.
import { resolveSeason } from '@water-management/engine';
import { z } from 'zod';
import { Ops } from '../scenarios/schema.js';

/**
 * Most demand levels an outlook may have (063_seasonal_outlook CHECK): the
 * design's three (100 / 85 / 70 %) and a monthly plan or two beside them.
 */
export const OUTLOOK_LEVELS_MAX = 6;
/**
 * Most analogue years an outlook runs: the record's newest, the older ones
 * listed as left out (`overLimit`). With OUTLOOK_LEVELS_MAX that is at most
 * 240 members, each a full run of the model (the history, then the season),
 * all in the job's one transaction, which has to fit the worker Lambda's
 * 300 s (docs/architecture.md § Background work).
 */
export const OUTLOOK_YEARS_MAX = 40;
/** Most queued or running outlook jobs one user may have across all projects. */
export const OUTLOOK_JOBS_PER_USER = 2;
/** Outlooks kept per project, newest first; creating one deletes older ones. */
export const OUTLOOKS_KEPT = 20;

const noNul = (s: string) => !s.includes('\u0000');
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date, YYYY-MM-DD');

export const OutlookLevelBody = z
	.object({
		label: z.string().trim().min(1, 'a demand level needs a label').max(100).refine(noNul, 'cannot contain NUL characters'),
		ops: Ops
	})
	.strict()
	.superRefine((l, ctx) => {
		l.ops.forEach((op, i) => {
			if (op.op !== 'demand.scale') {
				ctx.addIssue({
					code: 'custom',
					path: ['ops', i],
					message: `op ${i + 1} (${op.op}): only demand.scale ops make a demand level; any other op would change the history the season starts from`
				});
			}
		});
	});

export const CreateOutlookBody = z
	.object({
		name: z.string().trim().min(1, 'an outlook needs a name').max(200).refine(noNul, 'cannot contain NUL characters'),
		baseRunId: z.string().uuid(),
		levels: z
			.array(OutlookLevelBody)
			.min(1, 'an outlook needs at least one demand level')
			.max(OUTLOOK_LEVELS_MAX, `an outlook has at most ${OUTLOOK_LEVELS_MAX} demand levels`),
		/** The season; both or neither. Neither: the project's setting (settings.outlook.season) from the base run's newest state. */
		decisionDate: IsoDate.optional(),
		seasonEnd: IsoDate.optional(),
		/** (0, 1]; absent: the project's setting, else the engine's default (O6). */
		planningShare: z.number().finite().gt(0, 'the planning share must be more than 0').max(1, 'the planning share is at most 1 (every year)').optional(),
		/**
		 * The season's review date, for the review triggers (R6): after the
		 * decision date, on or before the season end. Absent: the project's
		 * setting (settings.outlook.review), else the engine's defaultReviewDate;
		 * null: no trigger table.
		 */
		reviewDate: IsoDate.nullable().optional(),
		/** Analogue water years; absent: every one the record holds but the season's own. */
		analogueYears: z.array(z.number().int().min(1800).max(2200)).min(1).max(200).optional()
	})
	.strict()
	.superRefine((b, ctx) => {
		const seen = new Set<string>();
		b.levels.forEach((l, i) => {
			const key = l.label.toLowerCase();
			if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['levels', i, 'label'], message: `two demand levels are called "${l.label}"` });
			seen.add(key);
		});
		if ((b.decisionDate === undefined) !== (b.seasonEnd === undefined)) {
			ctx.addIssue({ code: 'custom', path: [b.decisionDate === undefined ? 'decisionDate' : 'seasonEnd'], message: 'give both the decision date and the season end, or neither' });
		} else if (b.decisionDate !== undefined && b.seasonEnd !== undefined && IsoDate.safeParse(b.decisionDate).success && IsoDate.safeParse(b.seasonEnd).success) {
			try {
				resolveSeason({ decisionDate: b.decisionDate, seasonEnd: b.seasonEnd });
			} catch (err) {
				// The engine's own words: a date that isn't one, an end before the start, a season over a year.
				ctx.addIssue({ code: 'custom', path: ['seasonEnd'], message: (err as Error).message });
			}
		}
		if (typeof b.reviewDate === 'string' && b.decisionDate !== undefined && b.seasonEnd !== undefined && (b.reviewDate <= b.decisionDate || b.reviewDate > b.seasonEnd)) {
			ctx.addIssue({ code: 'custom', path: ['reviewDate'], message: 'the review date must fall after the decision date and on or before the season end' });
		}
		if (b.analogueYears && new Set(b.analogueYears).size !== b.analogueYears.length) {
			ctx.addIssue({ code: 'custom', path: ['analogueYears'], message: 'names a water year more than once' });
		}
	});
export type CreateOutlookBody = z.infer<typeof CreateOutlookBody>;

/**
 * Most storage bands a trigger table has: the default terciles make three
 * (the engine's tercileEdges). With OUTLOOK_LEVELS_MAX and OUTLOOK_YEARS_MAX
 * the table adds at most 720 member runs of the rest of the season to the
 * outlook's 240, still inside the worker's 300 s on the test catchments
 * (docs/model.md §2.15a: 3 × 12 × 4 in 53 ms).
 */
export const TRIGGER_BANDS_MAX = 3;

/** The `outlook` job's payload: which outlook to compute (its levels and season are in the row). */
export const OutlookPayload = z.object({ outlookId: z.string().uuid() }).strict();
