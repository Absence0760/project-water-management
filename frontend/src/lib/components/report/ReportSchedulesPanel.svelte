<!--
	Project → Scheduled reports (WP-2.15 Phase B; docs/ui.md § Scheduled
	reports): email the latest run's report PDF to chosen project members
	every week or month. Editors and owners add, pause and remove schedules;
	viewers read. "Add a schedule" sits in the panel's head and opens the form
	as a card above the list, with its own action row (issue #521); the words
	under the heading are the (i)'s. Its own chunk, on the Project page since
	issue #586 (it was on Settings), whose wrapper carries its anchor,
	#project-report-schedules. It saves as it changes, unlike the page's
	details (the save bar), and says so to those who can change it. Helpers in ./serverPdf.ts.
-->
<script lang="ts">
	import { confirmDialog } from '#lib/components/common/confirm.svelte.js';
	import { onMount, tick } from 'svelte';
	import { focusAfterRemove } from '#lib/a11y/focusAfterRemove.js';
	import { api, type Member } from '#lib/api/index.js';
	import HelpTip from '#lib/components/help/HelpTip.svelte';
	import LoadState from '#lib/components/common/LoadState.svelte';
	import { session } from '#lib/auth/session.svelte.js';
	import {
		describeSchedule,
		emptyScheduleDraft,
		type ReportSchedule,
		reportsApi,
		type ScheduleDraft,
		scheduleDraftToBody,
		scheduleStatus,
		WEEKDAYS
	} from './serverPdf';

	let { projectId, canEdit }: { projectId: string; canEdit: boolean } = $props();

	const uid = $props.id();
	const reports = $derived(reportsApi(api, projectId));

	let schedules = $state<ReportSchedule[] | null>(null);
	let members = $state<Member[]>([]);
	let loadError = $state<string | null>(null);
	let busy = $state<string | null>(null);
	let message = $state<string | null>(null);
	let error = $state<string | null>(null);
	let adding = $state(false);
	let draft = $state<ScheduleDraft>(emptyScheduleDraft(null));
	let formError = $state<string | null>(null);
	let addButton: HTMLButtonElement | undefined = $state();

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const HOURS = Array.from({ length: 24 }, (_, h) => h);
	const DAYS = Array.from({ length: 28 }, (_, d) => d + 1);

	async function reload() {
		loadError = null;
		try {
			const [s, m] = await Promise.all([reports.schedules(), canEdit ? api.members.list(projectId) : Promise.resolve([] as Member[])]);
			schedules = s;
			// Only members who can read the report: never a farmer (the API refuses one too).
			members = m.filter((x) => x.role !== 'farmer');
		} catch (e) {
			loadError = msg(e);
		}
	}
	onMount(reload);

	// Focus follows the card: into it when it opens, back to "Add a schedule" when it closes.
	async function startAdding() {
		const me = session.user?.id ?? null;
		draft = emptyScheduleDraft(members.some((m) => m.userId === me) ? me : null);
		formError = null;
		adding = true;
		await tick();
		document.getElementById(`${uid}-freq`)?.focus({ preventScroll: true });
		// The whole card, its action row included, in the window: focusing the first field scrolled only as far as
		// that field, so at the foot of the page Add schedule could sit under the window's edge (issue #586).
		document.getElementById(`${uid}-add-h`)?.closest('form')?.scrollIntoView({ block: 'nearest' });
	}

	async function closeForm() {
		adding = false;
		await tick();
		addButton?.focus();
	}

	function toggleRecipient(userId: string, on: boolean) {
		draft.recipients = on ? [...draft.recipients, userId] : draft.recipients.filter((u) => u !== userId);
	}

	async function add(e: SubmitEvent) {
		e.preventDefault();
		const parsed = scheduleDraftToBody(draft);
		if ('error' in parsed) {
			formError = parsed.error;
			return;
		}
		busy = 'add';
		formError = message = error = null;
		try {
			const s = await reports.addSchedule(parsed.body);
			message = `Schedule added: ${describeSchedule(s)}.`;
			await reload();
			await closeForm();
		} catch (err) {
			formError = msg(err);
		} finally {
			busy = null;
		}
	}

	async function act(s: ReportSchedule, what: 'toggle' | 'remove') {
		if (
			what === 'remove' &&
			!(await confirmDialog({
				title: 'Remove this schedule?',
				message: `Remove the schedule “${describeSchedule(s)}”? Reports already sent stay available for 7 days.`,
				confirmLabel: 'Remove schedule',
				danger: true
			}))
		)
			return;
		busy = s.id;
		message = error = null;
		// Its place in the list: its row, and the Remove that had the focus, go with it (issue #586).
		const at = schedules?.findIndex((x) => x.id === s.id) ?? -1;
		try {
			if (what === 'toggle') {
				await reports.updateSchedule(s.id, { enabled: !s.enabled });
				message = s.enabled ? 'Schedule paused.' : 'Schedule resumed.';
			} else {
				await reports.removeSchedule(s.id);
				message = 'Schedule removed.';
			}
			await reload();
			// The Remove of the schedule now in its place takes the focus, else Add a schedule, else the heading.
			if (what === 'remove') await focusAfterRemove(at, `[aria-labelledby="${uid}-h"] .schedule button.btn-danger`, addButton ?? `${uid}-h`);
		} catch (err) {
			error = msg(err);
		} finally {
			busy = null;
		}
	}
</script>

<section class="panel" aria-labelledby="{uid}-h">
	<!-- The add action in the head (issue #521); what a schedule sends, and as whom, is the (i)'s, with the rest in the glossary. -->
	<div class="panel-head">
		<h2 id="{uid}-h">Scheduled reports <HelpTip key="report-pdf" label="About report PDFs and schedules" /></h2>
		{#if schedules && canEdit && !adding}
			<button type="button" class="btn btn-sm btn-primary" bind:this={addButton} onclick={startAdding}>Add a schedule</button>
		{/if}
	</div>
	<!-- Each add, pause and remove saves at once, unlike the page's fields that wait for the save bar (issue #586, E13). -->
	{#if canEdit}<p class="muted small saves-note" data-testid="schedules-saves">Saves as you change it, not with Save changes at the foot of the page.</p>{/if}

	{#if loadError}
		<div class="alert alert-error" role="alert">
			Couldn’t load the report schedules: {loadError}
			<button type="button" class="btn btn-sm" onclick={reload}>Try again</button>
		</div>
	{:else if !schedules}
		<p class="muted" role="status">Loading…</p>
	{:else}
		<!-- Always in the page, so screen readers announce each new message. -->
		<div role="status">{#if message}<p class="muted msg">{message}</p>{/if}</div>
		{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}

		{#if adding}
			<form class="add" onsubmit={add} novalidate aria-labelledby="{uid}-add-h">
				<h3 id="{uid}-add-h">Add a schedule</h3>
				<div class="form-row">
					<div class="field">
						<label for="{uid}-freq">Every</label>
						<select id="{uid}-freq" bind:value={draft.frequency}>
							<option value="weekly">Week</option>
							<option value="monthly">Month</option>
						</select>
					</div>
					{#if draft.frequency === 'weekly'}
						<div class="field">
							<label for="{uid}-wd">On</label>
							<select id="{uid}-wd" bind:value={draft.weekday}>
								{#each WEEKDAYS as d, i (d)}<option value={i + 1}>{d}</option>{/each}
							</select>
						</div>
					{:else}
						<div class="field">
							<label for="{uid}-md">Day of the month</label>
							<select id="{uid}-md" bind:value={draft.monthDay}>
								{#each DAYS as d (d)}<option value={d}>{d}</option>{/each}
							</select>
						</div>
					{/if}
					<div class="field">
						<label for="{uid}-hour">At</label>
						<select id="{uid}-hour" bind:value={draft.hour}>
							{#each HOURS as h (h)}<option value={h}>{String(h).padStart(2, '0')}:00</option>{/each}
						</select>
					</div>
					<div class="field">
						<label for="{uid}-tz">Time zone</label>
						<input id="{uid}-tz" type="text" maxlength="64" autocomplete="off" bind:value={draft.timezone} aria-describedby="{uid}-tz-h" />
						<span class="hint" id="{uid}-tz-h">An IANA name, like Africa/Johannesburg.</span>
					</div>
				</div>
				<fieldset>
					<legend>Send to</legend>
					{#each members as m (m.userId)}
						<label class="check">
							<input type="checkbox" checked={draft.recipients.includes(m.userId)} onchange={(e) => toggleRecipient(m.userId, e.currentTarget.checked)} />
							{m.displayName} <span class="muted">({m.email})</span>
						</label>
					{/each}
				</fieldset>
				{#if formError}<p class="err" role="alert">{formError}</p>{/if}
				<div class="action-row">
					<button type="submit" class="btn btn-primary" disabled={busy === 'add'}>{busy === 'add' ? 'Adding…' : 'Add schedule'}</button>
					<button type="button" class="btn" onclick={closeForm}>Cancel</button>
				</div>
			</form>
		{/if}

		<!-- The app's one empty state (LoadState's dashed box), as API keys and Data feeds show theirs (issue #586, C17). -->
		<LoadState loading={false} empty={schedules.length === 0} emptyText="No scheduled reports{canEdit ? '.' : '. An editor can add one.'}">
			<ul class="schedules" aria-label="Scheduled reports">
				{#each schedules as s (s.id)}
					<li class="schedule" data-enabled={s.enabled}>
						<strong>{describeSchedule(s)}</strong>
						<p class="muted small">
							To {s.recipients.map((r) => r.displayName).join(', ') || 'nobody'}{s.actingUser ? ` · sends as ${s.actingUser}` : ' · nobody to send as: an editor must save it again'}
						</p>
						<p class="small" class:warn={!!s.lastError}>{scheduleStatus(s)}</p>
						{#if canEdit}
							<div class="act">
								<button type="button" class="btn btn-sm" disabled={busy === s.id} aria-label="{s.enabled ? 'Pause' : 'Resume'}: {describeSchedule(s)}" onclick={() => act(s, 'toggle')}>
									{s.enabled ? 'Pause' : 'Resume'}
								</button>
								<button type="button" class="btn btn-sm btn-danger" disabled={busy === s.id} aria-label="Remove schedule: {describeSchedule(s)}" onclick={() => act(s, 'remove')}>Remove</button>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</LoadState>
	{/if}
</section>

<style>
	.saves-note {
		margin: 0 0 0.5rem;
	}
	.hint {
		font-size: var(--font-sm);
		max-width: 75ch;
	}
	.schedules {
		list-style: none;
		margin: 0 0 0.75rem;
		padding: 0;
		display: grid;
		gap: 0.5rem;
	}
	.schedule {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.6rem 0.75rem;
	}
	.schedule p {
		margin: 0.2rem 0;
	}
	.warn {
		color: var(--warning);
	}
	.act {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}
	.msg {
		margin: 0 0 0.5rem;
	}
	/* The add card: bordered, above the list, its action row at its foot. */
	.add {
		margin: 0 0 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem 0.9rem;
	}
	.add h3 {
		margin: 0 0 0.5rem;
		font-size: 1rem;
	}
	fieldset {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		margin: 0.75rem 0;
		padding: 0.5rem 0.75rem;
	}
	.check {
		min-height: 24px;
	}
	.err {
		color: var(--danger);
		margin: 0.5rem 0 0;
	}
</style>
