// Client-side mirror of the PUT /projects/:id/model validation in docs/api.md,
// so the editor can flag problems before a save round-trip.
import type { ProjectModel } from '@water-management/engine';

export interface ModelIssue {
	/** Which editor tab the issue belongs to. */
	area: 'network' | 'crops' | 'transfers';
	message: string;
}

const inRange = (v: number, lo: number, hi: number) => !Number.isNaN(v) && v >= lo && v <= hi;

export function validateModel(model: ProjectModel): ModelIssue[] {
	const issues: ModelIssue[] = [];
	const { nodes, crops, cropAreas, transfers } = model;
	const nodeIds = new Set(nodes.map((n) => n.id));
	const nodeName = (id: string) => nodes.find((n) => n.id === id)?.name || '(unnamed)';

	// Names
	const seen = new Map<string, number>();
	for (const n of nodes) {
		const key = n.name.trim().toLowerCase();
		if (!key) {
			issues.push({ area: 'network', message: 'Every node needs a name.' });
			continue;
		}
		seen.set(key, (seen.get(key) ?? 0) + 1);
	}
	for (const [key, count] of seen) {
		if (count > 1) {
			const display = nodes.find((n) => n.name.trim().toLowerCase() === key)!.name.trim();
			issues.push({ area: 'network', message: `Node name "${display}" is used ${count} times.` });
		}
	}

	// References
	for (const n of nodes) {
		if (n.downstreamNodeId === n.id) {
			issues.push({ area: 'network', message: `"${nodeName(n.id)}" drains into itself.` });
		} else if (n.downstreamNodeId !== null && !nodeIds.has(n.downstreamNodeId)) {
			issues.push({ area: 'network', message: `"${nodeName(n.id)}" drains into a node that no longer exists.` });
		}
	}

	// Ranges (the API rejects these with a 400)
	const FRACTIONS = ['pctUpstreamToDam', 'pctRunoffToDam', 'damInitialPct', 'damMinPct', 'irrigationEfficiency', 'lossReturnFraction'] as const;
	const NON_NEG = ['areaKm2', 'areaHiKm2', 'areaLoKm2', 'damCapacityM3', 'divertCapacityM3Day'] as const;
	for (const n of nodes) {
		const label = `"${nodeName(n.id)}"`;
		if (n.name.trim().length > 100) issues.push({ area: 'network', message: `${label}: names are limited to 100 characters.` });
		const badFrac = FRACTIONS.some((k) => !inRange(n[k], 0, 1)) || (n.flowShareManual !== null && !inRange(n.flowShareManual, 0, 1));
		if (badFrac) issues.push({ area: 'network', message: `${label}: percentages must be between 0% and 100%.` });
		else if (!(n.irrigationEfficiency > 0)) issues.push({ area: 'network', message: `${label}: irrigation efficiency must be above 0%.` });
		if (NON_NEG.some((k) => !inRange(n[k], 0, Infinity))) {
			issues.push({ area: 'network', message: `${label}: areas and capacities can't be negative.` });
		}
	}

	// Exactly one outlet (unless empty)
	if (nodes.length > 0) {
		const outlets = nodes.filter((n) => n.downstreamNodeId === null);
		if (outlets.length === 0) {
			issues.push({ area: 'network', message: 'The network needs one outlet (a node that drains nowhere).' });
		} else if (outlets.length > 1) {
			issues.push({
				area: 'network',
				message: `The network has ${outlets.length} outlets (${outlets.map((n) => `"${n.name}"`).join(', ')}); exactly one node may drain nowhere.`
			});
		}
	}

	// Cycles: walk downstream from each node; revisiting a node on the same walk is a cycle.
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const reported = new Set<string>();
	for (const start of nodes) {
		const path: string[] = [];
		const onPath = new Set<string>();
		let cur: string | null = start.id;
		while (cur !== null && byId.has(cur) && !onPath.has(cur)) {
			onPath.add(cur);
			path.push(cur);
			cur = byId.get(cur)!.downstreamNodeId;
		}
		if (cur !== null && onPath.has(cur)) {
			const loop = path.slice(path.indexOf(cur));
			const sig = [...loop].sort().join('|');
			// Length-1 loops (self-drainage) are reported above.
			if (loop.length > 1 && !reported.has(sig)) {
				reported.add(sig);
				issues.push({
					area: 'network',
					message: `Cycle in the network: ${loop.map(nodeName).join(' → ')} → ${nodeName(cur)}.`
				});
			}
		}
	}

	// Crops
	const cropIds = new Set(crops.map((c) => c.id));
	const cropNames = new Map<string, number>();
	for (const c of crops) {
		const key = c.name.trim().toLowerCase();
		if (!key) issues.push({ area: 'crops', message: 'Every crop needs a name.' });
		else cropNames.set(key, (cropNames.get(key) ?? 0) + 1);
		if (c.cropFactor.length !== 12 || c.cropFactor.some((f) => !inRange(f, 0, Infinity))) {
			issues.push({ area: 'crops', message: `Crop "${c.name}" needs 12 non-negative monthly factors.` });
		}
	}
	for (const [key, count] of cropNames) {
		if (count > 1) issues.push({ area: 'crops', message: `Crop name "${key}" is used ${count} times.` });
	}
	if (cropAreas.some((a) => !nodeIds.has(a.nodeId) || !cropIds.has(a.cropId))) {
		issues.push({ area: 'crops', message: 'A crop area refers to a deleted farm or crop.' });
	}
	if (cropAreas.some((a) => !inRange(a.areaM2, 0, Infinity))) {
		issues.push({ area: 'crops', message: "Crop areas can't be negative." });
	}

	// Transfers
	transfers.forEach((t, i) => {
		const label = `Transfer ${i + 1}`;
		if (!nodeIds.has(t.fromNodeId) || !nodeIds.has(t.toNodeId)) {
			issues.push({ area: 'transfers', message: `${label}: choose both a source and a destination node.` });
		} else if (t.fromNodeId === t.toNodeId) {
			issues.push({ area: 'transfers', message: `${label}: source and destination are the same node.` });
		}
		if (t.months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)) {
			issues.push({ area: 'transfers', message: `${label}: months must be 1–12.` });
		}
		if (!inRange(t.minStoragePct, 0, 1)) {
			issues.push({ area: 'transfers', message: `${label}: minimum storage must be between 0% and 100%.` });
		}
		if (!inRange(t.maxRateM3s, 0, Infinity) || (t.dailyCapM3 !== null && !inRange(t.dailyCapM3, 0, Infinity))) {
			issues.push({ area: 'transfers', message: `${label}: rates and caps can't be negative.` });
		}
	});

	return issues;
}
