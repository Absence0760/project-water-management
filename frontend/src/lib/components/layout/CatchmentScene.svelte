<script lang="ts">
	// Decorative catchment illustration for the sign-in panel: the Outlet mark
	// grown into a scene. Ridge contours, farms (some with dams) draining
	// through a gauge to the outflow gauge, water moving down the rivers and
	// ripples at the outlet. CSS-only motion, off under prefers-reduced-motion.
	// Coordinates are in a 600 × 800 box; nothing here is data.

	type Pt = readonly [number, number];
	// The top-left stays clear of nodes: the panel copy sits there.
	const N = {
		a0: [40, 380],
		a: [110, 450],
		b: [300, 380],
		j2: [230, 520],
		c0: [370, 130],
		c: [400, 290],
		d: [548, 330],
		j3: [440, 460],
		e: [545, 590],
		f: [100, 660],
		j1: [320, 615],
		o: [320, 740]
	} as const satisfies Record<string, Pt>;
	type Id = keyof typeof N;

	// Upstream → downstream, so the dash animation runs with the flow.
	const REACHES: [Id, Id][] = [
		['a0', 'a'],
		['a', 'j2'],
		['b', 'j2'],
		['c0', 'c'],
		['c', 'j3'],
		['d', 'j3'],
		['j2', 'j1'],
		['j3', 'j1'],
		['e', 'j1'],
		['f', 'j1'],
		['j1', 'o']
	];

	/** A gently bowed curve between two points (bows alternate sides). */
	function reach([x1, y1]: Pt, [x2, y2]: Pt, i: number): string {
		const mx = (x1 + x2) / 2;
		const my = (y1 + y2) / 2;
		const dx = x2 - x1;
		const dy = y2 - y1;
		const len = Math.hypot(dx, dy) || 1;
		const bow = (i % 2 ? 1 : -1) * Math.min(28, len * 0.14);
		const cx = mx + (-dy / len) * bow;
		const cy = my + (dx / len) * bow;
		return `M${x1} ${y1} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x2} ${y2}`;
	}
	const rivers = REACHES.map(([u, d], i) => ({ d: reach(N[u], N[d], i), main: d === 'o' || d === 'j1', i }));

	/** Irregular closed loop (a contour ring) around a hill top. */
	function contour(cx: number, cy: number, r: number, seed: number, squash = 0.72): string {
		const pts: string[] = [];
		const steps = 48;
		for (let k = 0; k < steps; k++) {
			const t = (k / steps) * Math.PI * 2;
			const wob = 1 + 0.09 * Math.sin(3 * t + seed) + 0.05 * Math.sin(5 * t + seed * 1.7);
			pts.push(`${(cx + Math.cos(t) * r * wob).toFixed(1)} ${(cy + Math.sin(t) * r * wob * squash).toFixed(1)}`);
		}
		return `M${pts.join(' L')} Z`;
	}
	const hills = [
		{ cx: 110, cy: 110, rs: [40, 80, 125, 175, 230], seed: 1.3 },
		{ cx: 470, cy: 150, rs: [34, 70, 110, 155, 205, 260], seed: 2.1 },
		{ cx: 560, cy: 610, rs: [45, 95, 150], seed: 0.4 },
		{ cx: 20, cy: 680, rs: [60, 120, 180], seed: 3.3 }
	];
	const contours = hills.flatMap((h, hi) => h.rs.map((r, ri) => ({ d: contour(h.cx, h.cy, r, h.seed + ri * 0.35), hi })));

	const farms: Id[] = ['a0', 'a', 'b', 'c0', 'c', 'd', 'e', 'f'];
	const dams: Id[] = ['b', 'd', 'f'];
</script>

<svg class="scene" viewBox="0 0 600 800" preserveAspectRatio="xMaxYMax slice" aria-hidden="true" focusable="false">
	<g class="contours">
		{#each contours as c, i (i)}
			<path d={c.d} class="contour" class:drift-b={c.hi % 2 === 1} />
		{/each}
	</g>

	<g class="rivers">
		{#each rivers as r (r.i)}
			<path d={r.d} class="bed" class:main={r.main} />
		{/each}
		{#each rivers as r (r.i)}
			<path d={r.d} class="flow" class:main={r.main} style="animation-delay: -{(r.i * 0.37).toFixed(2)}s" />
		{/each}
	</g>

	{#each dams as id (id)}
		<ellipse class="dam" cx={N[id][0] - 16} cy={N[id][1] - 14} rx="20" ry="11" transform="rotate(-18 {N[id][0] - 16} {N[id][1] - 14})" />
	{/each}

	{#each farms as id (id)}
		<circle class="farm" cx={N[id][0]} cy={N[id][1]} r="8" />
	{/each}

	<!-- Mid-catchment gauges -->
	{#each ['j2', 'j3', 'j1'] as const as id (id)}
		<rect class="gauge" x={N[id][0] - 6} y={N[id][1] - 6} width="12" height="12" transform="rotate(45 {N[id][0]} {N[id][1]})" />
	{/each}

	<!-- Outflow gauge with ripples, as in the mark -->
	<g class="outlet">
		<circle class="ripple r1" cx={N.o[0]} cy={N.o[1]} r="22" />
		<circle class="ripple r2" cx={N.o[0]} cy={N.o[1]} r="22" />
		<circle class="ring" cx={N.o[0]} cy={N.o[1]} r="22" />
		<circle class="core" cx={N.o[0]} cy={N.o[1]} r="12" />
	</g>
</svg>

<style>
	.scene {
		display: block;
		width: 100%;
		height: 100%;
	}
	.contour {
		fill: none;
		stroke: #d9e6f2;
		stroke-opacity: 0.09;
		stroke-width: 1.2;
	}
	.contours {
		animation: drift 22s ease-in-out infinite alternate;
	}
	.contour.drift-b {
		animation: drift-b 26s ease-in-out infinite alternate;
	}
	.bed {
		fill: none;
		stroke: #d9e6f2;
		stroke-opacity: 0.28;
		stroke-width: 3;
		stroke-linecap: round;
	}
	.bed.main {
		stroke-width: 4.5;
	}
	.flow {
		fill: none;
		stroke: #36c6e0;
		stroke-width: 2.2;
		stroke-linecap: round;
		stroke-dasharray: 3 19;
		animation: flow 2.6s linear infinite;
	}
	.flow.main {
		stroke-width: 3;
	}
	.farm {
		fill: #d9e6f2;
	}
	.dam {
		fill: #36c6e0;
		fill-opacity: 0.28;
		stroke: #36c6e0;
		stroke-opacity: 0.55;
		stroke-width: 1.5;
	}
	.gauge {
		fill: #102a43;
		stroke: #d9e6f2;
		stroke-width: 2;
	}
	.ring {
		fill: none;
		stroke: #36c6e0;
		stroke-width: 2.5;
		stroke-opacity: 0.6;
	}
	.core {
		fill: #36c6e0;
	}
	.ripple {
		fill: none;
		stroke: #36c6e0;
		stroke-width: 2;
		transform-box: fill-box;
		transform-origin: center;
		opacity: 0;
		animation: ripple 4.8s ease-out infinite;
	}
	.r2 {
		animation-delay: 2.4s;
	}
	@keyframes flow {
		to {
			stroke-dashoffset: -44;
		}
	}
	@keyframes ripple {
		0% {
			transform: scale(1);
			opacity: 0.55;
		}
		100% {
			transform: scale(3.2);
			opacity: 0;
		}
	}
	@keyframes drift {
		to {
			transform: translate(6px, 10px);
		}
	}
	@keyframes drift-b {
		to {
			transform: translate(-8px, 6px);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.contours,
		.contour.drift-b,
		.flow,
		.ripple {
			animation: none;
		}
		.flow {
			stroke-dasharray: none;
			stroke-opacity: 0.5;
		}
		.r1 {
			opacity: 0.3;
			transform: scale(1.7);
		}
	}
</style>
