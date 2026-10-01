<script lang="ts">
	// Page 1 of the licensing evidence report (docs/design/evidence-report.md
	// §4.1): identity, the assumption banner, "read these first", the change
	// table with paired bands, where the river loses most, "does not decide"
	// and the rules. Fixed content in a fixed order; nothing here is the
	// applicant's own words (G13).
	import type { EvidenceReport } from '@water-management/engine';
	import type { Signoff } from '$lib/api';
	import { fmtDate, fmtNum } from '$lib/format/number';
	import { monthName } from '$lib/format/months';
	import type { VerifyRef } from '$lib/components/packs/pack';
	import LicenceImpactBoard from '../LicenceImpactBoard.svelte';
	import type { BoardView } from '../licenceImpact';
	import { changeText, signed, valueText, worseText } from './format';
	import { FORMER_MEMBER } from '$lib/format/maker';

	let {
		report,
		board = null,
		boardNotFrozen = false,
		signoffs,
		verify
	}: {
		report: EvidenceReport;
		/** Licence impact by year class (issue #53 R7), after the change table (§4.1); null for baseline evidence. */
		board?: BoardView | null;
		/** An evidence pack drafted before evidence-5: its manifest has no board, so it is left out and says so. */
		boardNotFrozen?: boolean;
		signoffs: readonly Pick<Signoff, 'fullName' | 'registrationBody' | 'registrationNo'>[];
		/** An issued pack's manifest hash, short code and verify link; null for a draft. */
		verify: VerifyRef | null;
	} = $props();

	const id = $derived(report.identity);
	const app = $derived(report.mode === 'application');
	const cls = { red: 'flag-red', caution: 'flag-caution', count: 'flag-count' } as const;
	/** Page 1 lists at most this many other users; § 4 lists every one. */
	const USERS_ON_PAGE_1 = 5;
	const rows = $derived.by(() => {
		const users = report.rows.filter((r) => r.id === 'userSupply' && r.subject);
		const rest = report.rows.filter((r) => !(r.id === 'userSupply' && r.subject));
		return { shown: [...rest, ...users.slice(0, USERS_ON_PAGE_1)], more: Math.max(0, users.length - USERS_ON_PAGE_1) };
	});
	const outlet = $derived(report.river[0] ?? null);
	const band = (m: { median: number; band: { p5: number | null; p95: number | null } }) =>
		`${signed(m.median, 0)} days (${m.band.p5 === null ? '–' : signed(m.band.p5, 0)} to ${m.band.p95 === null ? '–' : signed(m.band.p95, 0)})`;
</script>

<dl class="idgrid">
	<div>
		<dt>Baseline</dt>
		<dd>
			{#if id.baseline.nomination}
				Nominated evidence run, {fmtDate(id.baseline.nomination.nominatedAt)} by {id.baseline.nomination.nominatedBy ?? FORMER_MEMBER}
			{:else}
				<strong>Not the nominated evidence run</strong>
			{/if}
			<span class="sub">{id.baseline.runoffModel === 'gr4j' ? 'GR4J' : id.baseline.runoffModel} · {id.baseline.startDate} – {id.baseline.endDate}</span>
			<span class="sub" data-testid="evidence-published">
				{#if id.baseline.published === 'this'}The project’s published baseline (since {fmtDate(id.baseline.publishedAt)}){:else if id.baseline.published === 'other'}<strong>Not the published baseline:</strong> another run was published {fmtDate(id.baseline.publishedAt)}{:else}Nothing is published for this project{/if}
			</span>
			<!-- evidence-13 (163_licensing_authority): the authority's endorsement; a pack drafted before has no such field and says nothing. -->
			{#if id.baseline.endorsement !== undefined}
				<span class="sub" data-testid="evidence-endorsement">
					{#if id.baseline.endorsement}Endorsed by the responsible authority {fmtDate(id.baseline.endorsement.endorsedAt)}{id.baseline.endorsement.endorsedBy ? ` (${id.baseline.endorsement.endorsedBy})` : ''}{:else}<strong>Not endorsed by the responsible authority</strong>{/if}
				</span>
			{/if}
		</dd>
	</div>
	{#if id.authority !== undefined}
		<div data-testid="evidence-for">
			<dt>For</dt>
			<dd>
				{#if id.authority}
					{id.authority.name}
					<span class="sub">{id.authority.kind === 'dws' ? 'Department of Water and Sanitation' : 'Catchment management agency'}{id.authority.office ? ` · ${id.authority.office}` : ''}</span>
				{:else}
					<span class="na">No responsible authority named</span>
				{/if}
			</dd>
		</div>
	{/if}
	{#if id.application}
		<div>
			<dt>Application</dt>
			<dd>
				{id.application.scenarioName}{id.application.scenarioStatus ? ` (${id.application.scenarioStatus})` : ''}
				<span class="sub">{id.application.proposals} proposal{id.application.proposals === 1 ? '' : 's'}, {id.application.assumptions} baseline assumption{id.application.assumptions === 1 ? '' : 's'}</span>
				<span class="sub">Run {fmtDate(id.application.createdAt)} by {id.application.createdBy ?? FORMER_MEMBER}</span>
			</dd>
		</div>
	{/if}
	<div>
		<dt>Engine</dt>
		<dd>
			{id.baseline.engineVersion}{id.application ? (id.application.engineVersion === id.baseline.engineVersion ? ' · both runs' : ` · application ${id.application.engineVersion}`) : ''}
			<span class="sub">Report built by engine {report.builtBy}</span>
		</dd>
	</div>
	<div>
		<dt>Signed</dt>
		<dd>
			{#if signoffs.length}{signoffs.map((s) => `${s.fullName} (${s.registrationBody.toUpperCase()} ${s.registrationNo})`).join('; ')}{:else}<span class="na">Not signed</span>{/if}
		</dd>
	</div>
	<div>
		<dt>Verify</dt>
		<dd>{#if verify}<span class="mono">{verify.code}</span><span class="sub">{verify.url}</span>{:else}<span class="na">Given when a pack is issued</span>{/if}</dd>
	</div>
</dl>

{#if report.assumptionsChanged}
	<div class="banner banner-red" role="note" data-testid="evidence-banner">
		<strong>Baseline assumptions changed.</strong>
		{report.identity.application?.assumptions} of the application’s changes move the shared baseline, not the applicant’s own works (Appendix A.2). This is a preview: it
		can’t be issued as evidence.
	</div>
{:else if app}
	<div class="banner" role="note" data-testid="evidence-banner">
		<strong>No baseline assumption changed.</strong>
		All {report.ops.length} change{report.ops.length === 1 ? ' is' : 's are'} the applicant’s own works (Appendix A.2).
	</div>
{/if}

<div class="flags-block">
	<p class="k" id="ev-flags-h">Read these first</p>
	<ul class="flags" aria-labelledby="ev-flags-h" data-testid="evidence-flags">
		{#each report.flags as f (f.id)}
			<li class={cls[f.level]}>{f.text}{#if f.effect}<span class="effect"> {f.effect}</span>{/if}</li>
		{/each}
	</ul>
</div>

<h3>{app ? 'What changes, application minus baseline' : 'The baseline’s results'}</h3>
<div class="table-wrap">
	<table class="data compact change" data-testid="evidence-change-table">
		<thead>
			<tr>
				<th scope="col">Measure</th>
				<th scope="col" class="num">Baseline</th>
				{#if app}
					<th scope="col" class="num">Application</th>
					<th scope="col" class="num">Change (R2)<span class="sub">median, 5–95 %</span></th>
					<th scope="col" class="num">Worse in</th>
				{/if}
			</tr>
		</thead>
		<tbody>
			{#each rows.shown as r, i (i)}
				{@const c = changeText(r, r.change)}
				<tr>
					<th scope="row">
						<strong>{r.label}</strong>{r.subject ? `, ${r.subject}` : ''}
						<span class="sub">{r.basis}</span>
						{#if r.note}<span class="sub">{r.note}</span>{/if}
					</th>
					{#if r.notAssessed}
						<td class="na wrap" colspan={app ? 4 : 1}>{r.notAssessed}</td>
					{:else}
						<td class="num">{valueText(r, r.baseline)}</td>
						{#if app}
							<td class="num">{valueText(r, r.application)}</td>
							<td class="num" class:na={!c.banded}>{c.main}{#if c.sub}<span class="sub">{c.sub}</span>{/if}</td>
							<td class="num" class:na={!r.change?.worse}>{worseText(r.change)}</td>
						{/if}
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>
</div>
{#if rows.more}<p class="small muted">{rows.more} more users’ supply changed: § 4 lists every one.</p>{/if}
<p class="small muted">{report.rules.footnote} “run:” is the nominated run’s own difference.</p>

{#if board}
	<div class="board-block" data-testid="evidence-impact-board">
		<LicenceImpactBoard view={board} />
		<p class="small muted">The two runs’ own numbers, no band: the ensemble doesn’t carry year classes.</p>
	</div>
{:else if boardNotFrozen}
	<p class="small muted" data-testid="evidence-impact-board-omitted">
		Licence impact by year class is not part of this pack: it was drafted before the evidence report froze the board (report format evidence-5). The
		workspace’s evidence report shows it for the runs, and a new version of the pack carries it.
	</p>
{/if}

<div class="two">
	{#if app}
		<div>
			<p class="k">Where the river loses most</p>
			{#if report.worstMonths.length}
				<p data-testid="evidence-worst-months">
					{#each report.worstMonths as m, i (m.month)}{i ? (i === report.worstMonths.length - 1 ? ' and ' : ', ') : ''}<strong>{monthName(m.month)}</strong>: {band(m)}{/each}
					more below the EWR (paired median, 5–95 %).
					{#if report.improvingMonths.length}
						{report.improvingMonths.map((m) => `${monthName(m.month)} ${band(m)}`).join(', ')} fewer.
					{/if}
				</p>
			{:else if report.byMonth}
				<p>No month has more days below the EWR at the paired median.</p>
			{:else}
				<p class="na">Not assessed: no paired band by month.</p>
			{/if}
			{#if outlet}
				<p class="small muted">
					Longest run of months not meeting the Reserve at {outlet.name}: {fmtNum(outlet.longestA)}{outlet.longestB !== null ? ` → ${fmtNum(outlet.longestB)}` : ''}.
					{#if outlet.worst}Worst month: {monthName(outlet.worst.month)} {outlet.worst.year}, {fmtNum(outlet.worst.delivered * 100)} % of the requirement delivered.{/if}
				</p>
			{/if}
		</div>
	{/if}
	<div>
		<p class="k">This report does not decide</p>
		<p class="small">
			The licence. Under s27 of the National Water Act the responsible authority weighs these numbers with factors the model doesn’t hold. Dam
			safety (DW793), groundwater beyond the modelled boreholes, water quality and socio-economic factors are for other reports.
		</p>
	</div>
</div>

<div class="rule-box" data-testid="evidence-rules">
	<p><strong>R1 · Uncertainty rule{report.uncertainty.cited ? ` (ensemble ${report.uncertainty.cited.id.slice(0, 8)}, seed ${report.uncertainty.cited.seed}, drawn by the database)` : ''}</strong></p>
	<p>{report.rules.r1 ?? 'No ensemble is cited: no band on this report.'}{#if report.uncertainty.baseline} Kept: {fmtNum(report.uncertainty.baseline.accepted)} of {fmtNum(report.uncertainty.baseline.total)}.{/if}</p>
	{#if app}
		<p><strong>R2 · Paired rule</strong></p>
		<p>{report.rules.r2 ?? 'No paired band on the cited ensemble: every change is the run’s own difference.'}</p>
	{/if}
</div>

<style>
	.idgrid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
		gap: 0.5rem 1rem;
		margin: 0 0 1rem;
	}
	dt,
	.k {
		font-size: 0.72rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-muted);
		margin: 0;
	}
	dd {
		margin: 0;
	}
	.sub {
		display: block;
		font-size: 0.78rem;
		font-weight: 400;
		color: var(--text-muted);
	}
	.na {
		font-style: italic;
		color: var(--text-muted);
	}
	.mono {
		font-family: var(--font-mono);
	}
	.banner {
		padding: 0.5rem 0.8rem;
		border: 1px solid var(--border-strong);
		border-left: 4px solid var(--text);
		border-radius: var(--radius-sm);
		margin: 0 0 0.9rem;
		max-width: 80ch;
	}
	.banner-red {
		border-color: var(--danger);
		background: var(--danger-soft);
		color: var(--text);
	}
	.flags-block {
		margin-bottom: 0.9rem;
	}
	.flags {
		list-style: none;
		padding: 0;
		margin: 0.3rem 0 0;
		display: grid;
		gap: 0.3rem;
	}
	.flags li {
		padding: 0.3rem 0.6rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border);
		max-width: 90ch;
	}
	.flag-red {
		border-color: var(--danger);
		background: var(--danger-soft);
		font-weight: 600;
	}
	.flag-caution {
		border-color: var(--warning);
		background: var(--warning-soft);
	}
	.effect {
		font-weight: 400;
		color: var(--text-muted);
	}
	/* A sentence in the value's place wraps, left-aligned (a nowrap numeric cell widened the table past a phone). */
	.wrap {
		white-space: normal;
		text-align: left;
	}
	.change th[scope='row'] {
		font-weight: 400;
		min-width: 14rem;
	}
	.board-block {
		margin: 1rem 0 0.75rem;
	}
	.two {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr));
		gap: 1rem;
		margin: 0.75rem 0;
	}
	.rule-box {
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.8rem;
		font-size: 0.85rem;
		max-width: 90ch;
	}
	.rule-box p {
		margin: 0.2rem 0;
	}
	@media print {
		.flags li,
		.banner {
			break-inside: avoid;
			print-color-adjust: exact;
			-webkit-print-color-adjust: exact;
		}
	}
</style>
