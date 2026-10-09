<!--
	What files the EWR and Reserve upload points take, and what each part of a
	Desktop Reserve Model file fills (issue #455): a disclosure under each
	file picker on Settings → the daily EWR at the outlet and → Reserve rule
	tables, with synthetic example files to download. `target` says which
	form the files fill. Helpers and the example files in ./drmFiles.ts.
-->
<script lang="ts">
	import { exampleHref, exampleRulFile, exampleTabFile } from './drmFiles';

	// `name` ends the disclosure's summary, so two on one page differ ("… into the rule table at the outlet").
	let { target, csvHref = null, name }: { target: 'ruleTable' | 'dailyEwr'; csvHref?: string | null; name: string } = $props();
</script>

<details class="format">
	<summary>Which files can I load {name}, and what do they fill?</summary>
	<ul>
		<li>
			<strong>Desktop Reserve Model rule curves (.rul)</strong>: the header (<code>Ecological Category = B</code>), a unit line
			(<code>Data are given in m^3/s mean monthly flow</code>, or <code>… m^3 * 10^6 monthly flow volume</code> for Mm³ a month), the
			<code>% Points</code> line (10% … 99%), then three blocks of 12 month rows, a month name and one number per point: the total Reserve
			(right after the points), <code>Reserve Flows without High Flows</code> and <code>Natural Duration curves</code>.
			{#if target === 'ruleTable'}
				They fill the EWR (total flow), the low flows and the natural flows at each point, in the file’s unit, and the REC.
			{:else}
				The total Reserve and the natural duration curve fill the two percentile tables, converted to m³/s when the file is in Mm³ (a
				month’s volume ÷ its days × 86 400 s, February 28 days).
			{/if}
		</li>
		<li>
			<strong>Desktop Reserve Model summary (.tab)</strong>: <code>MAR = …</code> (Mm³ a year), <code>Ecological Category = …</code> and the
			<code>Monthly Distributions (Mill. cu. m.)</code> table (Month, natural mean, SD, CV, then low flows maint. and drought, high flows
			maint., total flows maint.).
			{#if target === 'ruleTable'}
				It fills the determination’s natural MAR and the REC.
			{:else}
				The last column, <em>Total Flows, Maint.</em>, in Mm³ a month, becomes the TAB flows in m³/s (÷ the month’s days × 86 400 s,
				February 28 days); the MAR fills the table MAR. You see the converted values before they are used.
			{/if}
		</li>
		<li>
			<strong>A spreadsheet paste or CSV</strong>: 12 month rows (Oct … Sep, or month names in the first column), optionally with a heading
			row of % points{target === 'dailyEwr' ? ', in m³/s' : ''}. A comma between digits in a tab-separated paste is a decimal comma.
		</li>
	</ul>
	<p class="small">
		Either line ending (Windows CRLF or LF) is read. A line that doesn’t fit is named in the message, with its line number.
		Example files (synthetic numbers):
		<a href={exampleHref(exampleRulFile('m3s'))} download="drm-example.rul">.rul in m³/s</a>,
		<a href={exampleHref(exampleRulFile('mcm'))} download="drm-example-mcm.rul">.rul in Mm³</a>,
		<a href={exampleHref(exampleTabFile())} download="drm-example.tab">.tab</a>{#if csvHref},
			<a href={csvHref} download="ewr-example.csv">CSV</a>{/if}.
	</p>
</details>

<style>
	.format {
		font-size: 0.8rem;
		max-width: 75ch;
		margin-top: 0.35rem;
	}
	.format summary {
		cursor: pointer;
		color: var(--text-2);
	}
	.format ul {
		padding-left: 1.1rem;
		margin: 0.35rem 0;
	}
	.format li {
		margin-bottom: 0.3rem;
	}
	code {
		font-size: 0.75rem;
	}
</style>
