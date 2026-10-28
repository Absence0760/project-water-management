<!--
	A Desktop Reserve Model summary file (.tab) shown whole (issue #617, docs/ui.md § The daily EWR at the
	outlet): its header lines, the Annual Flows block, the IFR summary and the monthly table with all seven
	columns under the DRM's two headings (Natural flows; Modified flows (IFR)), plus the total flows in m³/s.
	Read only. `used` says what the daily EWR takes from it: 'tab' marks Total flows, maint. as the TAB flows
	(in words, not by colour alone), 'mar' marks the MAR line as the table MAR. One view for the preview
	before "Use these values" and for the file kept with the source (settings.ewrDailySource.tabFile).
-->
<script lang="ts">
	import type { EwrTabFile } from '@water-management/engine';
	import { WATER_YEAR_MONTHS } from '#lib/format/months.js';
	import { fmtNum } from '#lib/format/number.js';
	import { TAB_COLUMNS, TAB_TOTAL_COLUMN, tabFileM3s } from './drmFiles';

	let { file, used, testid = 'drm-tab-file' }: { file: EwrTabFile; used: 'tab' | 'mar'; testid?: string } = $props();

	const uid = $props.id();
	const m3s = $derived(tabFileM3s(file));
	const natural = TAB_COLUMNS.filter((c) => c.group === 'natural').length;
	const head = $derived(
		[
			['Generated', file.generated],
			['Estimate for', file.title],
			['Total runoff', file.runoff],
			['Ecological category (REC)', file.category],
			['Distribution type', file.distributionType]
		].filter((r): r is [string, string] => !!r[1])
	);
	const isMar = (label: string) => /^MAR$/i.test(label.trim());
</script>

<div class="tabfile" data-testid={testid}>
	{#if head.length}
		<dl class="head" aria-label="{file.name}: header">
			{#each head as [k, v] (k)}
				<div><dt>{k}</dt><dd>{v}</dd></div>
			{/each}
		</dl>
	{/if}
	{#if file.annual.length || file.ifr.length}
		<div class="pair">
			{#if file.annual.length}
				<div class="table-wrap">
					<table class="data compact" data-testid="{testid}-annual">
						<caption>Annual flows <span class="u">(Mm³ or index values)</span></caption>
						<tbody>
							{#each file.annual as l, i (i)}
								<tr class:used={used === 'mar' && isMar(l.label)}>
									<th scope="row">{l.label}{#if used === 'mar' && isMar(l.label)}{' '}<span class="mark">used: the table MAR</span>{/if}</th>
									<td class="num">{fmtNum(l.value, 3)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
			{#if file.ifr.length}
				<div class="table-wrap">
					<table class="data compact" data-testid="{testid}-ifr">
						<caption>IFR summary</caption>
						<thead>
							<tr>
								<th scope="col">Requirement</th>
								<th scope="col" class="num">Mm³/a</th>
								<th scope="col" class="num">% MAR</th>
							</tr>
						</thead>
						<tbody>
							{#each file.ifr as l, i (i)}
								<tr>
									<th scope="row">{l.label}</th>
									<td class="num">{fmtNum(l.mcm, 3)}</td>
									<td class="num">{l.pctMar === null ? '–' : fmtNum(l.pctMar, 2)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	{/if}
	<div class="table-wrap">
		<table class="data compact monthly" data-testid="{testid}-monthly" aria-describedby="{uid}-used">
			<caption>Monthly distributions <span class="u">(Mm³ a month; the last column m³/s)</span></caption>
			<colgroup><col /></colgroup>
			<colgroup span={natural}></colgroup>
			<colgroup span={TAB_COLUMNS.length - natural + 1}></colgroup>
			<thead>
				<tr>
					<td class="corner" aria-hidden="true"></td>
					<th scope="colgroup" colspan={natural} class="grp">Natural flows</th>
					<th scope="colgroup" colspan={TAB_COLUMNS.length - natural + 1} class="grp">Modified flows (IFR)</th>
				</tr>
				<tr>
					<th scope="col">Month</th>
					{#each TAB_COLUMNS as c, i (c.label)}
						<th scope="col" class="num" class:used={used === 'tab' && i === TAB_TOTAL_COLUMN}>{c.label}{#if used === 'tab' && i === TAB_TOTAL_COLUMN}{' '}<span class="mark">used: the TAB flows</span>{/if}</th>
					{/each}
					<th scope="col" class="num" class:used={used === 'tab'}>Total flows, maint. <span class="u">(m³/s)</span>{#if used === 'tab'}{' '}<span class="mark">the TAB flows</span>{/if}</th>
				</tr>
			</thead>
			<tbody>
				{#each WATER_YEAR_MONTHS as m, r (m)}
					<tr>
						<th scope="row">{m}</th>
						{#each file.monthlyMcm[r] ?? [] as v, c (c)}
							<td class="num" class:used={used === 'tab' && c === TAB_TOTAL_COLUMN}>{fmtNum(v, 3)}</td>
						{/each}
						<td class="num" class:used={used === 'tab'}>{fmtNum(m3s[r], 4)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
	<p class="small note" id="{uid}-used">
		{#if used === 'tab'}
			The TAB flows are the last two columns: <strong>Total flows, maint.</strong> in Mm³ a month, and the same as each month’s mean flow in m³/s (÷ the month’s days × 86 400 s, February 28 days).
		{:else}
			Its <strong>MAR</strong> is the table MAR the percentile tables are scaled by; its monthly flows are for the TAB file method.
		{/if}
	</p>
</div>

<style>
	.tabfile {
		display: grid;
		gap: 0.25rem;
		min-width: 0;
	}
	.head {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1.5rem;
		margin: 0.35rem 0 0;
		font-size: var(--font-sm);
	}
	.head div {
		display: flex;
		gap: 0.4rem;
		min-width: 0;
	}
	.head dt {
		color: var(--text-muted);
	}
	.head dt::after {
		content: ':';
	}
	.head dd {
		margin: 0;
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	/* Annual flows and the IFR summary side by side where they fit, one over the other on a phone. */
	.pair {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0 1.25rem;
	}
	.pair .table-wrap {
		flex: 0 1 auto;
		max-width: 100%;
	}
	caption {
		text-align: left;
		font-size: 0.85rem;
		font-weight: 500;
		padding: 0.5rem 0 0.25rem;
	}
	.u {
		font-weight: 400;
		color: var(--text-muted);
		font-size: var(--font-sm);
	}
	th[scope='row'] {
		white-space: nowrap;
	}
	.grp {
		text-align: center;
		border-bottom: 1px solid var(--border);
	}
	.corner {
		background: var(--surface-2);
	}
	/* On a phone the month column is pinned (app.css, data-scrolls-x): pin the empty corner above it too, and the caption. */
	:global(.table-wrap[data-scrolls-x]) .corner {
		position: sticky;
		left: 0;
		z-index: 2;
	}
	.monthly caption {
		position: sticky;
		left: 0;
	}
	/* The column the daily EWR reads: named under its heading ("used: …"), tinted only as a second cue. */
	.used {
		background: var(--accent-soft);
	}
	.mark {
		display: block;
		font-weight: 600;
		font-size: var(--font-xs);
		color: var(--text-2);
		white-space: nowrap;
	}
	.monthly th[scope='col'] {
		vertical-align: bottom;
	}
	.note {
		margin: 0.25rem 0 0;
		max-width: 75ch;
	}
</style>
