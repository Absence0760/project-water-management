<script lang="ts">
	// One calendar month's flow-duration check at a Reserve site (§1 The river,
	// C13): the EWR curve against the simulated (impacted) curve of each run
	// and the natural curve, read at the rule table's points, log scale. Lines
	// differ in dash as well as weight (§8: colour is never the only cue).
	import { fmtNum } from '$lib/format/number';

	type Point = { point: number; required: number; a: number | null; b: number | null; natural: number | null };
	let { points, title, unit, caption }: { points: Point[]; title: string; unit: string; caption: string } = $props();

	const uid = $props.id();
	const W = 340;
	const H = 200;
	const L = 44;
	const R = 8;
	const T = 8;
	const B = 26;
	/** Zero flows are drawn at the floor, said in the caption. */
	const FLOOR = 1e-4;

	const values = $derived(points.flatMap((p) => [p.required, p.a, p.b, p.natural]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
	const lo = $derived(Math.max(FLOOR, Math.min(...values.map((v) => Math.max(v, FLOOR)))));
	const hi = $derived(Math.max(lo * 10, ...values));
	const ly = (v: number) => Math.log10(Math.max(v, FLOOR));
	const x = (p: number) => L + (p / 100) * (W - L - R);
	const y = (v: number) => T + ((ly(hi) - ly(v)) / (ly(hi) - ly(lo) || 1)) * (H - T - B);
	const path = (key: 'required' | 'a' | 'b' | 'natural') =>
		points
			.filter((p) => typeof p[key] === 'number')
			.map((p, i) => `${i ? 'L' : 'M'}${x(p.point).toFixed(1)},${y(p[key] as number).toFixed(1)}`)
			.join(' ');
	const decades = $derived.by(() => {
		const out: number[] = [];
		for (let e = Math.floor(ly(lo)); e <= Math.ceil(ly(hi)); e++) out.push(10 ** e);
		return out.filter((v) => v >= lo * 0.999 && v <= hi * 1.001);
	});
	const hasB = $derived(points.some((p) => p.b !== null));
</script>

<figure class="fdc">
	<svg viewBox="0 0 {W} {H}" role="img" aria-labelledby="{uid}-t" preserveAspectRatio="xMinYMin meet">
		<title id="{uid}-t">{title}</title>
		{#each decades as d (d)}
			<line class="grid" x1={L} x2={W - R} y1={y(d)} y2={y(d)} />
			<text class="axis" x={L - 4} y={y(d) + 3} text-anchor="end">{fmtNum(d, d < 1 ? 4 : 0, true)}</text>
		{/each}
		{#each [0, 50, 100] as p (p)}<text class="axis" x={x(p)} y={H - 10} text-anchor="middle">{p} %</text>{/each}
		<path class="natural" d={path('natural')} />
		<path class="required" d={path('required')} />
		<path class="a" d={path('a')} />
		{#if hasB}<path class="b" d={path('b')} />{/if}
	</svg>
	<ul class="key small">
		<li><span class="sw required"></span>EWR curve</li>
		<li><span class="sw a"></span>Baseline</li>
		{#if hasB}<li><span class="sw b"></span>Application</li>{/if}
		<li><span class="sw natural"></span>Natural</li>
	</ul>
	<figcaption>{caption} Exceedance % across, {unit} up, log scale; zero flows drawn at {FLOOR}.</figcaption>
</figure>

<style>
	.fdc {
		margin: 0;
	}
	svg {
		width: 100%;
		max-width: 520px;
		height: auto;
		display: block;
	}
	path {
		fill: none;
		stroke: var(--text);
	}
	.required {
		stroke-width: 2;
		stroke-dasharray: 5 3;
	}
	.a {
		stroke-width: 1.6;
	}
	.b {
		stroke-width: 1.6;
		stroke-dasharray: 1.5 2;
	}
	.natural {
		stroke: var(--text-muted);
		stroke-width: 0.9;
	}
	.grid {
		stroke: var(--chart-grid);
		stroke-width: 0.6;
	}
	.axis {
		font-size: 8.5px;
		fill: var(--text-muted);
	}
	.key {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		list-style: none;
		padding: 0;
		margin: 0.25rem 0;
	}
	.sw {
		display: inline-block;
		width: 22px;
		height: 0;
		border-top: 1.6px solid var(--text);
		margin-right: 0.35rem;
		vertical-align: middle;
	}
	.sw.required {
		border-top: 2px dashed var(--text);
	}
	.sw.b {
		border-top: 1.6px dotted var(--text);
	}
	.sw.natural {
		border-top: 1px solid var(--text-muted);
	}
	figcaption {
		font-size: 0.8rem;
		color: var(--text-muted);
		max-width: 72ch;
	}
</style>
