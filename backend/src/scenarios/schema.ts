// Request bodies for the scenario routes (docs/api.md § Scenarios). The ops
// themselves are checked by the engine's validateScenarioOps, the one
// definition of what an op may hold (packages/engine/src/scenario/ops.ts);
// this wraps it in zod and tightens every id to a UUID, because the rows a
// scenario run writes (run_series.node_id) are uuid columns.
import { createHash } from 'node:crypto';
import { canonicalJson, validateScenarioOps, type ScenarioOp } from '@water-management/engine';
import { z } from 'zod';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where each op keeps an id, as paths into the op (`node.set`'s `value` is an id only for a transfer end). */
function opIds(op: ScenarioOp): [string, unknown][] {
	switch (op.op) {
		case 'node.set':
		case 'node.remove':
			return [['nodeId', op.nodeId]];
		case 'node.add':
			return [
				['node.id', op.node.id],
				['node.downstreamNodeId', op.node.downstreamNodeId]
			];
		case 'cropArea.set':
			return [
				['nodeId', op.nodeId],
				['cropId', op.cropId]
			];
		case 'crop.add':
			return [['crop.id', op.crop.id]];
		case 'transfer.add':
			return [
				['transfer.id', op.transfer.id],
				['transfer.fromNodeId', op.transfer.fromNodeId],
				['transfer.toNodeId', op.transfer.toNodeId]
			];
		case 'transfer.set':
			return [['transferId', op.transferId], ...(op.field === 'fromNodeId' || op.field === 'toNodeId' ? ([['value', op.value]] as [string, unknown][]) : [])];
		case 'transfer.remove':
			return [['transferId', op.transferId]];
		case 'landCover.add':
			return [
				['patch.id', op.patch.id],
				['patch.nodeId', op.patch.nodeId]
			];
		case 'landCover.remove':
			return [['patchId', op.patchId]];
		case 'settings.set':
		case 'series.scale':
			return [];
	}
}

/**
 * validateScenarioOps plus UUID ids. `errors` name each problem by path
 * (`ops[3].nodeId: must be a UUID`); the ops are rebuilt from their known
 * fields only, so unknown keys never reach the database.
 */
export function checkOps(raw: unknown): { ops: ScenarioOp[]; errors: string[] } {
	const { ops, errors } = validateScenarioOps(raw);
	if (errors.length) return { ops, errors };
	ops.forEach((op, i) => {
		for (const [path, v] of opIds(op)) if (typeof v !== 'string' || !UUID_RE.test(v)) errors.push(`ops[${i}].${path}: must be a UUID`);
	});
	return { ops, errors };
}

/** zod wrapper: the checked ops, or one issue per error. */
export const Ops = z.unknown().transform((raw, ctx) => {
	const { ops, errors } = checkOps(raw);
	for (const message of errors) ctx.addIssue({ code: 'custom', message });
	return errors.length ? z.NEVER : ops;
});

/** SHA-256 hex of the ops as RFC 8785 canonical JSON (engine canonicalJson): `scenario.ops_sha256` and the run snapshot's `opsSha256`. */
export const opsSha256 = (ops: readonly ScenarioOp[]): string => createHash('sha256').update(canonicalJson(ops)).digest('hex');

const name = z
	.string()
	.trim()
	.min(1, 'a scenario needs a name')
	.max(200)
	.refine((s) => !s.includes('\u0000'), 'cannot contain NUL characters');
const description = z
	.string()
	.max(4000)
	.refine((s) => !s.includes('\u0000'), 'cannot contain NUL characters');
const ownedNodeIds = z
	.array(z.string().uuid())
	.max(500)
	.transform((xs) => [...new Set(xs)]);

export const SCENARIO_STATUSES = ['draft', 'submitted', 'withdrawn', 'decided'] as const;
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];

/** Status changes the API (and the scenario_guard trigger) allow. WP-3.3 narrows who may make them. */
export const STATUS_MOVES: Record<ScenarioStatus, readonly ScenarioStatus[]> = {
	draft: ['submitted'],
	submitted: ['withdrawn', 'decided'],
	withdrawn: ['draft'],
	decided: []
};

export const CreateScenarioBody = z
	.object({ name, description: description.default(''), baseRunId: z.string().uuid(), ops: Ops.default([]), ownedNodeIds: ownedNodeIds.default([]) })
	.strict();

/** PATCH: `ops` replaces the whole list. Ops, owned nodes and the base change only while the scenario is a draft. */
export const PatchScenarioBody = z
	.object({ name: name.optional(), description: description.optional(), ops: Ops.optional(), ownedNodeIds: ownedNodeIds.optional(), status: z.enum(SCENARIO_STATUSES).optional() })
	.strict()
	.refine((b) => Object.values(b).some((v) => v !== undefined), 'send at least one of name, description, ops, ownedNodeIds, status');

export const RebaseBody = z.object({ baseRunId: z.string().uuid(), dryRun: z.boolean().default(false) }).strict();

export const ScenarioRunBody = z.object({ label: z.string().trim().max(200).optional() }).strict();
