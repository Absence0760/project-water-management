// Research harness, fourth experiment (docs/design/delineation-snapping.md §
// Clicks on the red lines): the editor is told to click the elevation
// model's channels (the red lines, channels.ts), but the area match (place.ts)
// was tuned on clicks ON HydroRIVERS lines. Here every click is on a small red
// line (1–8 km²) beside a mapped river, as a farm dam's stream beside a river
// is clicked: the middle vertex of a channel-tile line lying 250–900 m from a
// HydroRIVERS reach of 100–3 000 km², that reach the nearest to the click and
// no confluence there. Each click goes through the app's own path (reachFor,
// then delineate with the options routes.ts passes) and is scored:
//   - stayed: the outlet is on the clicked stream (under ½ the reach's area);
//   - asked: refused `larger_channel` (the reach's channel or a larger one offered);
//   - moved: placed on the river (½ the reach's area or more) without asking.
// Run by hand against the operator's local stack (not CI):
//
//   DEM_URL=http://localhost:9002/tiles/terrain.pmtiles \
//   tsx --env-file=.env.development scripts/research/snap-redline.ts <out.json> [--n 23] [--seed s]
import { writeFileSync } from "node:fs";
import pg from "pg";
import {
  channelTile,
  CHANNEL_TILE_DEG,
} from "../../src/delineation/channels.js";
import { configuredDem } from "../../src/delineation/dem.js";
import {
  delineate,
  DelineationRefused,
} from "../../src/delineation/delineate.js";
import {
  confluenceChoices,
  lineDistM,
  reachesNear,
  reachFor,
} from "../../src/delineation/reach.js";

const args = process.argv.slice(2);
const out = args[0] ?? "";
if (!out)
  throw new Error("usage: snap-redline.ts <out.json> [--n 23] [--seed s]");
const opt = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1]! : d;
};
const N = Number(opt("--n", "23"));
const SEED = opt("--seed", "redline-1");

type P = [number, number];

async function main() {
  const dem = configuredDem();
  if (!dem) throw new Error("DEM_URL is empty");
  // Owner connection: the reference tables are read as their owner (no app user here).
  const db = new pg.Client({
    connectionString:
      process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  await db.connect();
  const { rows } = await db.query<{
    reach_id: string;
    upstream_km2: number;
    coords: P[];
  }>(
    `SELECT reach_id::text, upstream_km2, geometry->'coordinates' AS coords FROM river_reference
		  WHERE dataset = 'HydroRIVERS-v10' AND upstream_km2 BETWEEN 100 AND 3000
		    AND min_lat > -34.5 AND max_lat < -22.5 AND min_lon > 17 AND max_lon < 32.5
		  ORDER BY md5(reach_id::text || $1) LIMIT $2`,
    [SEED, N * 20],
  );
  const results: unknown[] = [];
  const tiles = new Map<string, Awaited<ReturnType<typeof channelTile>>>();
  for (const r of rows) {
    if (results.length >= N) break;
    const mid = r.coords[Math.floor(r.coords.length / 2)]!;
    const tile: [number, number] = [
      Math.floor(mid[0] / CHANNEL_TILE_DEG),
      Math.floor(mid[1] / CHANNEL_TILE_DEG),
    ];
    const key = tile.join(",");
    if (!tiles.has(key)) tiles.set(key, await channelTile(dem, tile));
    // A red line of 1–8 km² whose middle vertex is 250–900 m from this reach, the reach the nearest there, no confluence.
    let click: P | null = null;
    let lineKm2 = 0;
    for (const l of tiles.get(key)!.lines) {
      if (l.km2 < 1 || l.km2 > 8 || l.coordinates.length < 3) continue;
      const v = l.coordinates[Math.floor(l.coordinates.length / 2)] as P;
      const d = lineDistM(v, r.coords);
      if (d < 250 || d > 900) continue;
      const near = await reachesNear(db as never, v);
      if (String(near[0]?.reachId) !== r.reach_id || confluenceChoices(v, near))
        continue;
      click = v;
      lineKm2 = l.km2;
      break;
    }
    if (!click) continue;
    const { reach, junction } = await reachFor(db as never, click, null);
    const rec: Record<string, unknown> = {
      reach: r.reach_id,
      reachKm2: r.upstream_km2,
      atClickKm2: reach?.upstreamKm2,
      reachM: Math.round(reach?.distanceM ?? 0),
      click,
      lineKm2,
    };
    try {
      const d = await delineate(dem, click, {
        expected: reach
          ? {
              km2: reach.upstreamKm2,
              reach: `reach ${reach.reachId}`,
              distanceM: reach.distanceM,
              head: reach.head,
            }
          : null,
        junction,
      });
      const km2 = d.areaM2 / 1e6;
      Object.assign(rec, {
        km2: Math.round(km2 * 100) / 100,
        movedM: Math.round(d.snapDistanceM),
        outcome: km2 >= 0.5 * r.upstream_km2 ? "moved" : "stayed",
      });
    } catch (e) {
      if (!(e instanceof DelineationRefused)) throw e;
      Object.assign(rec, {
        outcome: e.code === "larger_channel" ? "asked" : `refused ${e.code}`,
        offered: e.larger
          ? {
              km2: Math.round(e.larger.km2),
              m: Math.round(e.larger.distanceM),
              reach: e.larger.reachKm2 !== undefined,
            }
          : null,
      });
    }
    results.push(rec);
    console.error(JSON.stringify(rec));
    writeFileSync(out, JSON.stringify({ seed: SEED, results }, null, 1));
  }
  const tally = (o: string) =>
    results.filter((x) => (x as { outcome: string }).outcome === o).length;
  console.error(
    `${results.length} clicks: moved ${tally("moved")}, asked ${tally("asked")}, stayed ${tally("stayed")}, other ${results.length - tally("moved") - tally("asked") - tally("stayed")}`,
  );
  await db.end();
}

void main();
