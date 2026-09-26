// "Check reproduction" (roadmap WP-3.1, GET …/runs/:runId/reproduce): what the
// answer says, in words. Pure, so it is unit-tested without the component.
import type { Reproduction, ReproductionDifference } from '$lib/api';
import { fmtReading } from '$lib/format/number';

/** A difference too small for fmtReading's four decimals still shows as a number. */
const size = (v: number) => (v !== 0 && Math.abs(v) < 1e-4 ? v.toExponential(2) : fmtReading(v));

/** One difference as a line: which value, and how it differs. `nodeName` names a node by id. */
export function differenceText(d: ReproductionDifference, nodeName: (id: string) => string | undefined): string {
	if (d.kind === 'summary') return `Summary value ${d.path}`;
	const where = d.nodeId ? `${nodeName(d.nodeId) ?? 'a node'}: ` : 'Catchment: ';
	if (d.kind !== 'series')
		return d.kind === 'series_missing' ? `${where}${d.label} is stored with the run but not produced now` : `${where}${d.label} is produced now but wasn't stored with the run`;
	const days = `${d.days} day${d.days === 1 ? '' : 's'}`;
	return `${where}${d.label} differs on ${days} from ${d.firstDate}${d.maxAbsDiff === null ? '' : `, by up to ${size(d.maxAbsDiff)}`}`;
}

/** The headline of an answer, and whether it is good news, bad news or neither. */
export function reproductionHeadline(r: Reproduction): { text: string; tone: 'ok' | 'warn' | 'error' } {
	const engines = r.engineVersionThen === r.engineVersionNow ? `engine ${r.engineVersionNow}` : `engine ${r.engineVersionThen} then, ${r.engineVersionNow} now`;
	switch (r.status) {
		case 'identical':
			return { text: `Identical: re-run from its stored inputs, every result and daily output matches (${engines}).`, tone: 'ok' };
		case 'differs': {
			const n = r.differences.length + r.truncated;
			const why =
				r.engineVersionThen === r.engineVersionNow
					? 'The engine is the same version, so this is unexpected: report it.'
					: 'The engine has changed since this run; the list shows what the change moves.';
			return { text: `Differs in ${n} place${n === 1 ? '' : 's'} (${engines}). ${why}`, tone: r.engineVersionThen === r.engineVersionNow ? 'error' : 'warn' };
		}
		case 'not_reproducible':
			return { text: `Not reproducible: ${r.message ?? 'this run was made before runs stored their inputs.'}`, tone: 'warn' };
		case 'inconsistent':
			return { text: `A stored input doesn't match what the run recorded, so it can't be re-run: ${r.message ?? ''}`.trim(), tone: 'error' };
		case 'failed':
			return { text: r.message ?? 'The current engine refuses this run’s stored input.', tone: 'warn' };
	}
}
