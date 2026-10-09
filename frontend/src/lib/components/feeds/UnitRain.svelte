<!--
	Settings → Data feeds → "Rain for each unit" (issue #482; docs/ui.md § Data
	feeds, docs/maps.md § Rain for each unit): for every land unit with a parcel
	on the map, the CHIRPS cells it covers, and one CHIRPS feed into that unit's
	own rain series, created or updated on the button (owners: feeds are theirs
	to set up; editors see the proposal). Each unit's row shows its feed's state
	from the feeds list. Units without a parcel, and units the server can't set
	up, are listed with what to do. Choosing the other product asks the server
	again, since it decides what that would change. Opens by itself on
	?rain=units. Helpers in ./unitRain.ts.
-->
<script lang="ts">
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { page } from '$app/state';
	import { tick } from 'svelte';
	import { foldList } from '$lib/components/common/fold';
	import { api } from '$lib/api';
	import type { UnitRainProduct, UnitRainProposal } from '$lib/api/types';
	import { fmtNum } from '$lib/format/number';
	import { CHIRPS_PRODUCT_FIRST_DAY, errorText, feedsApi, type FeedMeta } from './feeds';
	import { appliedWords, sortUnitRows, UNIT_RAIN_DEFAULT_PRODUCT, unitRainAction, unitRainBody, unitRainRows, unitRainUpToDate } from './unitRain';

	let { projectId, feeds, onapplied }: { projectId: string; feeds: FeedMeta[]; onapplied: () => Promise<void> | void } = $props();

	const uid = $props.id();
	const calls = $derived(feedsApi(api, projectId));

	let open = $state(false);
	let loading = $state(false);
	/** Asking again for the other product: the proposal stays shown (and the select keeps focus) until the answer lands. */
	let reloading = $state(false);
	let applying = $state(false);
	let proposal = $state<UnitRainProposal | null>(null);
	let product = $state<UnitRainProduct>(UNIT_RAIN_DEFAULT_PRODUCT);
	let startDate = $state('');
	let error = $state<string | null>(null);
	let startError = $state<string | null>(null);
	let done = $state<string | null>(null);
	let heading = $state<HTMLElement>();
	let opener = $state<HTMLButtonElement>();

	// The units that need something first (no feed, failing, stale), the rest folded behind "Show all N units".
	const rows = $derived(proposal ? sortUnitRows(unitRainRows(proposal, feeds)) : []);
	const FOLD = 8;
	let allRows = $state(false);
	const fold = $derived(foldList(rows, (r) => r.nodeId, null, allRows, FOLD));
	const action = $derived(proposal ? unitRainAction(proposal) : null);
	const upToDate = $derived(proposal ? unitRainUpToDate(proposal) : false);
	/** Owners set the feeds up (the server says, canApply); editors read the proposal. */
	const canApply = $derived(proposal?.canApply ?? false);

	// Only the newest proposal may land: a product switched twice quickly must not show the first answer.
	let seq = 0;
	/** Read the proposal; `asked`: as POST would set the units up with that product (else the server's choice, which the select then shows). */
	async function load(asked?: UnitRainProduct) {
		const mine = ++seq;
		const next = await calls.unitsProposal(asked);
		if (mine !== seq) return;
		proposal = next;
		product = next.product;
	}

	async function pickProduct(next: UnitRainProduct) {
		product = next;
		startError = error = done = null;
		reloading = true;
		try {
			await load(next);
		} catch (e) {
			error = errorText(e);
		}
		reloading = false;
	}

	async function show() {
		open = true;
		loading = true;
		error = done = startError = null;
		proposal = null;
		try {
			await load();
		} catch (e) {
			error = errorText(e);
		}
		loading = false;
		await tick();
		heading?.focus();
	}

	async function close() {
		open = false;
		await tick();
		opener?.focus();
	}

	async function apply() {
		if (!proposal || applying || reloading) return;
		const parsed = unitRainBody(product, startDate);
		if ('error' in parsed) {
			startError = parsed.error;
			await tick();
			document.getElementById(`${uid}-start`)?.focus();
			return;
		}
		applying = true;
		error = startError = done = null;
		let r;
		try {
			r = await calls.applyUnits(parsed.body);
		} catch (e) {
			error = errorText(e);
			applying = false;
			return;
		}
		done = appliedWords(r);
		// The feeds are set up; a failed refresh after it says so, not that the setup failed.
		try {
			await onapplied();
			await load(product);
		} catch (e) {
			error = `The feeds are set up, but the panel couldn’t refresh: ${errorText(e)} Close it and open it again.`;
		}
		applying = false;
		// The button goes once nothing is left to change: keep the focus in the panel, on its heading.
		await tick();
		if (!document.getElementById(`${uid}-apply`)) heading?.focus();
	}

	// ?rain=units (Settings' Rain for each unit links here) opens the proposal, also when the link is followed on this page.
	const asked = $derived(page.url.searchParams.get('rain') === 'units');
	// Once per arrival: closing it while the URL still asks must not open it again.
	let answered = false;
	$effect(() => {
		if (!asked) answered = false;
		else if (!answered) {
			answered = true;
			void show();
		}
	});
</script>

{#if !open}
	<button type="button" class="btn btn-sm" bind:this={opener} onclick={show} data-testid="unit-rain-open">Rain for each unit</button>
{:else}
	<section class="unit-rain" aria-labelledby="{uid}-h" aria-busy={reloading || undefined} data-testid="unit-rain">
		<h3 id="{uid}-h" tabindex="-1" bind:this={heading}>Rain for each unit <HelpTip key="unit-rain-feeds" /></h3>
		<p class="hint">
			One CHIRPS feed for each hydrological unit with land, averaging the 0.05° cells its parcel on the map covers, each weighted by the share of it
			inside. Runs use these series when Settings → Flow generation → Rain for each unit is on. Source: CHIRPS v3 daily, Climate Hazards Center, UC
			Santa Barbara.
		</p>
		{#if loading}
			<p class="muted" role="status">Working out the cells…</p>
		{:else if proposal}
			{@const p = proposal}
			{#if rows.length}
				<!-- The wrap takes focus so the keyboard can scroll it (axe scrollable-region-focusable). -->
				<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
				<div class="table-wrap" tabindex="0" role="region" aria-label="Units and their feeds">
					<table class="data compact units" aria-labelledby="{uid}-cap" data-testid="unit-rain-units">
						<caption id="{uid}-cap">Each unit’s CHIRPS cells and feed</caption>
						<thead>
							<tr><th scope="col">Unit</th><th scope="col" class="num">Area <span class="u">(km²)</span></th><th scope="col">Cells</th><th scope="col">Feed</th></tr>
						</thead>
						<tbody>
							{#each fold.shown as r (r.nodeId)}
								<tr data-testid="unit-rain-row">
									<th scope="row">{r.name}</th>
									<td class="num">{fmtNum(r.areaKm2, 2)}</td>
									<td>{r.cellsText}</td>
									<td>
										{#if r.feed}
											<span class="state state-{r.feed.state}">{r.feed.label}</span>
											<span class="small">{r.feed.health}{#if r.seriesDays}{' '}{fmtNum(r.seriesDays)} days so far.{/if}</span>
										{:else}
											<span class="muted">No feed yet</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if allRows || fold.hidden}
					<button type="button" class="btn btn-sm" aria-expanded={allRows} onclick={() => (allRows = !allRows)}>
						{allRows ? `Show only the first ${FOLD} units` : `Show all ${rows.length} units`}
					</button>
				{/if}
				<details>
					<summary>The cells</summary>
					<!-- The wrap takes focus so the keyboard can scroll it (axe scrollable-region-focusable). -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div class="table-wrap" tabindex="0" role="region" aria-label="The cells by unit">
						<table class="data compact cells" aria-label="Each unit’s CHIRPS cells">
							<thead><tr><th scope="col">Unit</th><th scope="col" class="num">Latitude</th><th scope="col" class="num">Longitude</th><th scope="col" class="num">Inside</th><th scope="col" class="num">Weight</th></tr></thead>
							<tbody>
								{#each p.units as u (u.nodeId)}
									{#each u.cells as c (`${c.lat},${c.lon}`)}
										<tr><th scope="row">{u.name}</th><td class="num">{c.lat.toFixed(3)}</td><td class="num">{c.lon.toFixed(3)}</td><td class="num">{fmtNum(c.share * 100, c.share < 0.1 ? 1 : 0)} %</td><td class="num">{fmtNum(c.weight, 3)}</td></tr>
									{/each}
								{/each}
							</tbody>
						</table>
					</div>
				</details>
			{:else}
				<p class="muted" data-testid="unit-rain-none">No unit has a parcel on the map yet, so there is nothing to propose.</p>
			{/if}
			{#if p.withoutPolygon.length}
				<p data-testid="unit-rain-without">
					Without a parcel on the map ({p.withoutPolygon.length === 1 ? '1 unit' : `${fmtNum(p.withoutPolygon.length)} units`}): {p.withoutPolygon.map((u) => u.name).join(', ')}.
					Draw or delineate each one’s parcel and link it to the unit. <a href="?tab=map">Open the map</a>
				</p>
			{/if}
			{#if p.refused.length}
				<div class="alert alert-warning" data-testid="unit-rain-refused">
					<p>These units can’t be set up:</p>
					<ul>
						{#each p.refused as u (u.nodeId)}<li><strong>{u.name}</strong>: {u.reason}</li>{/each}
					</ul>
				</div>
			{/if}
			{#if canApply && (p.units.length || p.refused.length)}
				<div class="form-row">
					<div class="field">
						<label for="{uid}-product">Daily product <HelpTip key="chirps-version" label="About which CHIRPS a series holds" /></label>
						<select id="{uid}-product" value={product} disabled={applying} onchange={(e) => pickProduct(e.currentTarget.value as UnitRainProduct)} aria-describedby="{uid}-product-h">
							<option value="rnl">rnl: from 1981, final days only</option>
							<option value="sat">sat: from 1998, with preliminary days</option>
						</select>
					</div>
					<div class="field">
						<label for="{uid}-start">Start date <span class="muted">(optional)</span></label>
						<input
							id="{uid}-start"
							type="date"
							min={CHIRPS_PRODUCT_FIRST_DAY[product]}
							bind:value={startDate}
							oninput={() => (startError = null)}
							aria-invalid={startError ? true : undefined}
							aria-describedby="{uid}-product-h{startError ? ` ${uid}-start-err` : ''}"
						/>
					</div>
				</div>
				<p class="hint" id="{uid}-product-h">
					Every unit reads the same product, end to end; a feed whose series already holds days keeps its own. Without a start date the feeds read from
					the product’s first day ({CHIRPS_PRODUCT_FIRST_DAY[product]}), so the MAP period has its years.
				</p>
				{#if startError}<p class="err" id="{uid}-start-err" role="alert">{startError}</p>{/if}
			{/if}
			{#if action}
				<p data-testid="unit-rain-words">{action.words}</p>
			{:else if upToDate}
				<p class="muted" data-testid="unit-rain-words">Every unit’s feed already reads its parcel with this product: nothing to change.</p>
			{/if}
			<div class="action-row">
				{#if action && canApply}
					<button type="button" id="{uid}-apply" class="btn btn-primary" aria-disabled={applying || reloading} onclick={apply} data-testid="unit-rain-apply">{applying ? 'Working…' : action.label}</button>
				{:else if action}
					<p class="muted small">An owner of the project creates the feeds.</p>
				{/if}
				<button type="button" class="btn" onclick={close}>Close</button>
			</div>
		{:else}
			<div class="action-row"><button type="button" class="btn" onclick={close}>Close</button></div>
		{/if}
		<div role="status">{#if done}<p class="muted" data-testid="unit-rain-done">{done}</p>{/if}</div>
		{#if error}<p class="alert alert-error" role="alert">{error}</p>{/if}
	</section>
{/if}

<style>
	/* A disclosure's summary is a full touch target (WCAG 2.5.8; a phone gets --tap). */
	details > summary {
		padding: 0.45rem 0;
		min-height: 36px;
		box-sizing: border-box;
		cursor: pointer;
	}
	@media (pointer: coarse), (max-width: 640px) {
		details > summary {
			min-height: var(--tap);
		}
	}
	.unit-rain {
		margin-top: 0.75rem;
		border-top: 1px solid var(--border);
		padding-top: 0.75rem;
	}
	.unit-rain h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	p {
		max-width: 75ch;
	}
	.hint {
		font-size: 0.8rem;
	}
	.table-wrap {
		overflow-x: auto;
	}
	.units,
	.cells {
		font-variant-numeric: tabular-nums;
		font-size: 0.85rem;
	}
	.units td {
		vertical-align: top;
	}
	.state {
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.05rem 0.45rem;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--surface-2);
		color: var(--text-2);
		margin-right: 0.3rem;
		white-space: nowrap;
	}
	.state-ok {
		background: var(--accent-soft);
		color: var(--accent);
		border-color: transparent;
	}
	.state-stale {
		background: var(--warning-soft);
		color: var(--warning);
		border-color: transparent;
	}
	.state-failing {
		background: var(--danger-soft);
		color: var(--danger);
		border-color: transparent;
	}
	.alert ul {
		margin: 0.2rem 0 0;
		padding-left: 1.2rem;
	}
	.alert p {
		margin: 0;
	}
	.err {
		color: var(--danger);
		font-size: 0.85rem;
	}
	.btn[aria-disabled='true'] {
		opacity: 0.55;
		cursor: not-allowed;
	}
</style>
