// Flow routing on a DEM grid (docs/design/delineation.md § Method):
// Priority-Flood+ε depression filling (Barnes, Lehman and Mulla 2014,
// Algorithm 3), D8 steepest descent on the filled surface, flow
// accumulation, snapping the outlet to the most-accumulating cell near the
// click, and the outlet's upstream cells.
//
// Pure functions over typed arrays, row-major, y down (north at row 0). No
// I/O: dem.ts fills the grid, delineate.ts drives it.

export interface Grid {
	nx: number;
	ny: number;
	/** Elevation, m; NaN where the DEM has no data. Filled in place by `fill`. */
	z: Float64Array;
}

/** D8 neighbours: E, SE, S, SW, W, NW, N, NE (dx, dy with y down). */
export const DX = [1, 1, 0, -1, -1, -1, 0, 1];
export const DY = [0, 1, 1, 1, 0, -1, -1, -1];
const DIST = [1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2, 1, Math.SQRT2];
/** A cell that drains out of the grid: the window's edge, or no data. */
export const OUT = 255;

const f64 = new Float64Array(1);
const u64 = new BigUint64Array(f64.buffer);
/** The next float64 above v (C's nextafter(v, +∞)) for finite v. */
export function nextUp(v: number): number {
	if (v === 0) return Number.MIN_VALUE;
	f64[0] = v;
	u64[0] = v > 0 ? u64[0]! + 1n : u64[0]! - 1n;
	return f64[0]!;
}

/** A binary min-heap of cell indices keyed on z, ties broken by index, so the result never depends on insertion order. */
class Heap {
	private a: Int32Array;
	size = 0;
	constructor(
		private readonly z: Float64Array,
		cap: number
	) {
		this.a = new Int32Array(Math.max(16, cap));
	}
	private less(i: number, j: number) {
		const zi = this.z[i]!;
		const zj = this.z[j]!;
		return zi < zj || (zi === zj && i < j);
	}
	push(c: number) {
		if (this.size === this.a.length) {
			const b = new Int32Array(this.a.length * 2);
			b.set(this.a);
			this.a = b;
		}
		const a = this.a;
		let i = this.size++;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (!this.less(c, a[p]!)) break;
			a[i] = a[p]!;
			i = p;
		}
		a[i] = c;
	}
	pop(): number {
		const a = this.a;
		const top = a[0]!;
		const last = a[--this.size]!;
		let i = 0;
		const n = this.size;
		for (;;) {
			let k = 2 * i + 1;
			if (k >= n) break;
			if (k + 1 < n && this.less(a[k + 1]!, a[k]!)) k++;
			if (!this.less(a[k]!, last)) break;
			a[i] = a[k]!;
			i = k;
		}
		if (n > 0) a[i] = last;
		return top;
	}
}

/**
 * Edge cells: the grid's border and every no-data cell. Water reaching one
 * leaves the grid, so the flood starts from them.
 */
export function edgeMask(g: Grid): Uint8Array {
	const { nx, ny, z } = g;
	const edge = new Uint8Array(nx * ny);
	for (let y = 0; y < ny; y++) {
		for (let x = 0; x < nx; x++) {
			const i = y * nx + x;
			if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1 || Number.isNaN(z[i]!)) edge[i] = 1;
		}
	}
	return edge;
}

/**
 * Priority-Flood+ε: raises every cell of a depression or flat to just above
 * the cell it spills through (the next float64 up), so every non-edge cell
 * has a strictly lower neighbour and D8 drains everything to an edge.
 * Changes `g.z` in place; returns how many cells were raised.
 */
export function fill(g: Grid, edge: Uint8Array): number {
	const { nx, ny, z } = g;
	const n = nx * ny;
	const closed = new Uint8Array(n);
	const heap = new Heap(z, 4 * (nx + ny));
	const pit = new Int32Array(n);
	let pitHead = 0;
	let pitTail = 0;
	for (let i = 0; i < n; i++) {
		if (!edge[i]) continue;
		closed[i] = 1;
		// A no-data cell floods as if at sea level's floor: anything beside it drains into it.
		if (Number.isNaN(z[i]!)) z[i] = -Infinity;
		// Only edge cells beside a land cell need to be in the queue.
		heap.push(i);
	}
	let raised = 0;
	while (heap.size > 0 || pitHead < pitTail) {
		const c = pitHead < pitTail ? pit[pitHead++]! : heap.pop();
		const cx = c % nx;
		const cy = (c - cx) / nx;
		const up = z[c] === -Infinity ? -Infinity : nextUp(z[c]!);
		for (let d = 0; d < 8; d++) {
			const x = cx + DX[d]!;
			const y = cy + DY[d]!;
			if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
			const k = y * nx + x;
			if (closed[k]) continue;
			closed[k] = 1;
			if (z[k]! <= up) {
				if (up !== -Infinity) {
					z[k] = up;
					raised++;
				}
				pit[pitTail++] = k;
			} else heap.push(k);
		}
	}
	return raised;
}

/** D8 on the filled surface: each cell's steepest strictly-downhill neighbour (0–7), OUT for an edge. */
export function d8(g: Grid, edge: Uint8Array): Uint8Array {
	const { nx, ny, z } = g;
	const dir = new Uint8Array(nx * ny).fill(OUT);
	for (let y = 1; y < ny - 1; y++) {
		for (let x = 1; x < nx - 1; x++) {
			const i = y * nx + x;
			if (edge[i]) continue;
			let best = -1;
			let slope = 0;
			for (let d = 0; d < 8; d++) {
				const k = i + DY[d]! * nx + DX[d]!;
				const s = (z[i]! - z[k]!) / DIST[d]!;
				if (s > slope) {
					slope = s;
					best = d;
				}
			}
			// fill() guarantees a strictly lower neighbour; a grid that skipped it keeps OUT.
			if (best >= 0) dir[i] = best;
		}
	}
	return dir;
}

/** Upstream cell count of every cell, itself included (topological order: no recursion). */
export function accumulate(nx: number, ny: number, dir: Uint8Array): Int32Array {
	const n = nx * ny;
	const indeg = new Int32Array(n);
	const down = (i: number) => {
		const d = dir[i]!;
		return d === OUT ? -1 : i + DY[d]! * nx + DX[d]!;
	};
	for (let i = 0; i < n; i++) {
		const k = down(i);
		if (k >= 0) indeg[k]!++;
	}
	const acc = new Int32Array(n).fill(1);
	const queue = new Int32Array(n);
	let head = 0;
	let tail = 0;
	for (let i = 0; i < n; i++) if (indeg[i] === 0) queue[tail++] = i;
	while (head < tail) {
		const i = queue[head++]!;
		const k = down(i);
		if (k < 0) continue;
		acc[k]! += acc[i]!;
		indeg[k] = indeg[k]! - 1;
		if (indeg[k] === 0) queue[tail++] = k;
	}
	return acc;
}

/**
 * The cell the outlet snaps to: the one with the most upstream cells whose
 * centre lies within `radius` cells of the click (cx, cy), measured from the
 * exact click (fractional cell coordinates, not its cell's corner), so the
 * distance a caller records never exceeds the radius it states (issue #387);
 * the nearest of equals; never an edge cell. The click's own cell always
 * counts, however small the radius. Null when every cell in reach is an edge.
 */
export function snap(nx: number, ny: number, acc: Int32Array, edge: Uint8Array, cx: number, cy: number, radius: number): number | null {
	let best = -1;
	let bestAcc = -1;
	let bestD = Infinity;
	const ix = Math.floor(cx);
	const iy = Math.floor(cy);
	const r = Math.ceil(radius);
	for (let y = iy - r; y <= iy + r; y++) {
		for (let x = ix - r; x <= ix + r; x++) {
			if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
			const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
			if (d > radius && !(x === ix && y === iy)) continue;
			const i = y * nx + x;
			if (edge[i]) continue;
			const a = acc[i]!;
			if (a > bestAcc || (a === bestAcc && d < bestD)) {
				best = i;
				bestAcc = a;
				bestD = d;
			}
		}
	}
	return best < 0 ? null : best;
}

/** The outlet's catchment: every cell whose D8 path passes through it (itself included). */
export function upstream(nx: number, ny: number, dir: Uint8Array, outlet: number): Uint8Array {
	const mask = new Uint8Array(nx * ny);
	const stack = [outlet];
	mask[outlet] = 1;
	while (stack.length) {
		const c = stack.pop()!;
		const cx = c % nx;
		const cy = (c - cx) / nx;
		for (let d = 0; d < 8; d++) {
			const x = cx + DX[d]!;
			const y = cy + DY[d]!;
			if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
			const k = y * nx + x;
			// Neighbour k drains into c when its direction is the opposite of d.
			if (!mask[k] && dir[k] === (d + 4) % 8) {
				mask[k] = 1;
				stack.push(k);
			}
		}
	}
	return mask;
}

/** Whether the catchment reaches a cell beside an edge (so it may continue past the window) and whether that edge is no data. */
export function touchesEdge(g: Grid, edge: Uint8Array, mask: Uint8Array, noData: Uint8Array): { edge: boolean; noData: boolean } {
	const { nx, ny } = g;
	let atEdge = false;
	let atNoData = false;
	for (let y = 0; y < ny; y++) {
		for (let x = 0; x < nx; x++) {
			if (!mask[y * nx + x]) continue;
			for (let d = 0; d < 8; d++) {
				const xx = x + DX[d]!;
				const yy = y + DY[d]!;
				if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
				const k = yy * nx + xx;
				if (edge[k]) {
					atEdge = true;
					if (noData[k]) atNoData = true;
				}
			}
		}
	}
	return { edge: atEdge, noData: atNoData };
}
