// Invariants of the firm-yield search (network/yield.ts, WP-3.6), for random
// inputs: checkYield returns null when they hold, else what broke.
import type { ModelInput } from '../project';
import { simulateNetwork } from '../network/simulate';
import { firmYield, isMonotone, prepareYield, storageYieldCapacities, YIELD_DEFAULT_TOLERANCE } from '../network/yield';

/**
 * The input with the dam made lossless (no area, no seepage, no survey curve)
 * and cut off from transfers and its release rule, the
 * conditions under which a storage–yield curve must be monotone and the
 * zero-capacity yield is the smallest daily inflow: a bigger shallow dam can
 * evaporate more than it stores, and transfers out of it grow with it.
 */
export function isolateDam(input: ModelInput, nodeId: string): ModelInput {
	const x = structuredClone(input);
	// A dam that starts below its minimum operating level supplies nothing until
	// it fills to it, and a bigger one (the same fractions) takes longer to: its
	// yield can be lower. Start it at least at that level.
	for (const n of x.model.nodes)
		// Lossless also means no survey curve (its area would evaporate) and no
		// release rule (WP-3.5): a release is a second draft ahead of the yield.
		if (n.id === nodeId) Object.assign(n, { damAreaFullM2: 0, damSeepagePerDay: 0, damInitialPct: Math.max(n.damInitialPct, n.damMinPct), damCurve: null, damReleaseRule: 'none', damReleaseM3Day: null });
	x.model.transfers = x.model.transfers.filter((t) => t.fromNodeId !== nodeId && t.toNodeId !== nodeId);
	return x;
}

/** First farm with a dam, or null. */
export function firstDam(input: ModelInput): string | null {
	return input.model.nodes.find((n) => n.kind === 'farm' && n.damCapacityM3 > 0)?.id ?? null;
}

export function checkYield(input: ModelInput, nodeId: string, tolerance = YIELD_DEFAULT_TOLERANCE): string | null {
	const iso = isolateDam(input, nodeId);
	const p = prepareYield(iso);
	const i = p.nodeIds.indexOf(nodeId);
	const cap = p.plan.nodes[i]!.damCapacityM3;
	const caps = storageYieldCapacities(cap, 5);
	const points = caps.map((c) => firmYield(p, nodeId, { capacityM3: c, tolerance }));

	// 1. Yield is non-decreasing in capacity.
	if (!isMonotone(points, tolerance)) return `yield falls with capacity: ${points.map((q) => `${q.capacityM3}→${q.yieldM3Day}`).join(', ')}`;

	for (const q of points) {
		// 2. yield ≤ mean inflow + initial storage ÷ days.
		if (q.yieldM3Day > q.boundM3Day * (1 + 1e-9) + 1e-9) return `yield ${q.yieldM3Day} above the mean-supply bound ${q.boundM3Day} at ${q.capacityM3} m³`;
		// 3. The yield passes and a draft tolerance above it fails.
		if (q.failureDays !== 0) return `the reported yield ${q.yieldM3Day} fails on ${q.failureDays} days at ${q.capacityM3} m³`;
		if (q.failsAtM3Day !== null && q.failsAtM3Day > q.yieldM3Day * (1 + tolerance) + 1e-6)
			return `bracket too wide at ${q.capacityM3} m³: passes ${q.yieldM3Day}, first failure found ${q.failsAtM3Day}`;
	}

	// 4. At capacity 0 the yield is the smallest daily supply reaching the dam
	// site: K + M + O (no transfers, no storage), with no draft.
	const zeroPlan = { ...p.plan, nodes: p.plan.nodes.map((n, k) => (k === i ? { ...n, damCapacityM3: 0, initialStorageM3: 0, deadStorageM3: 0, demand: new Float64Array(p.days), borehole: undefined } : n)) };
	const w = simulateNetwork(zeroPlan, { workings: true }).workings![i]!;
	let min = Infinity;
	for (let t = 0; t < p.days; t++) min = Math.min(min, w.upstreamToDam[t]! + w.runoffToDam[t]! + w.divertedToDam[t]!);
	const y0 = points[0]!.yieldM3Day;
	if (y0 > min * (1 + 1e-9) + 1e-9 || y0 < min * (1 - tolerance) - 1e-6) return `yield at capacity 0 is ${y0}, the smallest daily supply is ${min}`;
	return null;
}
