<script lang="ts">
	// A sparkline that says what it shows (docs/design/ui-playbook.md § 3,
	// "Label every chart"): the compact chart for a row or a card, where full
	// axes don't fit. Under the line: the first and last x labels (months,
	// dates) and the peak (or low) with its value, marked by a dot; pointing at
	// the line reads out that point instead ("Jan 0.80"). The caption names the
	// quantity and its span ("Crop factor by month, Oct–Sep"); a list of rows
	// shows it once as a column header (`captionHidden`), a card on its own.
	// The accessible name is the item, the caption and the numbers in words
	// (every value for a dozen or fewer). The keyboard reads it out too: a
	// slider over the line takes focus (starting at the mark) and the arrow
	// keys, Page Up/Down, Home and End step the read-out and the dot, its
	// value in words as `aria-valuetext`. Geometry and words: sparkline.ts.
	import {
		dotAt,
		extremeIndex,
		keyStep,
		markText,
		nearestPoint,
		readout,
		sparkDescription,
		sparkPaths,
		sparkPoints,
		SPARK_H,
		SPARK_W,
		type SparkPoint
	} from './sparkline';

	let {
		values,
		labels,
		caption,
		name,
		format,
		lo = 0,
		hi,
		x,
		ends,
		mark = 'max',
		markWord = mark === 'max' ? 'max' : 'low',
		markLabel = false,
		captionHidden = false,
		px = 24,
		color = 'var(--accent)',
		stroke = 1.5
	}: {
		/** The values, left to right (null = a gap). */
		values: readonly (number | null)[];
		/** One per value: its month or date, for the ends, the mark and the read-out. */
		labels: readonly string[];
		/** What it shows and over what span: "Crop factor by month, Oct–Sep". Required: a chart always says what it is. */
		caption: string;
		/** The item it belongs to ("Orchard"), the start of the accessible name. */
		name?: string;
		/** A value in words with its unit: 0.8 → "0.80", 15 → "15%". */
		format: (v: number) => string;
		/** The bottom of the box (default 0) and its top (default the highest value). */
		lo?: number;
		hi?: number;
		/** Each value's place across, 0…1 (default evenly spaced). */
		x?: readonly number[];
		/** The labels under the ends (default the first and last label). */
		ends?: readonly [string, string];
		/** Which point to mark with its value. */
		mark?: 'max' | 'min';
		markWord?: string;
		/** Add the marked point's label to its value ("low 15% · 19 Dec 2023"), where there is room. */
		markLabel?: boolean;
		/** The caption is shown elsewhere (a list's column header); it stays in the accessible name. */
		captionHidden?: boolean;
		/** Height of the line's box, px. */
		px?: number;
		color?: string;
		stroke?: number;
	} = $props();

	const top = $derived(hi ?? Math.max(lo + 1e-9, ...values.filter((v): v is number => v != null && Number.isFinite(v))));
	const pts = $derived(sparkPoints(values, lo, top, x));
	const paths = $derived(sparkPaths(pts));
	const endWords = $derived<readonly [string, string]>(ends ?? [labels[0] ?? '', labels[labels.length - 1] ?? '']);
	const words = $derived({ values, labels, format, mark, markWord });
	const markIdx = $derived(extremeIndex(values, mark));
	const markPt = $derived(pts.find((p) => p.i === markIdx) ?? null);
	const label = $derived(`${name ? `${name}: ` : ''}${caption}. ${sparkDescription(words, endWords)}.`);

	// The read-out: the point under the pointer, until it leaves; else the
	// keyboard's point while the slider has focus; else the mark.
	let hover = $state<SparkPoint | null>(null);
	function move(e: PointerEvent) {
		const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
		hover = box.width > 0 ? nearestPoint(pts, (e.clientX - box.left) / box.width) : null;
	}
	/** The keyboard's point, an index into `pts`; null without focus. */
	let keyAt = $state<number | null>(null);
	const markAt = $derived(Math.max(0, pts.findIndex((p) => p.i === markIdx)));
	const keyPt = $derived(keyAt == null ? null : (pts[Math.min(keyAt, pts.length - 1)] ?? null));
	function key(e: KeyboardEvent) {
		const to = keyStep(pts, keyAt ?? markAt, e.key);
		if (to === undefined) return;
		e.preventDefault();
		keyAt = to;
	}
	const shown = $derived(hover ?? keyPt);
	const sliderPt = $derived(keyPt ?? markPt);
	const dot = $derived(shown ?? markPt);
	const dotPos = $derived(dot ? dotAt(dot) : null);
</script>

<figure class="sparkline" class:long={markLabel} style:--spark-c={color} style:--spark-w={stroke} data-testid="sparkline">
	{#if !captionHidden}<figcaption class="cap">{caption}</figcaption>{/if}
	<!-- The pointer's read-out; the keyboard's is the slider laid over the line. -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="plot" style:height="{px}px" onpointermove={move} onpointerleave={() => (hover = null)}>
		<svg viewBox="0 0 {SPARK_W} {SPARK_H}" preserveAspectRatio="none" role="img" aria-label={label}>
			<path d={paths.fill} class="fill" />
			<polyline points={paths.line} class="line" />
		</svg>
		{#if sliderPt}
			<span
				class="keys"
				role="slider"
				tabindex="0"
				aria-label="{name ? `${name}: ` : ''}{caption}, read-out"
				aria-orientation="horizontal"
				aria-valuemin={0}
				aria-valuemax={values.length - 1}
				aria-valuenow={sliderPt.i}
				aria-valuetext={readout(labels, values, sliderPt.i, format)}
				onkeydown={key}
				onmousedown={(e) => e.preventDefault()}
				onfocus={() => (keyAt = markAt)}
				onblur={() => (keyAt = null)}
			></span>
		{/if}
		{#if dotPos}<span class="dot" class:hover={!!shown} style:left="{dotPos.left * 100}%" style:top="{dotPos.top * 100}%" aria-hidden="true"></span>{/if}
	</div>
	<div class="ticks" aria-hidden="true">
		<span class="end">{endWords[0]}</span>
		<span class="read" data-testid="sparkline-read">{shown ? readout(labels, values, shown.i, format) : markText(words, markLabel)}</span>
		<span class="end">{endWords[1]}</span>
	</div>
</figure>

<style>
	.sparkline {
		margin: 0;
		min-width: 0;
		container: sparkline / inline-size;
	}
	.cap {
		font-size: 0.75rem;
		color: var(--text-muted);
		line-height: 1.3;
		margin-bottom: 0.15rem;
	}
	.plot {
		position: relative;
	}
	svg {
		display: block;
		width: 100%;
		height: 100%;
		overflow: visible;
	}
	/* The keyboard's slider: the line's box, invisible but for its focus ring. A mouse press doesn't focus it
	   (onmousedown), so pointing and clicking behave as before and a click still reaches the card beneath. */
	.keys {
		position: absolute;
		inset: 0;
		border-radius: 2px;
	}
	.fill {
		fill: var(--spark-c);
		opacity: 0.14;
	}
	.line {
		fill: none;
		stroke: var(--spark-c);
		stroke-width: var(--spark-w);
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
	}
	.dot {
		position: absolute;
		width: 6px;
		height: 6px;
		margin: -3px 0 0 -3px;
		border-radius: 50%;
		background: var(--spark-c);
		box-shadow: 0 0 0 1.5px var(--surface);
		pointer-events: none;
	}
	.dot.hover {
		width: 8px;
		height: 8px;
		margin: -4px 0 0 -4px;
	}
	/* The ends at the edges, the mark (or read-out) between them; one line, never wrapping into the row below. */
	.ticks {
		display: flex;
		justify-content: space-between;
		gap: 0.3rem;
		margin-top: 0.1rem;
		font-size: 0.7rem;
		line-height: 1.2;
		color: var(--text-muted);
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.read {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--text-2);
		font-weight: 600;
	}
	.end {
		flex: none;
	}
	/* A mark with its date ("low 15% · 19 Dec 2023") doesn't fit between two dates in a narrow card (a phone's two
	   columns): the dates stay at the ends and the mark takes its own line under them. 20rem = 280 px at the 14 px root. */
	@container sparkline (max-width: 20rem) {
		.long .ticks {
			flex-wrap: wrap;
			row-gap: 0;
		}
		.long .read {
			order: 3;
			flex-basis: 100%;
		}
	}
</style>
