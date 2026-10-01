<script lang="ts">
	// "Assess together" (roadmap WP-3.11, docs/ui.md § Applications › Assess
	// together): the assessors pick submitted or decided applications on one
	// baseline, check that they combine (conflicts listed with both changes
	// side by side, never merged), and run each alone and all together as one
	// background job. The result is one matrix: each measure at each EWR site
	// and for the catchment, the baseline, each application alone, all
	// together, and the interaction (together less the sum of the separate
	// changes), with a CSV of the raw numbers. Editors only (the tab is the
	// assessors'; the API refuses anyone else).
	import { untrack } from 'svelte';
	import { api, assessmentCheckOf, type Assessment, type AssessmentCheck, type Scenario } from '$lib/api';
	import LoadState from '$lib/components/common/LoadState.svelte';
	import { saveBlob } from '$lib/export/download';
	import { fmtDate } from '$lib/format/number';
	import { describeOp } from './ops';
	import {
		assessable,
		assessmentCsv,
		assessmentState,
		changeText,
		changeTone,
		interactionWords,
		pickBlocked,
		rowLabel,
		valueText
	} from './cumulative';

	let { projectId, applications }: { projectId: string; applications: Scenario[] } = $props();

	const choices = $derived(assessable(applications));
	let picked = $state<string[]>([]);
	let name = $state('');
	let check = $state<AssessmentCheck | null>(null);
	let busy = $state(false);
	let actionError = $state<string | null>(null);

	let list = $state<Assessment[] | null>(null);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let current = $state<Assessment | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let live = true;
	$effect(() => () => {
		live = false;
		clearTimeout(timer);
	});

	const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
	const byId = $derived(new Map(applications.map((a) => [a.id, a])));
	const shown = $derived(current ? assessmentState(current) : null);
	const report = $derived(current?.status === 'complete' ? (current.report ?? null) : null);
	const canRun = $derived(picked.length >= 2 && name.trim().length > 0 && !busy);

	function toggle(id: string, on: boolean) {
		picked = on ? [...picked, id] : picked.filter((x) => x !== id);
		check = null;
		actionError = null;
	}

	/** Names an op holds ids for: the scenario's own record of them (047). */
	const namesOf = (s: Scenario | undefined) => new Map((s?.opNames ?? []).map((n) => [n.id, n.name]));
	function opText(scenarioId: string, opIndex: number): string {
		const s = byId.get(scenarioId);
		const op = s?.ops[opIndex];
		return op ? describeOp(op, null, namesOf(s)) : 'a change';
	}

	async function load() {
		loading = true;
		loadError = null;
		try {
			const got = await api.assessments.list(projectId);
			if (!live) return;
			list = got;
			if (got[0]) await open(got[0].id);
		} catch (e) {
			if (live) loadError = msg(e);
		} finally {
			if (live) loading = false;
		}
	}
	$effect(() => {
		void projectId;
		untrack(load);
	});

	/** Show one assessment, following it while it runs. */
	async function open(id: string) {
		clearTimeout(timer);
		try {
			const a = await api.assessments.get(projectId, id);
			if (!live) return;
			current = a;
			if (list) list = list.map((x) => (x.id === a.id ? { ...a, report: undefined } : x));
			if (assessmentState(a).kind === 'pending') timer = setTimeout(() => open(id), 1500);
		} catch (e) {
			if (live) loadError = msg(e);
		}
	}

	async function runCheck() {
		busy = true;
		actionError = null;
		try {
			check = await api.assessments.check(projectId, { name: name.trim() || 'Check', scenarioIds: picked });
		} catch (e) {
			check = assessmentCheckOf(e);
			if (!check) actionError = msg(e);
		} finally {
			busy = false;
		}
	}

	async function start(e: SubmitEvent) {
		e.preventDefault();
		if (!canRun) return;
		busy = true;
		actionError = null;
		try {
			const res = await api.assessments.create(projectId, { name: name.trim(), scenarioIds: picked });
			check = null;
			list = [res.assessment, ...(list ?? [])];
			await open(res.assessment.id);
		} catch (err) {
			check = assessmentCheckOf(err);
			if (!check) actionError = msg(err);
		} finally {
			busy = false;
		}
	}

	function downloadCsv() {
		if (!current?.report) return;
		const safe = current.name.replace(/[^\w -]+/g, '').trim() || 'assessment';
		saveBlob(new Blob([assessmentCsv(current.report)], { type: 'text/csv;charset=utf-8' }), `${safe} - cumulative impact.csv`);
	}
</script>

<section class="panel assess" aria-labelledby="assess-h" data-testid="assess-together">
	<div class="panel-head">
		<div class="head-text">
			<h2 id="assess-h">Assess together</h2>
			<span class="muted small">
				Each application on its own and all of them together on their baseline. Two applications that change the same thing, or where
				one removes what another uses, are refused rather than merged.
			</span>
		</div>
	</div>

	<form class="pick" onsubmit={start}>
		<fieldset>
			<legend>Applications</legend>
			{#if !choices.length}
				<p class="empty small">No submitted or decided applications to assess.</p>
			{:else}
				<ul class="choices">
					{#each choices as a (a.id)}
						{@const blocked = pickBlocked(choices, picked, a.id)}
						<li>
							<label class:blocked>
								<input
									type="checkbox"
									checked={picked.includes(a.id)}
									disabled={!!blocked && !picked.includes(a.id)}
									onchange={(e) => toggle(a.id, e.currentTarget.checked)}
								/>
								<span>{a.name}</span>
								<span class="sub">{a.ops.length} change{a.ops.length === 1 ? '' : 's'} · {a.status === 'decided' ? 'decided' : 'awaiting a decision'}{blocked ? ` · ${blocked}` : ''}</span>
							</label>
						</li>
					{/each}
				</ul>
			{/if}
		</fieldset>
		<div class="field">
			<label for="assess-name">Name</label>
			<input id="assess-name" type="text" maxlength="200" bind:value={name} placeholder="e.g. Upper reach applications, 2026" />
		</div>
		<div class="actions">
			<button type="button" class="btn" disabled={picked.length < 2 || busy} onclick={runCheck}>Check they combine</button>
			<button type="submit" class="btn primary" disabled={!canRun}>Assess together</button>
			<span class="muted small">{picked.length} picked{picked.length < 2 ? ' (pick at least two)' : ''}</span>
		</div>
		{#if actionError}<p class="error" role="alert">{actionError}</p>{/if}
		{#if check}
			<div class="check" role="status" data-testid="assess-check">
				{#if check.ok}
					<p class="ok">These applications combine: none changes what another changes or uses.</p>
				{:else}
					{#if check.conflicts.length}
						<p class="bad">
							{check.conflicts.length === 1 ? 'One conflict' : `${check.conflicts.length} conflicts`}: these can’t be assessed together until an
							applicant changes their application.
						</p>
						<ul class="conflicts">
							{#each check.conflicts as c, i (i)}
								<li data-testid="assess-conflict">
									<p class="target"><strong>{c.target}</strong> · {c.reason === 'same_target' ? 'both change it' : 'one removes what the other uses'}</p>
									<div class="sides">
										<div><span class="who">{byId.get(c.a.scenarioId)?.name ?? 'Application'}</span> change {c.a.opIndex + 1}: {opText(c.a.scenarioId, c.a.opIndex)}</div>
										<div><span class="who">{byId.get(c.b.scenarioId)?.name ?? 'Application'}</span> change {c.b.opIndex + 1}: {opText(c.b.scenarioId, c.b.opIndex)}</div>
									</div>
								</li>
							{/each}
						</ul>
					{/if}
					{#if check.problems.length}
						<p class="bad">Changes that don’t apply together:</p>
						<ul class="problems">
							{#each check.problems as p, i (i)}<li>{p}</li>{/each}
						</ul>
					{/if}
				{/if}
			</div>
		{/if}
	</form>

	<LoadState {loading} error={loadError} retry={load}>
		{#if list?.length}
			<div class="field past">
				<label for="assess-open">Assessment</label>
				<select id="assess-open" value={current?.id ?? ''} onchange={(e) => open(e.currentTarget.value)}>
					{#each list as a (a.id)}
						<option value={a.id}>{a.name} · {fmtDate(a.createdAt, true)}</option>
					{/each}
				</select>
			</div>
		{/if}
		{#if current && shown}
			<div class="result" data-testid="assess-result" data-state={shown.kind}>
				<p class="muted small">
					On {current.baseRun.label || 'the baseline'}: {current.members.map((m) => m.name).join(', ')}{current.createdBy ? ` · by ${current.createdBy}` : ''}{current.engineVersion
						? ` · engine ${current.engineVersion}`
						: ''}
				</p>
				{#if shown.kind === 'pending'}
					<p role="status">{shown.text}{shown.progress !== null ? ` ${Math.round(shown.progress)} %` : ''}</p>
				{:else if shown.kind === 'stopped'}
					<p class="bad" role="alert">{shown.text}</p>
					{#if shown.lines.length}<ul class="problems">{#each shown.lines as l, i (i)}<li>{l}</li>{/each}</ul>{/if}
				{:else if report}
					{#each report.warnings as w, i (i)}<p class="warn">{w}</p>{/each}
					<p class="small explain">
						<strong>Interaction</strong> is the change with every application together, less the changes each makes alone added up. Zero means
						their effects simply add; a change shown as worse means together they do more harm than their separate effects suggest.
					</p>
					<div class="table-wrap">
						<table class="data matrix">
							<caption class="visually-hidden">Each measure on the baseline, each application alone, all together, and the interaction</caption>
							<thead>
								<tr>
									<th scope="col">Measure</th>
									<th scope="col">Site</th>
									<th scope="col" class="num">Baseline</th>
									{#each report.scenarios as s (s.id)}<th scope="col" class="num">{s.name} alone</th>{/each}
									<th scope="col" class="num">All together</th>
									<th scope="col" class="num">Interaction</th>
								</tr>
							</thead>
							<tbody>
								{#each report.rows as r, i (i)}
									{@const label = rowLabel(r)}
									<tr data-metric={r.metric}>
										<th scope="row">{label.measure}</th>
										<td>{label.site}</td>
										<td class="num">{valueText(r.baseline, r.unit)}</td>
										{#each r.singles as v, k (k)}
											<td class="num">
												{valueText(v, r.unit)}
												<span class="chg tone-{changeTone(r.singleChanges[k] ?? null, r.higherIsWorse, r.baseline ?? 1)}">{changeText(r.singleChanges[k] ?? null, r.unit)}</span>
											</td>
										{/each}
										<td class="num">
											{valueText(r.combined, r.unit)}
											<span class="chg tone-{changeTone(r.combinedChange, r.higherIsWorse, r.baseline ?? 1)}">{changeText(r.combinedChange, r.unit)}</span>
										</td>
										<td class="num" title={interactionWords(r)}>
											<span class="chg tone-{changeTone(r.interaction, r.higherIsWorse, r.baseline ?? 1)}">{changeText(r.interaction, r.unit)}</span>
											<span class="visually-hidden">{interactionWords(r)}</span>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<div class="actions"><button type="button" class="btn" onclick={downloadCsv}>Download CSV</button></div>
				{/if}
			</div>
		{:else if list && !list.length}
			<p class="empty small">No assessments yet.</p>
		{/if}
	</LoadState>
</section>

<style>
	.assess {
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}
	.head-text {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}
	fieldset {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 0.5rem 0.75rem;
		margin: 0;
	}
	.choices {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 0.25rem;
	}
	.choices label {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.25rem 0.5rem;
		min-height: 32px;
		margin: 0;
	}
	.choices label.blocked {
		color: var(--text-2);
	}
	.sub {
		color: var(--text-2);
		font-size: 0.85rem;
	}
	.pick {
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.check,
	.result {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.ok {
		color: var(--success);
	}
	.bad,
	.error {
		color: var(--danger);
	}
	.conflicts,
	.problems {
		margin: 0;
		padding-left: 1.2rem;
	}
	.conflicts li {
		margin-bottom: 0.4rem;
	}
	.target {
		margin: 0;
	}
	.sides {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 0.25rem 1rem;
		font-size: 0.9rem;
	}
	.who {
		font-weight: 600;
	}
	.matrix td.num {
		white-space: nowrap;
	}
	.chg {
		display: block;
		font-size: 0.8rem;
		color: var(--text-2);
	}
	.chg.tone-worse {
		color: var(--danger);
	}
	.chg.tone-better {
		color: var(--success);
	}
	.table-wrap {
		overflow-x: auto;
	}
	.explain {
		margin: 0;
	}
	.warn {
		color: var(--warning);
	}
</style>
