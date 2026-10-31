// `pack_reproduce_part`: one part of the server's re-run of an issued evidence
// pack (302_pack_reproduce_parts, evidence/packReproduceParts.ts;
// docs/evidence-pack.md § Reproduction): a run, the headline pair, § 8's
// pairs, the combined row's assessment or its background, or one dam's firm
// yield on one run of it. The `pack_reproduce` job queues one per part, as
// the editor whose re-run it is; each runs as them, under RLS, stores what it
// found and, once every part is back, records the pack's outcome.
//
// The longest part is § 8's pairs or the combined row's assessment (its
// applications + 2 runs, about 17 s on a 30-year, 16-node catchment); a dam
// part is one firm-yield search (about 5.6 s): each well inside the worker's
// 300 s. A failure another attempt can't fix ends it at once. Once dead,
// onDead fails the gathering as the same user, naming the part, even when no
// sibling is left to see it; the tick's sweep does it for a death no hook
// sees (302 app_fail_stopped_pack_reproductions).
import { computeReproducePart, PackReproducePartPayload } from '../../evidence/packReproduceParts.js';
import { ApiError } from '../../http/errors.js';
import { JobError, LeaseLostError } from '../errors.js';
import { defineHandler } from '../registry.js';

export const packReproducePartHandler = defineHandler({
	role: 'editor',
	payload: PackReproducePartPayload,
	async run({ db, job, payload }) {
		try {
			await computeReproducePart(db, job, payload);
		} catch (err) {
			if (err instanceof ApiError || err instanceof JobError || err instanceof LeaseLostError || (err as { code?: string }).code) throw err;
			throw new JobError(`the re-run failed: ${(err as Error).message}`, { retry: false });
		}
	},
	// Dead, its part still pending: the gathering fails now, the line naming the part, not left to a sibling.
	async onDead({ db, job, payload }) {
		const { rows } = await db.query('SELECT 1 FROM pack_reproduce_gathering WHERE id = $1 AND project_id = $2', [payload.gatheringId, job.projectId]);
		if (rows.length) await db.query('SELECT app_fail_pack_reproduce($1)', [payload.gatheringId]);
	}
});
