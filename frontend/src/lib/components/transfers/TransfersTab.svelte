<script lang="ts">
	// Transfers (issue #17, option A): the rules, one card per rule, on a page that
	// scrolls as a whole. On the page (`page`) the section header carries the
	// title, the count (workspace/context.ts), Show on the Network and + Add
	// transfer. The grid modal (`grid=transfers`) and scenario override mode show
	// the same cards, with Add transfer under them.
	//
	// Each card: a head line (the rule's number, From → To, an Enabled switch and
	// Remove), then its fields in three top-aligned groups: the max rate by month,
	// the limits (daily cap, priority) and the source (takes from, and the dam's
	// minimum or a river off-take's fields). The groups sit side by side where the
	// card is wide and stack where it isn't (container queries on the card). Where
	// the card is widest the head line becomes a column on the card's left (From
	// over To, the switch and Remove under them), level with the rates, so a rule
	// is about as tall as its month fields rather than a head line taller.
	//
	// A rule with a problem (lib/model/validate.ts, by its id) has a danger edge
	// and its problems in words under its head line; the save bar links each
	// problem to the rule's heading (`#tr-<id>-h`), which the page focuses on
	// landing (a fragment into a lazy tab needs the tab to land it).
	//
	// Every field's accessible name starts with its visible label, then the
	// rule ("From, transfer 3"), so speech input can say what it sees (WCAG
	// 2.5.3).
	import FlowUnitSelect from '$lib/components/network/FlowUnitSelect.svelte';
	import { transferUnit } from '$lib/components/network/flowUnit.svelte';
	import { onDestroy, tick } from 'svelte';
	import { page as appPage } from '$app/state';
	import { hashId, holdAnchor } from '$lib/help/anchor';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import HelpTip from '$lib/components/help/HelpTip.svelte';
	import { fillHeader } from '$lib/components/workspace/headerSlot.svelte';
	import { transferIsBlank, type ModelEditor } from '$lib/model/editor.svelte';
	import { transferAnchor } from '$lib/model/validate';
	import MonthRates from './MonthRates.svelte';
	import type { Transfer, TransferSizing, TransferSource } from '@water-management/engine';

	let {
		editor,
		readonly,
		page = false,
		inModal = false
	}: {
		editor: ModelEditor;
		readonly: boolean;
		/** The workspace page (not a modal or override mode). */
		page?: boolean;
		/** In the grid modal, whose title names it: no heading of its own (one heading per modal). */
		inModal?: boolean;
	} = $props();

	const nodes = $derived(editor.model.nodes);
	const transfers = $derived(editor.model.transfers);
	const name = (id: string) => nodes.find((n) => n.id === id)?.name || '(unnamed)';
	// A transfer runs between hydrological units' dams (or a unit's river): a gauge or an other water user can't take part.
	const units = $derived(nodes.filter((n) => n.kind === 'farm'));
	const canAdd = $derived(!readonly && units.length >= 2);
	/** Each rule's problems, by its id, without the "Transfer N: " the card's heading already says. */
	const problemsOf = $derived.by(() => {
		const out = new Map<string, string[]>();
		for (const i of editor.issues) {
			if (i.area !== 'transfers' || !i.itemId) continue;
			const m = i.message.replace(/^Transfer \d+: /, '');
			out.set(i.itemId, [...(out.get(i.itemId) ?? []), m.charAt(0).toUpperCase() + m.slice(1)]);
		}
		return out;
	});
	/**
	 * Where a river off-take's canal seepage can rejoin the river (engine ≥ 1.42.0): below its source, or
	 * below a farm downstream of it along the river (the engine's offtakeReturnAt), nearest first.
	 */
	function rejoinUnits(fromId: string): { id: string; name: string }[] {
		const out: { id: string; name: string }[] = [];
		const seen = new Set<string>([fromId]);
		for (let id = nodes.find((n) => n.id === fromId)?.downstreamNodeId; id && !seen.has(id); ) {
			seen.add(id);
			const n = nodes.find((x) => x.id === id);
			if (!n) break;
			if (n.kind === 'farm') out.push({ id: n.id, name: n.name || '(unnamed)' });
			id = n.downstreamNodeId;
		}
		return out;
	}

	let root: HTMLDivElement | undefined = $state();
	/** Adds a rule after the others and puts the cursor in its From, scrolled into view. */
	async function add() {
		const t = editor.addTransfer();
		await tick();
		root?.querySelector<HTMLSelectElement>(`[data-id="${t.id}"] select`)?.focus();
	}

	/**
	 * Removes a rule. One with anything set (a rate in any month, a limit, an off-take's fields; not
	 * just its ends) asks first, as everything typed into it goes with it; a blank one goes at once.
	 * Focus moves to the next rule's heading (the previous one's for the last), or the empty card's
	 * Add transfer.
	 */
	async function remove(t: Transfer, n: number) {
		const route = `${name(t.fromNodeId)} → ${name(t.toNodeId)}`;
		if (
			!transferIsBlank(t) &&
			!(await confirmDialog({
				title: `Remove transfer ${n}?`,
				message: `${route}: its monthly rates, limits and source settings go with it.`,
				confirmLabel: 'Remove transfer',
				danger: true
			}))
		)
			return;
		const i = transfers.findIndex((x) => x.id === t.id);
		editor.removeTransfer(t.id);
		await tick();
		const heads = root?.querySelectorAll<HTMLElement>('.rule-title');
		const next = heads?.[Math.min(i, heads.length - 1)];
		if (next) next.focus();
		else root?.querySelector<HTMLButtonElement>('.empty button')?.focus();
	}

	$effect(() => fillHeader({ actions: headerActions }, page));

	// A link to one rule (the save bar's problems, `#tr-<id>-h`): its heading is focused and held in view
	// while the page settles, on landing and on a jump within the page.
	// Once per fragment: another navigation that keeps it (a sheet's parameter) doesn't take the focus back.
	let release = () => {};
	let landed = '';
	$effect(() => {
		if (!page) return;
		const id = hashId(appPage.url.hash);
		if (id === landed) return;
		landed = id;
		if (!id.startsWith('tr-')) return;
		const heading = root?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
		if (!heading) {
			landed = '';
			return;
		}
		release();
		release = holdAnchor(heading);
		heading.focus({ preventScroll: true });
	});
	onDestroy(() => release());
</script>

{#snippet headerActions()}
	{#if transfers.length && nodes.length >= 2}<a class="btn" href="?tab=network">Show on the Network</a>{/if}
	{#if canAdd}<button type="button" class="btn" onclick={add}>+ Add transfer</button>{/if}
{/snippet}

<div class="transfers" bind:this={root} data-testid="transfers">
	{#if units.length < 2 && transfers.length === 0}
		<section class="panel" aria-label="Transfer rules">
			<p class="muted">
				{#if readonly}
					This catchment has fewer than two hydrological units, so it has no transfers.
				{:else}
					Transfers need at least two hydrological units in the network. Add them on the <a href="?tab=network">Network tab</a>.
				{/if}
			</p>
		</section>
	{:else if transfers.length === 0}
		<section class="panel" aria-label="Transfer rules">
			<div class="empty">
				<p>No transfer rules.</p>
				<p class="small">
					A transfer moves water from one hydrological unit’s dam to another, at a maximum rate you set for each month, such as a
					pipeline pumping from a river dam to a hydrological unit’s dam in summer. A river off-take takes from the river instead, like a
					canal fed from a weir. Most catchments have none.
				</p>
				{#if !readonly}<button type="button" class="btn btn-primary" onclick={add}>Add transfer</button>{/if}
			</div>
		</section>
	{:else}
		<section class="rules-card" aria-labelledby={inModal ? undefined : 'tr-h'}>
			<div class="rules-head">
				{#if !inModal}<h2 id="tr-h">Transfer rules</h2>{/if}
				<span class="muted small">Water moved from one hydrological unit’s dam, or from the river there, to another hydrological unit, up to each month’s rate. Lower priorities move first.</span>
				<!-- One unit for every rule's rates (display only, so a viewer has it too); each rule's title names it. -->
				<span class="rate-unit"><span aria-hidden="true">Rates in</span> <FlowUnitSelect unit={transferUnit} label="Unit of transfer rates" /></span>
			</div>
			<ol class="rule-list" data-testid="transfer-rules">
				{#each transfers as t, i (t.id)}
					{@const label = `transfer ${i + 1}`}
					{@const river = (t.source ?? 'dam') === 'river'}
					{@const problems = problemsOf.get(t.id) ?? []}
					<li
						class="rule"
						class:off={!t.enabled}
						class:bad={problems.length > 0}
						data-id={t.id}
						data-testid="transfer-rule"
						aria-labelledby={transferAnchor(t.id)}
						aria-describedby={problems.length ? `tr-${t.id}-problems` : undefined}
					>
						{#if problems.length}
							<ul class="rule-problems" id="tr-{t.id}-problems">
								{#each problems as p, j (j)}<li>{p}</li>{/each}
							</ul>
						{/if}
						<div class="rule-in" class:river>
						<div class="rule-head">
							<div class="title">
								<h3 class="rule-title" id={transferAnchor(t.id)} tabindex="-1">
									Transfer {i + 1}{#if !t.enabled}{' '}<span class="off-tag">off</span>{/if}
								</h3>
							</div>
							<div class="route">
								{#each [['From', 'fromNodeId'], ['To', 'toNodeId']] as const as [word, key], k (key)}
									{#if k}<span class="arrow" aria-hidden="true">→</span>{/if}
									<label class="end">
										<span class="end-l" aria-hidden="true">{word}</span>
										<!-- Hydrological units only; a saved end that isn't one stays, named so, until it is changed. -->
										<select aria-label="{word}, {label}" disabled={readonly} aria-invalid={problems.length && !units.some((n) => n.id === t[key]) ? 'true' : undefined} bind:value={t[key]}>
											{#if !nodes.some((n) => n.id === t[key])}<option value={t[key]}>— choose —</option>
											{:else if !units.some((n) => n.id === t[key])}<option value={t[key]}>{name(t[key])} (not a hydrological unit)</option>{/if}
											{#each units as n (n.id)}<option value={n.id}>{n.name || '(unnamed)'}</option>{/each}
										</select>
									</label>
								{/each}
								<HelpTip key="transfer.fromNodeId" />
							</div>
							<div class="rule-acts">
								<!-- A switch with its word beside it, "Enabled", which its name starts with; the off state is said in words in the rule's heading. -->
								<label class="switch">
									<input type="checkbox" role="switch" aria-label="Enabled, {label}" disabled={readonly} bind:checked={t.enabled} />
									<span class="track" aria-hidden="true"></span>
									<span class="state" aria-hidden="true">Enabled</span>
								</label>
								{#if !readonly}
									<button type="button" class="btn btn-sm btn-ghost btn-danger remove" aria-label="Remove {label} ({name(t.fromNodeId)} → {name(t.toNodeId)})" onclick={() => remove(t, i + 1)}>Remove</button>
								{/if}
							</div>
						</div>

						<div class="rule-body">
							<div class="grp g-rates">
								<MonthRates rule={t} {label} disabled={readonly}>
									{#snippet title()}<div class="grp-t"><span>Max rate by month</span> <span class="u">{transferUnit.label}</span> <HelpTip key="transfer.monthlyRateM3s" /></div>{/snippet}
								</MonthRates>
							</div>

							<div class="grp g-limits">
								<div class="grp-t">Limits</div>
								<div class="fields">
									<div class="fld">
										<span class="fld-l"><span aria-hidden="true">Daily cap, m³</span> <HelpTip key="transfer.dailyCapM3" /></span>
										<NumberInput label="Daily cap of {label}, m³" min={0} nullable grouped placeholder="none" disabled={readonly} bind:value={t.dailyCapM3} />
									</div>
									<div class="fld">
										<span class="fld-l"><span aria-hidden="true">Priority, lower first</span> <HelpTip key="transfer.priority" /></span>
										<NumberInput label="Priority of {label} (lower moves first)" step={1} disabled={readonly} bind:value={t.priority} />
									</div>
								</div>
							</div>

							<div class="grp g-source">
								<div class="grp-t">Source</div>
								<div class="fields" class:river>
									<div class="fld sel">
										<span class="fld-l"><span aria-hidden="true">Takes from</span> <HelpTip key="transfer.source" /></span>
										<!-- The source's dam (§2.6) or the river leaving the source unit today: a river off-take (engine ≥ 1.14.0, §2.6a). -->
										<select aria-label="Takes from, {label}" disabled={readonly} value={t.source ?? 'dam'} onchange={(e) => (t.source = e.currentTarget.value as TransferSource)}>
											<option value="dam">The source’s dam</option>
											<option value="river">The river (an off-take)</option>
										</select>
									</div>
									{#if river}
										<div class="fld sel">
											<span class="fld-l"><span aria-hidden="true">Takes</span> <HelpTip key="transfer.sizing" /></span>
											<select aria-label="Takes, {label}" disabled={readonly} value={t.sizing ?? 'demand'} onchange={(e) => (t.sizing = e.currentTarget.value as TransferSizing)}>
												<option value="demand">What the destination needs</option>
												<option value="capacity">Up to capacity</option>
											</select>
										</div>
										<div class="fld">
											<span class="fld-l"><span aria-hidden="true">Hands-off flow, m³/day</span> <HelpTip key="transfer.handsOffM3Day" /></span>
											<NumberInput label="Hands-off flow for {label}, m³/day" min={0} nullable grouped placeholder="none" disabled={readonly} value={t.handsOffM3Day ?? null} onchange={(v) => (t.handsOffM3Day = v)} />
										</div>
										<div class="fld">
											<span class="fld-l"><span aria-hidden="true">Losses on the way, %</span> <HelpTip key="transfer.lossPct" /></span>
											<NumberInput label="Losses on the way of {label}, %" min={0} max={99.9} scale={100} disabled={readonly} value={t.lossPct ?? 0} onchange={(v) => (t.lossPct = v ?? 0)} />
										</div>
										<!-- Canal seepage back to the river (engine ≥ 1.42.0, §2.6a): a share of the losses, and where it rejoins. -->
										<div class="fld">
											<span class="fld-l"><span aria-hidden="true">Losses seeping back, %</span> <HelpTip key="transfer.lossReturnPct" /></span>
											<NumberInput label="Losses seeping back of {label}, %" min={0} max={100} scale={100} disabled={readonly} value={t.lossReturnPct ?? 0} onchange={(v) => (t.lossReturnPct = v ?? 0)} />
										</div>
										{#if (t.lossReturnPct ?? 0) > 0}
											{@const below = rejoinUnits(t.fromNodeId)}
											<div class="fld sel">
												<span class="fld-l"><span aria-hidden="true">Rejoins the river below</span> <HelpTip key="transfer.lossReturnNodeId" /></span>
												<select aria-label="Rejoins the river below, {label}" disabled={readonly} value={t.lossReturnNodeId ?? ''} onchange={(e) => (t.lossReturnNodeId = e.currentTarget.value || null)}>
													<option value="">The source ({name(t.fromNodeId)})</option>
													{#each below as b (b.id)}<option value={b.id}>{b.name}</option>{/each}
													{#if t.lossReturnNodeId && !below.some((b) => b.id === t.lossReturnNodeId)}<option value={t.lossReturnNodeId}>{name(t.lossReturnNodeId)} (not below the source)</option>{/if}
												</select>
											</div>
										{/if}
										<div class="checks">
											<span class="check-row">
												<label class="check">
													<input type="checkbox" aria-label="Leaves the EWR in the river, {label}" disabled={readonly} checked={!!t.handsOffEwr} onchange={(e) => (t.handsOffEwr = e.currentTarget.checked)} />
													<span aria-hidden="true">Leaves the EWR in the river</span>
												</label>
												<HelpTip key="transfer.handsOffEwr" />
											</span>
											<span class="check-row">
												<label class="check">
													<input type="checkbox" aria-label="Tops up the destination’s dam, {label}" disabled={readonly} checked={!!t.topUpDam} onchange={(e) => (t.topUpDam = e.currentTarget.checked)} />
													<span aria-hidden="true">Tops up the destination’s dam</span>
												</label>
												<HelpTip key="transfer.topUpDam" />
											</span>
										</div>
									{:else}
										<div class="fld">
											<span class="fld-l"><span aria-hidden="true">Min source storage, %</span> <HelpTip key="transfer.minStoragePct" /></span>
											<NumberInput label="Min source storage of {label}, %" min={0} max={100} scale={100} disabled={readonly} bind:value={t.minStoragePct} />
										</div>
									{/if}
								</div>
							</div>
						</div>
						</div>
					</li>
				{/each}
			</ol>
			{#if !page && !readonly}<div class="toolbar after"><button type="button" class="btn" onclick={add}>+ Add transfer</button></div>{/if}
		</section>
	{/if}
</div>

<style>
	.transfers {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.transfers > .panel {
		margin: 0;
	}
	.rules-head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 1rem;
		margin-bottom: 0.6rem;
	}
	.rules-head h2 {
		margin: 0;
	}
	.rate-unit {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.8rem;
		color: var(--text-2);
		white-space: nowrap;
	}
	.rules-head .small {
		font-size: 0.8rem;
		overflow-wrap: anywhere;
	}

	/* The page scrolls, once: the list grows with its rules, never a scroll box of its own. */
	.rule-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.rule {
		container: rule / inline-size;
		background: var(--surface);
		border: 1px solid var(--border);
		/* An on rule's edge in the accent; an off rule's neutral, with the card tinted and "off" in words. */
		border-left: 3px solid var(--accent);
		border-radius: var(--radius);
		box-shadow: var(--shadow);
		min-width: 0;
	}
	.rule.off {
		background: var(--surface-2);
		border-left-color: var(--border-strong);
		box-shadow: none;
	}
	/* A rule with a problem: a danger edge, whether on or off, and its problems in words under the head line. */
	.rule.bad {
		border-left-color: var(--danger);
	}
	.rule-problems {
		margin: 0;
		padding: 0.4rem 0.9rem;
		list-style: none;
		font-size: 0.85rem;
		color: var(--danger);
		border-bottom: 1px solid var(--border);
	}

	/* ---- The head line: number, route, switch, remove ---- */
	.rule-head {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		grid-template-areas: 'title route acts';
		align-items: center;
		gap: 0.5rem 1rem;
		padding: 0.45rem 0.75rem 0.45rem 0.9rem;
		border-bottom: 1px solid var(--border);
	}
	.title {
		grid-area: title;
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}
	.rule-title {
		margin: 0;
		font-size: 0.95rem;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	.rule-title:focus {
		outline: none;
	}
	.rule-title:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.off-tag {
		margin-left: 0.35rem;
		padding: 0.05rem 0.4rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-2);
		vertical-align: 0.1em;
	}
	.route {
		grid-area: route;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.end {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		min-width: 0;
		flex: 0 1 16rem;
	}
	.end select {
		width: 100%;
		min-width: 0;
	}
	.end-l {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-2);
	}
	.arrow {
		color: var(--text-muted);
	}
	.rule-acts {
		grid-area: acts;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.remove {
		min-height: 28px;
	}

	/* Enabled: a checkbox drawn as a switch, its word beside it; the word is part of the target. */
	.switch {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		min-height: 28px;
		cursor: pointer;
		user-select: none;
	}
	/* The real checkbox covers the whole switch (track and word), on top, so a tap anywhere on it lands on the input. */
	.switch input {
		position: absolute;
		z-index: 1;
		inset: 0;
		width: 100%;
		height: 100%;
		margin: 0;
		opacity: 0;
		cursor: inherit;
	}
	.switch input:disabled {
		cursor: default;
	}
	.track {
		position: relative;
		flex: none;
		width: 2.1rem;
		height: 1.2rem;
		border-radius: 999px;
		background: var(--surface-sunken);
		border: 1px solid var(--border-input);
		transition: background 0.12s;
	}
	.track::after {
		content: '';
		position: absolute;
		top: 1px;
		left: 1px;
		width: calc(1.2rem - 4px);
		height: calc(1.2rem - 4px);
		border-radius: 50%;
		background: var(--text-muted);
		transition: transform 0.12s;
	}
	.switch input:checked + .track {
		background: var(--accent);
		border-color: var(--accent);
	}
	.switch input:checked + .track::after {
		background: var(--accent-contrast);
		transform: translateX(0.9rem);
	}
	.switch input:focus-visible + .track {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}
	.switch input:disabled + .track {
		opacity: 0.7;
	}
	.state {
		min-width: 1.6rem;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-2);
	}
	@media (prefers-reduced-motion: reduce) {
		.track,
		.track::after {
			transition: none;
		}
	}

	/* ---- The body: three groups, top-aligned ---- */
	.rule-body {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-template-areas: 'rates' 'limits' 'source';
		gap: 0.9rem 1.5rem;
		padding: 0.6rem 0.9rem 0.65rem;
		align-items: start;
	}
	.g-rates {
		grid-area: rates;
	}
	.g-limits {
		grid-area: limits;
	}
	.g-source {
		grid-area: source;
	}
	.grp {
		min-width: 0;
	}
	.grp-t {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0 0.35rem;
		/* As tall as the rates' title line (its summary button), so the three groups' fields start level. */
		min-height: 24px;
		margin-bottom: 0.3rem;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		text-transform: uppercase;
		color: var(--text-2);
	}
	/* The rates' title sits on MonthRates' own head line, which spaces it. */
	.g-rates .grp-t {
		margin-bottom: 0;
	}
	.grp-t .u {
		font-weight: 400;
		text-transform: none;
		letter-spacing: 0;
		color: var(--text-muted);
	}
	.fields {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.5rem 0.75rem;
		align-items: start;
	}
	.fld {
		display: flex;
		flex-direction: column;
		gap: 0.2rem;
		min-width: 0;
	}
	.fld-l {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		/* As tall as a help tip, so a label with one and a label without start their fields on one line. */
		min-height: 24px;
		font-size: 0.78rem;
		color: var(--text-2);
		white-space: nowrap;
	}
	.fld :global(input),
	.fld select {
		width: 100%;
		min-width: 0;
		box-sizing: border-box;
	}
	.checks {
		grid-column: 1 / -1;
		display: flex;
		flex-wrap: wrap;
		gap: 0 1.25rem;
	}
	.check-row {
		display: inline-flex;
		align-items: center;
		gap: 0.3rem;
	}
	.check {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		/* Each switch at least 24 px apart from the next (WCAG 2.5.8). */
		min-height: 28px;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.check input {
		flex: none;
		margin: 0;
	}

	/* Medium (a narrow window, the grid modal): the rates beside the limits, the source across under them. */
	@container rule (min-width: 46rem) {
		.rule-body {
			grid-template-columns: minmax(0, 1fr) 12rem;
			grid-template-areas: 'rates limits' 'source source';
		}
		.g-limits .fields {
			grid-template-columns: minmax(0, 1fr);
		}
		.g-source .fields {
			grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
		}
	}
	/* Wide (1280 and 1440 windows): the head line becomes a column on the card's left (number, From over To,
	   the switch and Remove) beside the three groups, so a rule is as tall as its month fields. The rates
	   keep six columns wide enough for 0.0129 and 12.345; the source goes two to a row where there's room.
	   At 14 px a rem: 17 + 27 + 9 + 13.5 + the dividers ≈ 71rem, a 1280 window's ~73rem card. */
	@container rule (min-width: 70rem) {
		.rule-in {
			display: grid;
			grid-template-columns: 17rem minmax(0, 1fr);
		}
		.rule-head {
			grid-template-columns: minmax(0, 1fr);
			grid-template-areas: 'title' 'route' 'acts';
			align-content: start;
			gap: 0.4rem;
			padding: 0.6rem 0.75rem 0.65rem 0.9rem;
			border-bottom: 0;
			border-right: 1px solid var(--border);
		}
		/* From over To, each with its word; the route's help tip beside From. */
		.route {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0.3rem 0.35rem;
		}
		.route .end {
			grid-column: 1;
			display: grid;
			grid-template-columns: 2.2rem minmax(0, 1fr);
		}
		.route > :global(.helptip) {
			grid-column: 2;
			grid-row: 1;
		}
		.arrow {
			display: none;
		}
		.rule-acts {
			justify-content: space-between;
		}
		/* A dam source's two fields stack, no taller than the rates, and give the rates the room; a river
		   off-take's six stay two to a row (one column of six was the old table's ~330 px row). */
		.rule-body {
			grid-template-columns: minmax(27rem, 1fr) 9rem 13.5rem;
			grid-template-areas: 'rates limits source';
		}
		.g-source .fields {
			grid-template-columns: minmax(0, 1fr);
		}
		.river .rule-body {
			grid-template-columns: minmax(27rem, 1fr) 9rem minmax(20rem, 0.8fr);
		}
		.river .g-source .fields {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.g-limits,
		.g-source {
			padding-left: 1.25rem;
			border-left: 1px solid var(--border);
		}
		/* The dividers mark the groups here and every field names itself ("Daily cap, m³", "Takes from"), so
		   the Limits and Source titles would only be a line that makes each of thirty cards taller. */
		.g-limits > .grp-t,
		.g-source > .grp-t {
			display: none;
		}
	}

	/* Narrow (a phone): the route under the number, From and To each a full row with its word; tap-sized fields. */
	@container rule (max-width: 36rem) {
		.rule-head {
			grid-template-columns: minmax(0, 1fr) auto;
			grid-template-areas: 'title acts' 'route route';
			padding-left: 0.75rem;
		}
		.route {
			flex-direction: column;
			align-items: stretch;
			gap: 0.4rem;
		}
		.arrow {
			display: none;
		}
		/* Stacked, the route's help tip keeps its own size, under the To field on the left. */
		.route > :global(.helptip) {
			align-self: flex-start;
		}
		.end {
			flex: none;
			display: grid;
			grid-template-columns: 2.6rem minmax(0, 1fr);
		}
		.rule-body {
			padding-inline: 0.75rem;
		}
		/* A select's option ("The river (an off-take)") needs the card's width; the numbers stay two to a row. */
		.fld.sel {
			grid-column: 1 / -1;
		}
		.switch,
		.remove,
		.check,
		.end select,
		.fld select,
		.fld :global(input) {
			min-height: var(--tap);
		}
		.check input {
			width: 1.25rem;
			height: 1.25rem;
		}
		.g-rates :global(.rates input) {
			min-height: var(--tap);
		}
		.g-rates :global(.rates .all) {
			min-height: var(--tap);
			border: 1px solid var(--border);
			justify-content: center;
		}
	}

	.after {
		margin: 0.75rem 0 0;
	}
	.empty {
		padding: 1.5rem;
		text-align: center;
		color: var(--text-muted);
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius);
	}
	.empty .small {
		max-width: 60ch;
		margin: 0 auto 1rem;
	}
</style>
