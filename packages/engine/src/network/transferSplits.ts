// A transfer split between destinations (engine ≥ 1.114.0, docs/model.md §2.6
// *Split between destinations*). A rule may send what it moves to one to five
// destinations, each a share of it (40 % to one unit, 60 % to another). The
// run reads such a rule as one rule per destination, a *piece*, each with its
// destination and that share of the rule's capacity (its rates and daily cap)
// and, for a curve, of the share of the river the curve diverts. Pieces of
// one rule keep everything else: source, months, priority, keeps, reserve,
// losses and their return, sizing and top-up.
//
// Why pieces give the split exactly. The rules of one priority share a short
// source in proportion to what each asks, band by band at their keeps (§2.6,
// §2.6a "proportional rationing"), and pieces of one rule share every keep.
// So each piece gets the same fraction of what it asks, and what it asks is
// its share of the rule's ask: a river rule sized to capacity asks MIN(cap) ×
// pct, one sized by a curve MIN(cap, s × U₀) × pct, and one sized to its
// destinations' need p × MIN(cap, Σ need ÷ (1 − l)), where Σ need is the sum
// of what each destination needs (./offtake.ts PlanOfftake.split). Together
// the pieces take what the one rule would, and each destination gets its
// share of it, after the losses (each piece loses the same share). A dam rule
// is the exception the room makes: a piece moves at most what fits in its own
// destination (§2.6 dstRoom), so a destination with no room takes less than
// its share and what it can't take stays in the source dam; the others still
// get no more than their share. A rule with one destination runs as before,
// to the bit: it is never split.
//
// Pure. The run (../run.ts), the self-checks (../verify), the per-rule series
// readers (./transferSeries.ts) and the farm projection read a model through
// expandTransferSplits, so each sees the same pieces.
import type { Transfer, TransferDestination } from '../project';

/** At most this many destinations per rule. */
export const MAX_TRANSFER_DESTINATIONS = 5;
/** How far the shares may add up from 100 % (0.01 percentage points). */
export const SPLIT_SUM_TOLERANCE = 1e-4;
/** Between a rule's id and its piece's number in a piece's id (`<rule id>#<k>`), and its series key. */
export const SPLIT_PIECE_SEPARATOR = '#';

/** A piece of a split rule as the run sees it: the rule's id, and the destination's share. */
export type TransferPiece = Transfer & { splitOf: string; splitPct: number };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The rule's destinations and shares: its list when it has one, else all of it to `toNodeId`. */
export function transferDestinations(t: Pick<Transfer, 'toNodeId' | 'destinations'>): TransferDestination[] {
	return Array.isArray(t.destinations) && t.destinations.length ? t.destinations.map((d) => ({ nodeId: d.nodeId, pct: d.pct })) : [{ nodeId: t.toNodeId, pct: 1 }];
}

/** Whether the rule sends its water to more than one destination. */
export const isSplitTransfer = (t: Pick<Transfer, 'destinations'>): boolean => Array.isArray(t.destinations) && t.destinations.length > 1;

/**
 * The fields a rule with these destinations stores: the list (null for one
 * destination, which is `toNodeId` alone, as every rule before) and its first
 * destination as `toNodeId`. What the Transfers tab, the importers and the
 * scenario op write.
 */
export function withDestinations(list: readonly TransferDestination[]): { toNodeId: string | null; destinations: TransferDestination[] | null } {
	if (!list.length) throw new Error('a transfer needs at least one destination');
	return { toNodeId: list[0]!.nodeId, destinations: list.length > 1 ? list.map((d) => ({ nodeId: d.nodeId, pct: d.pct })) : null };
}

/**
 * Why a rule's destinations can't run as written, or null when they can (or
 * it has none): one to five, each share above 0 and at most 100 %, adding up
 * to 100 % (within 0.01 %), no destination twice, none the source, and
 * `toNodeId` the first one. A single row is all of it (100 %). The save
 * refuses each (../modelRules.ts); the run reads a list it can't use as all of
 * it to `toNodeId`, with a warning.
 */
export function destinationsProblem(t: Pick<Transfer, 'fromNodeId' | 'toNodeId' | 'destinations'>): string | null {
	const d = t.destinations;
	if (d === null || d === undefined) return null;
	if (!Array.isArray(d) || !d.length) return 'its destinations must list at least one';
	if (d.length > MAX_TRANSFER_DESTINATIONS) return `it can split between at most ${MAX_TRANSFER_DESTINATIONS} destinations (it has ${d.length})`;
	for (const x of d) {
		if (!x || typeof x !== 'object' || !(x.nodeId === null || typeof x.nodeId === 'string')) return 'each destination must name a unit or outside the catchment';
		if (!(finite(x.pct) && x.pct > 0 && x.pct <= 1)) return 'each destination’s share must be above 0 % and at most 100 %';
	}
	const seen = new Set<string | null>();
	for (const x of d) {
		if (seen.has(x.nodeId)) return 'it names one destination twice';
		seen.add(x.nodeId);
		if (x.nodeId === t.fromNodeId) return 'a destination is its own source';
	}
	const sum = d.reduce((a, x) => a + x.pct, 0);
	if (Math.abs(sum - 1) > SPLIT_SUM_TOLERANCE) return `its destinations’ shares must add up to 100 % (they add up to ${(Math.round(sum * 1e4) / 100).toString()} %)`;
	if (d[0]!.nodeId !== t.toNodeId) return 'its destination must be its first split destination';
	return null;
}

const times = (v: number | null | undefined, p: number) => (finite(v) ? v * p : v);

/** One destination's piece of a split rule: its share of the rule's capacity, and of a curve's share of the river. */
function pieceOf(t: Transfer, d: TransferDestination, k: number): TransferPiece {
	const p = d.pct;
	const curve = t.sizing === 'diversionCurve';
	return {
		...t,
		id: `${t.id}${SPLIT_PIECE_SEPARATOR}${k}`,
		toNodeId: d.nodeId,
		destinations: null,
		maxRateM3s: t.maxRateM3s * p,
		monthlyRateM3s: Array.isArray(t.monthlyRateM3s) ? t.monthlyRateM3s.map((r) => (finite(r) ? r * p : r)) : t.monthlyRateM3s,
		dailyCapM3: times(t.dailyCapM3, p) as number | null,
		...(curve
			? {
					diversionCoefficient: times(t.diversionCoefficient, p) as number | null,
					diversionMaxPct: t.diversionCoefficient == null ? t.diversionMaxPct : (finite(t.diversionMaxPct) ? t.diversionMaxPct : 1) * p,
					monthlyDiversion: Array.isArray(t.monthlyDiversion)
						? t.monthlyDiversion.map((m) => (m ? { coefficient: m.coefficient * p, exponent: m.exponent, maxPct: (finite(m.maxPct) ? m.maxPct : 1) * p } : m))
						: t.monthlyDiversion
				}
			: {}),
		splitOf: t.id,
		splitPct: p
	};
}

/**
 * The rules as the run runs them: each split rule (two or more valid
 * destinations) as its pieces, in its place, every other rule as it is (the
 * same object). A list with no split rule is returned as it is. A split rule
 * whose destinations can't run (destinationsProblem) runs as all of it to
 * `toNodeId`, with a warning when `warnings` is given; shares that add up to a
 * little off 100 % (within the tolerance) are scaled to add up exactly.
 * Idempotent: pieces have no destinations.
 */
export function expandTransferSplits<T extends Transfer>(transfers: readonly T[], warnings?: string[]): T[] {
	if (!transfers.some((t) => isSplitTransfer(t))) return transfers as T[];
	return transfers.flatMap((t): T[] => {
		if (!isSplitTransfer(t)) return [t];
		const problem = destinationsProblem(t);
		if (problem) {
			warnings?.push(`transfer ${t.id}: ${problem}; it runs as all of it to its first destination`);
			return [{ ...t, destinations: null }];
		}
		// Shares a hair off 100 % (within the tolerance) are scaled to add up exactly, so the pieces take what the rule would.
		const sum = t.destinations!.reduce((a, d) => a + d.pct, 0);
		return t.destinations!.map((d, k) => pieceOf(t, { nodeId: d.nodeId, pct: d.pct / sum }, k) as unknown as T);
	});
}

/** The rule id and piece number of a piece id (`<rule id>#<k>`), or null for a rule's own id. */
export function splitPieceOf(id: string): { ruleId: string; k: number } | null {
	const at = id.lastIndexOf(SPLIT_PIECE_SEPARATOR);
	if (at <= 0) return null;
	const k = Number(id.slice(at + 1));
	return Number.isInteger(k) && k >= 0 && String(k) === id.slice(at + 1) ? { ruleId: id.slice(0, at), k } : null;
}

/** A model with its split rules as their pieces (expandTransferSplits); the same object when it has none. */
export function expandModelTransfers<M extends { transfers: Transfer[] }>(model: M, warnings?: string[]): M {
	const transfers = expandTransferSplits(model.transfers ?? [], warnings);
	return transfers === model.transfers ? model : { ...model, transfers };
}
