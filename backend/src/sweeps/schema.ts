// Scenario sweeps (issue #53 R2, docs/scenarios.md § Sweeps, docs/api.md
// § Sweeps): the request body. Each member's ops are checked by the same
// validation as a scenario's (scenarios/schema.ts checkOps: the engine's
// validateScenarioOps plus UUID ids); whether they *apply* to the base run
// is the job's to find out, per member (a member whose ops don't apply
// records its problems and the sweep carries on).
import { z } from 'zod';
import { Ops } from '../scenarios/schema.js';

/**
 * Most members a sweep may have (062_scenario_sweeps CHECK on position).
 * R4's demand levels and R5's outlook use 3–5; 12 leaves room for a monthly
 * plan while keeping a sweep of the largest catchment well inside one job's
 * lease (runner.ts DEFAULT_LEASE_SECONDS) with every member in one transaction.
 */
export const SWEEP_MEMBERS_MAX = 12;
/** Most queued or running sweep jobs one user may have across all projects. */
export const SWEEP_JOBS_PER_USER = 2;
/** Sweeps kept per project, newest first; creating one deletes older ones. */
export const SWEEPS_KEPT = 20;
/**
 * The catchment-level daily series (nodeId null) a member keeps beside its
 * summary: what R4's outcome matrix (views/outcomeMatrix.ts, ewr_shortfall;
 * views/yearClasses.ts, natural_flow) reads (R5's outlook has its own
 * job and tables, outlooks/). Not every node's series: a sweep is not a run.
 */
export const SWEEP_SERIES_KEYS = ['natural_flow', 'simulated_outflow', 'ewr', 'ewr_shortfall'] as const;

const noNul = (s: string) => !s.includes('\u0000');

export const SweepMember = z
	.object({
		name: z.string().trim().min(1, 'a member needs a name').max(100).refine(noNul, 'cannot contain NUL characters'),
		ops: Ops
	})
	.strict();

export const CreateSweepBody = z
	.object({
		name: z.string().trim().min(1, 'a sweep needs a name').max(200).refine(noNul, 'cannot contain NUL characters'),
		baseRunId: z.string().uuid(),
		members: z.array(SweepMember).min(1, 'a sweep needs at least one member').max(SWEEP_MEMBERS_MAX, `a sweep has at most ${SWEEP_MEMBERS_MAX} members`)
	})
	.strict()
	.superRefine((b, ctx) => {
		const seen = new Set<string>();
		b.members.forEach((m, i) => {
			const key = m.name.toLowerCase();
			if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['members', i, 'name'], message: `two members are called "${m.name}"` });
			seen.add(key);
		});
	});
export type CreateSweepBody = z.infer<typeof CreateSweepBody>;

/** The `sweep` job's payload: which sweep to compute (its members are in the table). */
export const SweepPayload = z.object({ sweepId: z.string().uuid() }).strict();
