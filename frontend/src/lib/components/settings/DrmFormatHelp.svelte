<!--
	The "Expected format" of the EWR and Reserve upload points (issue #455):
	the shared note (common/FormatHelp.svelte, docs/ui.md § Expected format)
	with what each part of a Desktop Reserve Model file fills, beside the file
	picker on Settings → the daily EWR at the outlet and on each Reserve rule
	table, and synthetic example files to download (the .rul in m³/s and in
	Mm³, the .tab, and the caller's CSVs). `target` says which form the files
	fill; `context` tells two notes on one page apart for a screen reader.
	Helpers and the example files in ./drmFiles.ts.
-->
<script lang="ts">
	import FormatHelp from '$lib/components/common/FormatHelp.svelte';
	import type { ExampleFile } from '$lib/components/common/formatHelp';
	import { drmExampleFiles } from './drmFiles';

	let { target, csvFiles = [], context }: { target: 'ruleTable' | 'dailyEwr'; csvFiles?: readonly ExampleFile[]; context: string } = $props();

	const accepts = $derived(
		target === 'ruleTable'
			? 'A Desktop Reserve Model rule-curve file (.rul) or summary (.tab), plain text; or a CSV (.csv, .tsv, .txt) of the 12 month rows, which goes into the paste box below the table.'
			: 'A Desktop Reserve Model summary (.tab) or rule-curve file (.rul), plain text. A CSV isn’t loaded here: paste its rows into the box below the tables.'
	);
</script>

<FormatHelp {accepts} exampleFiles={[...drmExampleFiles(), ...csvFiles]} {context}>
	<ul>
		<li>
			<strong>Rule curves (.rul)</strong>: the header (<code>Ecological Category = B</code>), a unit line (<code>Data are given in m^3/s mean monthly flow</code>,
			or <code>… m^3 * 10^6 monthly flow volume</code> for Mm³ a month), the <code>% Points</code> line (10% … 99%), then three blocks of 12 month rows, a month
			name and one number per point: the total Reserve (right after the points), <code>Reserve Flows without High Flows</code> and
			<code>Natural Duration curves</code>.
			{#if target === 'ruleTable'}
				They fill the EWR (total flow), the low flows and the natural flows at each point, in the file’s unit, the % points and the REC.
			{:else}
				The total Reserve and the natural duration curve fill the two percentile tables, converted to m³/s when the file is in Mm³ (a month’s volume ÷ its days ×
				86 400 s, February 28 days). The method you picked stays as it is.
			{/if}
		</li>
		<li>
			<strong>Summary (.tab)</strong>: <code>MAR = …</code> (Mm³ a year), <code>Ecological Category = …</code> and the
			<code>Monthly Distributions (Mill. cu. m.)</code> table (Month, natural mean, SD, CV, then low flows maint. and drought, high flows maint., total flows maint.).
			{#if target === 'ruleTable'}
				It fills the determination’s natural MAR and the REC.
			{:else}
				The last column, <em>Total Flows, Maint.</em>, in Mm³ a month, becomes the TAB flows in m³/s (÷ the month’s days × 86 400 s, February 28 days); the MAR
				fills the table MAR. You see the converted values before they are used; under the percentile tables only its MAR is offered.
			{/if}
		</li>
		<li>
			<strong>A spreadsheet paste or CSV</strong>: 12 month rows (Oct … Sep, or month names in the first column), optionally with a heading row of % points{target ===
			'dailyEwr'
				? ', in m³/s'
				: ''}. A comma between digits in a tab-separated paste is a decimal comma.
		</li>
		<li>Either line ending (Windows CRLF or LF) is read. A line that doesn’t fit is named in the message, with its line number.</li>
	</ul>
	<p>The example files hold synthetic numbers.</p>
</FormatHelp>
