// Research harness (docs/design/delineation-snapping.md § The head of a
// reach): clicks one vertex below the top of HydroRIVERS head reaches
// (nothing flows into them) of 10–50 km², each through the app's own path
// (reachFor, then delineate with the options routes.ts passes), scored by
// how far the outlet slid along the reach's line from the click (+ is
// downstream):
//   - matched: placed by the area match, with its slide;
//   - gully: snapped to a channel under a tenth of the area at the click;
//   - snapped: snapped otherwise; asked: refused `larger_channel`.
// `--constant` drops the reach's `head` hint, so its upper end counts as
// HydroRIVERS' 10 km² (reach.ts HEAD_KM2) as before delineate-11; without
// it, the DEM's own area there (place.ts expectedOnGrid).
// Run by hand against the operator's local stack (not CI):
//
//   DEM_URL=http://localhost:9002/tiles/terrain.pmtiles \
//   tsx --env-file=.env.development scripts/research/snap-head.ts <out.json> [--n 30] [--seed head-1] [--constant]
import { writeFileSync } from "node:fs";
import pg from "pg";
import { configuredDem } from "../../src/delineation/dem.js";
import {
  delineate,
  DelineationRefused,
} from "../../src/delineation/delineate.js";
import {
  confluenceChoices,
  fractionAlong,
  reachesNear,
  reachFor,
} from "../../src/delineation/reach.js";

const args = process.argv.slice(2);
const out = args[0] ?? "";
if (!out)
  throw new Error(
    "usage: snap-head.ts <out.json> [--n 30] [--seed head-1] [--constant]",
  );
const opt = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1]! : d;
};
const N = Number(opt("--n", "30"));
const SEED = opt("--seed", "head-1");
const CONSTANT = args.includes("--constant");

type P = [number, number];

/** Whether p lies inside the ring (even-odd). */
function inside(p: P, ring: P[]): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** The line's length (m), on a local equirectangular plane. */
function lengthM(line: P[]): number {
  let t = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const kx = 111320 * Math.cos((line[i]![1] * Math.PI) / 180);
    t += Math.hypot(
      (line[i + 1]![0] - line[i]![0]) * kx,
      (line[i + 1]![1] - line[i]![1]) * 110950,
    );
  }
  return t;
}

async function main() {
  const dem = configuredDem();
  if (!dem) throw new Error("DEM_URL is empty");
  // Owner connection: the reference tables are read as their owner (no app user here).
  const db = new pg.Client({
    connectionString:
      process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL,
  });
  await db.connect();
  // Head reaches: no other reach's lower end at its upper end (HydroRIVERS lines run downstream, single LineStrings).
  const { rows } = await db.query<{
    reach_id: string;
    upstream_km2: number;
    coords: P[];
  }>(
    `SELECT r.reach_id::text, r.upstream_km2, r.geometry->'coordinates' AS coords FROM river_reference r
		  WHERE r.dataset = 'HydroRIVERS-v10' AND r.upstream_km2 BETWEEN 10 AND 50
		    AND r.geometry->>'type' = 'LineString' AND jsonb_array_length(r.geometry->'coordinates') >= 3
		    AND r.min_lat > -34.5 AND r.max_lat < -22.5 AND r.min_lon > 17 AND r.max_lon < 32.5
		    AND NOT EXISTS (
		      SELECT 1 FROM river_reference u
		       WHERE u.dataset = r.dataset AND u.reach_id <> r.reach_id
		         AND u.geometry->>'type' = 'LineString'
		         AND u.max_lon >= (r.geometry->'coordinates'->0->>0)::float8 - 1e-6 AND u.min_lon <= (r.geometry->'coordinates'->0->>0)::float8 + 1e-6
		         AND u.max_lat >= (r.geometry->'coordinates'->0->>1)::float8 - 1e-6 AND u.min_lat <= (r.geometry->'coordinates'->0->>1)::float8 + 1e-6
		         AND abs((u.geometry->'coordinates'->-1->>0)::float8 - (r.geometry->'coordinates'->0->>0)::float8) <= 1e-6
		         AND abs((u.geometry->'coordinates'->-1->>1)::float8 - (r.geometry->'coordinates'->0->>1)::float8) <= 1e-6)
		  ORDER BY md5(r.reach_id::text || $1) LIMIT $2`,
    [SEED, N * 4],
  );
  const results: Record<string, unknown>[] = [];
  for (const r of rows) {
    if (results.length >= N) break;
    const click = r.coords[1]!;
    const near = await reachesNear(db as never, click);
    if (String(near[0]?.reachId) !== r.reach_id || confluenceChoices(click, near))
      continue;
    const { reach, junction } = await reachFor(db as never, click, null);
    if (!reach?.head) continue;
    const len = lengthM(r.coords);
    const at = fractionAlong(click, r.coords);
    const rec: Record<string, unknown> = {
      reach: r.reach_id,
      reachKm2: r.upstream_km2,
      atClickKm2: Math.round(reach.upstreamKm2 * 100) / 100,
      lengthM: Math.round(len),
      click,
    };
    try {
      const d = await delineate(dem, click, {
        expected: {
          km2: reach.upstreamKm2,
          reach: `reach ${reach.reachId}`,
          distanceM: reach.distanceM,
          head: CONSTANT ? null : reach.head,
        },
        junction,
      });
      const km2 = d.areaM2 / 1e6;
      const how = d.method.includes("best matches")
        ? "matched"
        : km2 < 0.1 * reach.upstreamKm2
          ? "gully"
          : "snapped";
      const m = /best matches [^(]*\(([\d ,.]+) km²/.exec(d.method);
      Object.assign(rec, {
        km2: Math.round(km2 * 100) / 100,
        expectedKm2: m ? Number(m[1]!.replace(/[ ,]/g, "")) : null,
        movedM: Math.round(d.snapDistanceM),
        slideM: Math.round((fractionAlong(d.outlet as P, r.coords) - at) * len),
        // The click inside the outlet's catchment: the outlet is on the click's own flow path, downstream of it.
        below: inside(click, d.geometry.coordinates[0] as P[]),
        outcome: how,
      });
    } catch (e) {
      if (!(e instanceof DelineationRefused)) throw e;
      Object.assign(rec, {
        outcome: e.code === "larger_channel" ? "asked" : `refused ${e.code}`,
      });
    }
    results.push(rec);
    console.error(JSON.stringify(rec));
    writeFileSync(out, JSON.stringify({ seed: SEED, constant: CONSTANT, results }, null, 1));
  }
  const of = (o: string) => results.filter((x) => x.outcome === o);
  const slides = of("matched").map((x) => x.slideM as number).sort((a, b) => a - b);
  const abs = slides.map(Math.abs).sort((a, b) => a - b);
  const med = (v: number[]) => (v.length ? v[Math.floor((v.length - 1) / 2)]! : NaN);
  const m = of("matched");
  const far = (x: Record<string, unknown>) => (x.movedM as number) > 250;
  console.error(
    `matched: within 250 m ${m.filter((x) => !far(x)).length}, slid down its own channel over 250 m ${m.filter((x) => far(x) && x.below).length}, moved over 250 m elsewhere ${m.filter((x) => far(x) && !x.below).length}`,
  );
  console.error(
    `${results.length} clicks: matched ${slides.length} (over 250 m: ${abs.filter((v) => v > 250).length}; median slide ${med(slides)} m, median |slide| ${med(abs)} m), gully ${of("gully").length}, snapped ${of("snapped").length}, asked ${of("asked").length}, other ${results.length - slides.length - of("gully").length - of("snapped").length - of("asked").length}`,
  );
  await db.end();
}

void main();
