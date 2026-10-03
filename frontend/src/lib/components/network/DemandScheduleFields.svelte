<script lang="ts">
	// A demand object's schedule (engine ≥ 1.17.0, issue #90 Q4, docs/model.md
	// §2.7f): date windows, each with a factor on the object's demand on the
	// days it covers (0 = off). A window covers every day, a span of dates each
	// year, a one-off date range or days around Easter, optionally on some
	// weekdays only; the later of two windows covering a day wins. Set by date
	// only. The object is the editor's own, so edits land in the model.
	import { tick } from 'svelte';
	import { DEMAND_SCHEDULE_MAX_FACTOR, DEMAND_SCHEDULE_MAX_WINDOWS, DEMAND_SCHEDULE_MAX_EASTER_OFFSET, scheduleWindowProblem, type DemandObject, type DemandScheduleSpan } from '@water-management/engine';
	import { moveWindow, newWindow, problemFields, SPAN_LABEL, toggleWeekday, withSpan } from './demandSchedule';
	import NumberInput from '$lib/components/common/NumberInput.svelte';
	import { confirmDialog } from '$lib/components/common/confirm.svelte';
	import { focusAfter, windowQuestion } from './removeQuestions';
	import HelpTip from '$lib/components/help/HelpTip.svelte';

	let { object: o, readonly }: { object: DemandObject; readonly: boolean } = $props();

	const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
	const windows = $derived(o.schedule ?? []);

	const add = (span: DemandScheduleSpan) => (o.schedule = [...windows, newWindow(span)]);
	/** Asks first when the window was changed from a new one, then puts the focus on the next window (or the add row). */
	async function remove(i: number) {
		const q = windowQuestion(windows[i]!, i);
		if (q && !(await confirmDialog(q))) return;
		const next = windows.filter((_, k) => k !== i);
		o.schedule = next.length ? next : null;
		const at = focusAfter(i, next.length + 1);
		await tick();
		document.getElementById(at === null ? `ds-new-${o.id}` : `ds-label-${o.id}-${at}`)?.focus();
	}
	/** The live line saying where a moved window went. */
	let announce = $state('');
	/**
	 * Moves window i one place, then keeps the focus on the moved window's button (the rows are
	 * keyed by place, so the pressed button now belongs to the other window): the same direction
	 * where it still has one, else the other (as the node table's ↑/↓, refocusMover).
	 */
	async function move(i: number, by: -1 | 1) {
		const w = windows[i]!;
		o.schedule = moveWindow(windows, i, by);
		const j = i + by;
		announce = `Window ${i + 1}${w.label.trim() ? ` (${w.label.trim()})` : ''} is now window ${j + 1}.`;
		await tick();
		const dir = by < 0 ? 'up' : 'down';
		const other = by < 0 ? 'down' : 'up';
		(document.getElementById(`ds-${dir}-${o.id}-${j}`) ?? document.getElementById(`ds-${other}-${o.id}-${j}`))?.focus();
	}
	const setSpan = (i: number, span: DemandScheduleSpan) => (o.schedule = windows.map((w, k) => (k === i ? withSpan(w, span) : w)));
	let newSpan = $state<DemandScheduleSpan>('always');
</script>

<div class="schedule" data-testid="demand-schedule-{o.id}">
	<p class="lbl">
		<span class="head">On/off schedule</span>
		<HelpTip key="demandObject.schedule" />
	</p>
	{#if windows.length === 0}
		<p class="muted small">Every day at its month’s demand.</p>
	{:else}
		<p class="muted small">Later windows win where two cover the same day; other days run at the month’s demand.</p>
		<ol class="windows">
			{#each windows as w, i (i)}
				{@const bad = scheduleWindowProblem(w)}
				{@const badAt = problemFields(bad)}
				{@const badId = `ds-bad-${o.id}-${i}`}
				<li data-testid="demand-schedule-window-{o.id}-{i}">
					<div class="grid">
						<div class="field">
							<label for="ds-label-{o.id}-{i}">Window {i + 1}</label>
							<input id="ds-label-{o.id}-{i}" maxlength="200" placeholder="e.g. Weekends" readonly={readonly} bind:value={w.label} />
						</div>
						<div class="field">
							<label for="ds-span-{o.id}-{i}">Days</label>
							<select id="ds-span-{o.id}-{i}" disabled={readonly} value={w.span} onchange={(e) => setSpan(i, e.currentTarget.value as DemandScheduleSpan)}>
								{#each Object.entries(SPAN_LABEL) as [s, text] (s)}<option value={s}>{text}</option>{/each}
							</select>
						</div>
						{#if w.span === 'yearly'}
							<div class="field">
								<label for="ds-from-{o.id}-{i}">From <span class="u">(MM-DD)</span></label>
								<input aria-invalid={badAt === 'bounds' ? 'true' : undefined} aria-describedby={badAt === 'bounds' ? badId : undefined} id="ds-from-{o.id}-{i}" maxlength="5" placeholder="12-15" readonly={readonly} value={w.from ?? ''} onchange={(e) => (w.from = e.currentTarget.value.trim())} />
							</div>
							<div class="field">
								<label for="ds-to-{o.id}-{i}">To <span class="u">(MM-DD)</span></label>
								<input aria-invalid={badAt === 'bounds' ? 'true' : undefined} aria-describedby={badAt === 'bounds' ? badId : undefined} id="ds-to-{o.id}-{i}" maxlength="5" placeholder="01-10" readonly={readonly} value={w.to ?? ''} onchange={(e) => (w.to = e.currentTarget.value.trim())} />
							</div>
						{:else if w.span === 'range'}
							<div class="field">
								<label for="ds-from-{o.id}-{i}">From</label>
								<input aria-invalid={badAt === 'bounds' ? 'true' : undefined} aria-describedby={badAt === 'bounds' ? badId : undefined} id="ds-from-{o.id}-{i}" type="date" readonly={readonly} value={w.from ?? ''} onchange={(e) => (w.from = e.currentTarget.value)} />
							</div>
							<div class="field">
								<label for="ds-to-{o.id}-{i}">To</label>
								<input aria-invalid={badAt === 'bounds' ? 'true' : undefined} aria-describedby={badAt === 'bounds' ? badId : undefined} id="ds-to-{o.id}-{i}" type="date" readonly={readonly} value={w.to ?? ''} onchange={(e) => (w.to = e.currentTarget.value)} />
							</div>
						{:else if w.span === 'easter'}
							<div class="field">
								<label for="ds-ef-{o.id}-{i}">From <span class="u">(days from Easter Sunday)</span></label>
								<NumberInput aria-invalid={badAt === 'bounds' ? 'true' : undefined} aria-describedby={badAt === 'bounds' ? badId : undefined} id="ds-ef-{o.id}-{i}" min={-DEMAND_SCHEDULE_MAX_EASTER_OFFSET} max={DEMAND_SCHEDULE_MAX_EASTER_OFFSET} step={1} disabled={readonly} value={w.easterFrom} onchange={(v) => (w.easterFrom = v ?? 0)} />
							</div>
							<div class="field">
								<label for="ds-et-{o.id}-{i}">To <span class="u">(days from Easter Sunday)</span></label>
								<NumberInput aria-invalid={badAt === 'bounds' ? 'true' : undefined} aria-describedby={badAt === 'bounds' ? badId : undefined} id="ds-et-{o.id}-{i}" min={-DEMAND_SCHEDULE_MAX_EASTER_OFFSET} max={DEMAND_SCHEDULE_MAX_EASTER_OFFSET} step={1} disabled={readonly} value={w.easterTo} onchange={(v) => (w.easterTo = v ?? 0)} />
							</div>
						{/if}
						<div class="field">
							<label for="ds-factor-{o.id}-{i}">Factor <span class="u">(0 = off)</span></label>
							<NumberInput aria-invalid={badAt === 'factor' ? 'true' : undefined} aria-describedby={badAt === 'factor' ? badId : undefined} id="ds-factor-{o.id}-{i}" min={0} max={DEMAND_SCHEDULE_MAX_FACTOR} disabled={readonly} value={w.factor} onchange={(v) => (w.factor = v ?? 0)} />
						</div>
					</div>
					<fieldset class="days" aria-describedby={badAt === 'weekdays' ? badId : undefined}>
						<legend>On</legend>
						{#each WEEKDAYS as d, k (d)}
							<label><input type="checkbox" aria-invalid={badAt === 'weekdays' ? 'true' : undefined} disabled={readonly} checked={!w.weekdays || w.weekdays.includes(k + 1)} onchange={(e) => (w.weekdays = toggleWeekday(w.weekdays, k + 1, e.currentTarget.checked))} /> {d}</label>
						{/each}
					</fieldset>
					{#if bad}<p class="bad small" id={badId}>Not used: {bad}.</p>{/if}
					{#if !readonly}
						<div class="row-actions">
							{#if i > 0}<button type="button" class="btn btn-sm" id="ds-up-{o.id}-{i}" onclick={() => move(i, -1)}>Move window {i + 1} up</button>{/if}
							{#if i < windows.length - 1}<button type="button" class="btn btn-sm" id="ds-down-{o.id}-{i}" onclick={() => move(i, 1)}>Move window {i + 1} down</button>{/if}
							<button type="button" class="btn btn-sm" onclick={() => remove(i)}>Remove window {i + 1}</button>
						</div>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}
	<p class="visually-hidden" aria-live="polite" data-testid="demand-schedule-status-{o.id}">{announce}</p>
	{#if !readonly && windows.length < DEMAND_SCHEDULE_MAX_WINDOWS}
		<div class="add">
			<label for="ds-new-{o.id}" class="visually-hidden">Days the new window covers</label>
			<select id="ds-new-{o.id}" bind:value={newSpan}>
				{#each Object.entries(SPAN_LABEL) as [s, text] (s)}<option value={s}>{text}</option>{/each}
			</select>
			<button type="button" class="btn btn-sm" onclick={() => add(newSpan)}>+ Add window</button>
		</div>
	{/if}
</div>

<style>
	.schedule {
		margin: 0.5rem 0;
	}
	.lbl {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		margin: 0 0 0.25rem;
	}
	.head {
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-2);
	}
	.windows {
		list-style: none;
		padding: 0;
		margin: 0 0 0.5rem;
	}
	.windows li {
		border-left: 2px solid var(--border);
		padding: 0.25rem 0 0.25rem 0.75rem;
		margin-bottom: 0.5rem;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
		gap: 0 1rem;
		align-items: end;
	}
	.field label {
		font-weight: 500;
		font-size: 0.85rem;
		color: var(--text-2);
	}
	.field :global(input),
	.field select {
		width: 100%;
	}
	.days {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.75rem;
		border: 0;
		padding: 0;
		margin: 0.25rem 0;
		font-size: 0.85rem;
	}
	.days legend {
		float: left;
		margin-right: 0.5rem;
		font-weight: 500;
		color: var(--text-2);
	}
	.bad {
		color: var(--danger);
		margin: 0.25rem 0;
	}
	.row-actions,
	.add {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}
	@media (max-width: 640px) {
		.field :global(input),
		.field select,
		.add select,
		.btn {
			min-height: 44px;
		}
		.days label {
			min-height: 44px;
			display: inline-flex;
			align-items: center;
			gap: 0.25rem;
		}
	}
</style>
