<!-- i18n-section: share.scenario -->
<script lang="ts">
	// A scenario link's page (WP-3.15, docs/ui.md § Share page): a submitted or
	// decided application, read-only, for someone outside the project. The
	// EWR per site comes first (the baseline beside the application), then
	// what it changes (a baseline assumption flagged), the catchment's totals
	// when the API sends them, and the comments posted for public
	// participation (./ShareComments.svelte: anyone signed in comments through
	// the link, with no role in the project, 166_public_participation). A
	// decided one adds where its licence stands, the terms it was granted on
	// and what followed the decision (appeals, 291). Every
	// word is in ./scenario.ts, ./ShareComments.svelte or t() here.
	import { resolve } from '$app/paths';
	import type { SharedTerms, ShareScenario } from '#lib/api/types.js';
	import { t } from '#lib/i18n/locale.svelte.js';
	import { changeRows, daysLine, eventHeading, ewrRows, licenceLine, resultsNote, statusLine, termsRows, volumeRows, withheldLine } from './scenario';
	import ShareComments from './ShareComments.svelte';
	import { shareCaveat } from './share';

	let { view, token }: { view: ShareScenario; token: string } = $props();

	const sc = $derived(view.scenario);
	const rows = $derived(view.base && view.run ? ewrRows(view.base, view.run) : []);
	const days = $derived(view.base && view.run ? daysLine(view.base, view.run) : '');
	const changes = $derived(changeRows(view.scenario));
	const volumes = $derived(view.base && view.run ? volumeRows(view.base, view.run) : []);
	const note = $derived(resultsNote(view.results));
	const withheld = $derived(withheldLine(sc.withheldOps));
	const standing = $derived(licenceLine(sc));
</script>

{#snippet terms(heading: string, tm: SharedTerms, testid: string)}
	<div class="terms" data-testid={testid}>
		<h3>{heading}</h3>
		{#if tm.asApplied}
			<p>{t('As applied for: the same changes as the application.')}</p>
		{:else}
			{@const rows = termsRows(tm, sc.ownedNodeIds)}
			{#if rows.length}
				<ul class="changes">
					{#each rows as c, i (i)}
						<li class={c.cls}>
							<span class="cls">{c.label}</span>
							<span class="what">{c.text}</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p>{t('No changes.')}</p>
			{/if}
		{/if}
		{#if withheldLine(tm.withheldOps)}<p class="fine">{withheldLine(tm.withheldOps)}</p>{/if}
		{#if tm.conditions}
			<p class="fine">{t('Conditions')}</p>
			<p class="desc">{tm.conditions}</p>
		{/if}
	</div>
{/snippet}

<div class="head">
	<h1>{sc.name}</h1>
	<p class="sub">{t('An application in {project}, shared read-only', { project: view.project.name })}</p>
	<p class="dates" data-testid="share-scenario-status">{statusLine(sc)}</p>
	<p class="caveat" data-testid="share-caveat">{shareCaveat()}</p>
</div>

<div class="cols">
	<div class="col">
		<section class="card" aria-labelledby="ewr-h" data-testid="share-scenario-ewr">
			<h2 id="ewr-h">{t('The river’s ecological reserve')}</h2>
			{#if note}
				<p role="status">{note}</p>
			{:else}
				<p class="sub">{t('Months the Reserve is met at each EWR site: the published baseline beside this application.')}</p>
				<ul class="ewr">
					{#each rows as r, i (i)}
						<li class="ewr-site {r.trend}">
							<p class="place">{r.place}</p>
							<dl>
								<dt>{t('Baseline')}</dt>
								<dd>{r.base}</dd>
								<dt>{t('With this application')}</dt>
								<dd>{r.withApp}</dd>
							</dl>
							<p class="change">{r.change}</p>
						</li>
					{:else}
						<li class="fine">{t('No EWR site has a Reserve rule table in this catchment.')}</li>
					{/each}
				</ul>
				{#if days}<p class="fine">{days}</p>{/if}
			{/if}
		</section>

		<section class="card" aria-labelledby="changes-h">
			<h2 id="changes-h">{t('What the application changes')}</h2>
			{#if changes.length}
				<ul class="changes">
					{#each changes as c, i (i)}
						<li class={c.cls}>
							<span class="cls">{c.label}</span>
							<span class="what">{c.text}</span>
						</li>
					{/each}
				</ul>
				{#if changes.some((c) => c.cls === 'baseline')}
					<p class="fine flag">{t('A baseline assumption changes the shared baseline itself, not only the applicant’s own proposal.')}</p>
				{/if}
			{:else}
				<p>{t('No changes.')}</p>
			{/if}
			{#if withheld}<p class="fine">{withheld}</p>{/if}
			{#if sc.description}<p class="desc">{sc.description}</p>{/if}
		</section>
	</div>

	<div class="col">
		{#if sc.status === 'decided' && (sc.decisionNote || standing || sc.grantedTerms || sc.decisionEvents.length)}
			<section class="card" aria-labelledby="decision-h" data-testid="share-scenario-decision">
				<h2 id="decision-h">{t('The decision')}</h2>
				{#if standing}<p class="standing" data-testid="share-scenario-licence">{standing}</p>{/if}
				{#if sc.decisionNote}<p class="desc">{sc.decisionNote}</p>{/if}
				{#if sc.grantedTerms}
					{@render terms(t('The terms granted'), sc.grantedTerms, 'share-scenario-granted')}
				{/if}
				{#if sc.decisionEvents.length}
					<h3>{t('After the decision')}</h3>
					<ol class="events" data-testid="share-scenario-events">
						{#each sc.decisionEvents as e (e.position)}
							<li>
								<p class="place">{eventHeading(e)}</p>
								{#if e.reference}<p class="fine">{t('Reference: {reference}', { reference: e.reference })}</p>{/if}
								{#if e.note}<p class="desc">{e.note}</p>{/if}
								{#if e.terms}
									{@render terms(t('The terms it was varied to'), e.terms, 'share-scenario-varied')}
								{/if}
							</li>
						{/each}
					</ol>
				{/if}
			</section>
		{/if}

		{#if volumes.length}
			<section class="card" aria-labelledby="totals-h">
				<h2 id="totals-h">{t('The catchment’s totals')}</h2>
				<div class="table-scroll">
					<table class="numbers">
						<thead>
							<tr><th scope="col"><span class="visually-hidden">{t('Figure')}</span></th><th scope="col">{t('Baseline')}</th><th scope="col">{t('With this application')}</th></tr>
						</thead>
						<tbody>
							{#each volumes as v (v.label)}
								<tr><th scope="row">{v.label}</th><td>{v.base}</td><td>{v.withApp}</td></tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}

		<ShareComments {token} kind="scenario" initial={view.comments} objection={view.objection} />

		<section class="card" aria-labelledby="about-sc-h">
			<h2 id="about-sc-h">{t('About this page')}</h2>
			<p>{t('An application to use water in this catchment, modelled on its published baseline. It is read-only, and it names no other hydrological unit.')}</p>
			<p class="fine">{t('This link works until it expires or is withdrawn, while the application is submitted or decided.')}</p>
			<p class="fine">{t('It is not a water-use authorisation, licence, allocation or restriction under the National Water Act: only the responsible authority and the Water User Association’s own notices decide those. Don’t rely on it alone for a decision.')}</p>
			<p class="fine legal-links"><a href={resolve('terms')}>{t('Terms of use')}</a> · <a href={resolve('privacy')}>{t('Privacy notice')}</a></p>
		</section>
	</div>
</div>

<style>
	.cols,
	.col {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	@container share (min-width: 860px) {
		.cols {
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			align-items: start;
		}
	}
	.ewr,
	.changes {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 10px;
	}
	.ewr-site {
		border-left: 4px solid var(--border-strong);
		padding: 4px 0 4px 10px;
	}
	.ewr-site.worse {
		border-left-color: var(--danger);
	}
	.ewr-site.better {
		border-left-color: var(--success);
	}
	.place {
		font-weight: 600;
		margin: 0;
	}
	dl {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: 2px 10px;
		margin: 4px 0;
	}
	dt {
		color: var(--text-2);
	}
	dd {
		margin: 0;
	}
	.change {
		margin: 0;
		font-weight: 500;
	}
	.worse .change {
		color: var(--danger);
	}
	.changes li {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 8px;
		align-items: baseline;
	}
	.cls {
		font-size: 13px;
		font-weight: 600;
		padding: 0 6px;
		border-radius: 999px;
		border: 1px solid var(--border);
	}
	.baseline .cls {
		color: var(--danger);
		border-color: var(--danger);
	}
	.what {
		overflow-wrap: anywhere;
	}
	h3 {
		font-size: 15px;
		margin: 12px 0 6px;
	}
	.standing {
		font-weight: 600;
	}
	.events {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 10px;
	}
	.events > li {
		border-left: 4px solid var(--border-strong);
		padding: 4px 0 4px 10px;
	}
	.flag {
		color: var(--danger);
	}
	.desc,
	.body {
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
	.table-scroll {
		overflow-x: auto;
	}
</style>
