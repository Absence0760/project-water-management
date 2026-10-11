// The Showcase example (backend/scripts/examples/showcase.ts: every feature,
// invented data) loaded into a fresh project of the signed-in user, for specs
// that need a real-sized model: its node ids are fixed uuids, unique across
// the database, so each copy gets fresh ones. Only the model and settings:
// no series, runs or map (seed:examples' SEED_SHOWCASE does those).
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext } from '@playwright/test';
import { createProject, putModel, updateSettings, type Model } from './api.ts';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const backendDir = fileURLToPath(new URL('../../backend/', import.meta.url));

/**
 * The Showcase's model and settings, built by the backend's own builder (run
 * with its tsx, as examples.ts runs the seed, since the builder's engine
 * imports resolve in the backend workspace, not here); once per worker.
 */
let built: { model: unknown; settings: unknown } | undefined;
function showcase(): { model: unknown; settings: unknown } {
	built ??= JSON.parse(
		execFileSync(
			'pnpm',
			['exec', 'tsx', '-e', "import('./scripts/examples/showcase.ts').then((m) => { const ex = m.buildShowcase({ fit: false }); process.stdout.write(JSON.stringify({ model: ex.model, settings: ex.settings })); })"],
			{ cwd: backendDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
		)
	);
	return built!;
}

export async function seedShowcaseModel(request: APIRequestContext, name: string): Promise<{ id: string; nodeId: (name: string) => string }> {
	const ex = showcase();
	const fresh = new Map<string, string>();
	const remap = <T>(v: T): T =>
		JSON.parse(
			JSON.stringify(v).replace(UUID, (m) => {
				if (!fresh.has(m)) fresh.set(m, randomUUID());
				return fresh.get(m)!;
			})
		);
	const model = remap(ex.model) as Model;
	const nodes = model.nodes as { id: string; name: string }[];
	const project = await createProject(request, name);
	await updateSettings(request, project.id, remap(ex.settings) as Record<string, unknown>);
	await putModel(request, project.id, model);
	return {
		id: project.id,
		nodeId: (n) => {
			const node = nodes.find((x) => x.name === n);
			if (!node) throw new Error(`no node ${n} in the Showcase`);
			return node.id;
		}
	};
}
