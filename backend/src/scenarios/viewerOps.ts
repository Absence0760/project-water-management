// A scenario as a viewer the project keeps from each farm's registered volume
// reads it (D3, issue #523 G1; docs/security.md § Allocations): without the
// ops that set a volume on a unit that isn't an application's own, and its
// check renumbered to the ops left.
import { withheldAllocationOps, withoutPositions } from '../allocations/viewerUnits.js';
import type { ScenarioRow } from './execute.js';

/** "op 3" / "ops 3–5" / "ops 2, 4" as a problem line starts (engine opNumbers): 1-based. */
const OP_LABEL = /^(ops?) ([0-9–, ]+) \(/;
const labelOf = (n: number[]) => {
	const run = n.every((x, k) => k === 0 || x === n[k - 1]! + 1);
	return n.length === 1 ? `op ${n[0]}` : `ops ${run ? `${n[0]}–${n[n.length - 1]}` : n.join(', ')}`;
};

/**
 * A scenario's check as a viewer kept from each farm's volume reads it
 * (#523 G1): the ops at `drop` left out (viewerScenario), the rest
 * renumbered, a problem line about only those ops left out and the others'
 * op numbers moved down.
 */
export function checkWithout<C extends { applied: { index: number }[]; problems: string[]; classified: unknown[]; maskedRules?: { problem: number; ops: number[] }[] }>(c: C, drop: ReadonlySet<number>): C {
	if (!drop.size) return c;
	const to = (i: number) => (drop.has(i) ? null : i - [...drop].filter((d) => d < i).length);
	const problemTo = new Map<number, number>();
	const problems: string[] = [];
	c.problems.forEach((line, i) => {
		const m = OP_LABEL.exec(line);
		if (!m) {
			problemTo.set(i, problems.length);
			problems.push(line);
			return;
		}
		const nums = m[2]!.split(', ').flatMap((part) => {
			const r = /^(\d+)–(\d+)$/.exec(part);
			return r ? Array.from({ length: Number(r[2]) - Number(r[1]) + 1 }, (_, k) => Number(r[1]) + k) : [Number(part)];
		});
		const kept = nums.map((n) => to(n - 1)).filter((x): x is number => x !== null);
		if (!kept.length) return;
		problemTo.set(i, problems.length);
		problems.push(`${labelOf(kept.map((x) => x + 1))}${line.slice(m[0].length - 2)}`);
	});
	return {
		...c,
		applied: c.applied.filter((a) => !drop.has(a.index)).map((a) => ({ ...a, index: to(a.index)! })),
		problems,
		classified: withoutPositions(c.classified, drop),
		...(c.maskedRules
			? {
					maskedRules: c.maskedRules
						.filter((r) => problemTo.has(r.problem))
						.map((r) => ({ ...r, problem: problemTo.get(r.problem)!, ops: r.ops.filter((o) => !drop.has(o)).map((o) => to(o)!) }))
				}
			: {})
	};
}

/**
 * A scenario as a viewer kept from each farm's volume reads it (D3, #523
 * G1): without the ops that set a volume on a unit that isn't an
 * application's own (withheldAllocationOps; every one for a team scenario),
 * and `withheldOps`, how many were left out. `drop`: their positions.
 */
export function viewerScenario<S extends ScenarioRow>(s: S): { scenario: S & { withheldOps?: number }; drop: Set<number> } {
	const drop = withheldAllocationOps(s.ops, s.origin === 'applicant' ? s.ownedNodeIds : []);
	if (!drop.size) return { scenario: s, drop };
	return { scenario: { ...s, ops: withoutPositions(s.ops, drop), withheldOps: drop.size }, drop };
}
