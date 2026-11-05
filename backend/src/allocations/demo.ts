// Demo registered users (docs/allocations.md § Demo registered users): two or
// three invented registered users on every farm and water user of a project's
// current model, with invented farm numbers ("123/456") and registered figures
// that look like the unit's own, so the Allocations page's Registered users
// table and its map can be shown on a real project without a WARMS extract.
// POST /projects/:id/allocations/demo stores them as one `demo` source (315),
// so DELETE …/allocations/demo removes exactly them and nothing a person
// entered. Pure: the routes load the model and write the rows.
//
// The figures come from the node's own inputs, scaled by a factor drawn from a
// generator seeded by the project's id, so a project's demo reads the same each
// time it is loaded and no figure is anyone's real registration:
//  * a farm's irrigated area ≈ its planted crop area (cropAreas, m² → ha) × 0.8–1.15,
//    and its volume ≈ that area × 6 000–9 000 m³/ha a year; a farm with no crops
//    registers a volume only (10 000–60 000 m³ a year);
//  * a water user's volume ≈ its demand (userDemandM3Day, the year's mean × 365)
//    × 0.9–1.2, or 20 000–150 000 m³ a year without one, and no irrigated area;
//  * a farm with a dam registers storage ≈ its capacity × 0.85–1.1: about 60 % on
//    a storage-only (s21b) row of the first user, the rest stated on the second
//    user's take, so both of the page's storage rules are on screen.
// Each unit's totals are shared among its users by random weights. Every name is
// one of DEMO_FARMERS ("… (invented)").
import { createHash } from 'node:crypto';
import { plantedHaByNode, Rng, type ProjectModel } from '@water-management/engine';
import { DEMO_FARMERS } from './demoFarmers.js';

/** One demo row, in the shape the routes insert (the import's row fields). */
export interface DemoAllocation {
	nodeId: string;
	registrationNo: string;
	/** The invented farm number, "123/456" (the Registered users table's Farm no.). */
	propertyRef: string;
	holder: string;
	authorisation: 'registration' | 'licence' | 'existing_lawful_use_claimed';
	purpose: 'irrigation' | 'other';
	waterSource: 'surface';
	volumeM3PerYear: number;
	storageM3: number | null;
	irrigatedAreaHa: number | null;
	waterUse: '21a' | '21b';
	reference: string;
}

/** What every demo row's reference says, so a row read anywhere says what it is. */
export const DEMO_REFERENCE = 'Demo registered user (invented), for display only';
/** The demo source's file name in the list of imports. */
export const DEMO_SOURCE_NAME = 'Demo registered users (invented)';

const AUTHORISATIONS: readonly DemoAllocation['authorisation'][] = ['registration', 'licence', 'existing_lawful_use_claimed'];

/** A 32-bit seed from the project's id: the same project draws the same demo. */
export function demoSeed(projectId: string): number {
	return createHash('sha256').update(`demo-registered-users:${projectId}`).digest().readUInt32BE(0);
}

const round = (v: number, step: number) => Math.round(v / step) * step;

/** `total` shared by `weights`, each rounded to `step`, the last taking the remainder so the parts add up to the rounded total. */
function share(total: number, weights: readonly number[], step: number): number[] {
	const t = round(total, step);
	const sum = weights.reduce((a, w) => a + w, 0);
	const parts = weights.map((w) => round((t * w) / sum, step));
	parts[parts.length - 1] = round(t - parts.slice(0, -1).reduce((a, p) => a + p, 0), step);
	// Float dust from the subtraction (0.1 steps): the rounding above is to the step's own grid.
	return parts.map((p) => Number(p.toFixed(step < 1 ? 1 : 0)));
}

/** The farms and water users of the model, in its order, with the rows each gets. */
export function demoAllocations(model: Pick<ProjectModel, 'nodes' | 'cropAreas'>, projectId: string): DemoAllocation[] {
	const rng = new Rng(demoSeed(projectId));
	const planted = plantedHaByNode(model.cropAreas);
	const units = model.nodes.filter((n) => n.kind === 'farm' || n.kind === 'user').sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
	const out: DemoAllocation[] = [];
	const farmNos = new Set<string>();
	const farmNo = () => {
		for (;;) {
			const no = `${rng.int(100, 999)}/${rng.int(1, 999)}`;
			if (!farmNos.has(no)) {
				farmNos.add(no);
				return no;
			}
		}
	};
	let holder = rng.int(0, DEMO_FARMERS.length - 1);
	let seq = 0;
	const registration = () => `DEMO-${String(++seq).padStart(4, '0')}`;
	for (const n of units) {
		const users = rng.int(2, 3);
		const weights = Array.from({ length: users }, () => rng.float(0.6, 1.4));
		let area: number | null = null;
		let volume: number;
		if (n.kind === 'farm') {
			const ha = planted.get(n.id) ?? 0;
			if (ha > 0) {
				area = Math.max(0.1, round(ha * rng.float(0.8, 1.15), 0.1));
				volume = area * rng.float(6_000, 9_000);
			} else volume = rng.float(10_000, 60_000);
		} else {
			const demand = n.userDemandM3Day?.filter((v) => Number.isFinite(v));
			const mean = demand?.length ? demand.reduce((a, v) => a + v, 0) / demand.length : 0;
			volume = mean > 0 ? mean * 365 * rng.float(0.9, 1.2) : rng.float(20_000, 150_000);
		}
		const volumes = share(Math.max(100, volume), weights, 100);
		const areas = area === null ? null : share(area, weights, 0.1);
		const dam = n.kind === 'farm' && n.damCapacityM3 > 0 ? Math.max(1_000, round(n.damCapacityM3 * rng.float(0.85, 1.1), 1_000)) : null;
		const stored21b = dam === null ? 0 : round(dam * 0.6, 1_000);
		for (let k = 0; k < users; k++) {
			const name = DEMO_FARMERS[holder++ % DEMO_FARMERS.length]!;
			const no = farmNo();
			const authorisation = AUTHORISATIONS[(seq + k) % AUTHORISATIONS.length]!;
			const base = { nodeId: n.id, propertyRef: no, holder: name, authorisation, purpose: n.kind === 'farm' ? ('irrigation' as const) : ('other' as const), waterSource: 'surface' as const, reference: DEMO_REFERENCE };
			out.push({
				...base,
				registrationNo: registration(),
				volumeM3PerYear: volumes[k]!,
				storageM3: dam !== null && k === 1 && dam - stored21b > 0 ? dam - stored21b : null,
				irrigatedAreaHa: areas ? areas[k]! : null,
				waterUse: '21a'
			});
			if (dam !== null && k === 0 && stored21b > 0)
				out.push({ ...base, registrationNo: registration(), volumeM3PerYear: 0, storageM3: stored21b, irrigatedAreaHa: null, waterUse: '21b' });
		}
	}
	return out;
}
