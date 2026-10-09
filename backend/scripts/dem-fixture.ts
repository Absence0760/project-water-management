// Writes the synthetic DEM delineation is tested against
// (backend/fixtures/dem/synthetic-dem.pmtiles; the terrain is defined in
// src/delineation/fixture.ts): Terrarium-encoded PNG tiles in a PMTiles
// archive, invented terrain only. Deterministic on a given zlib: re-running
// it rewrites the same bytes. dem-fixture.test.ts compares the committed file
// with it by content (header, metadata, directory, each tile's pixels), not
// by bytes, so a different zlib build can't fail it but a terrain change does.
//
//   pnpm -C backend gen:dem-fixture
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FIXTURE_BOUNDS,
  FIXTURE_FILE,
  FIXTURE_TILE,
  FIXTURE_TILES,
  FIXTURE_X0,
  FIXTURE_Y0,
  FIXTURE_ZOOM,
  fixtureElevation,
} from "../src/delineation/fixture.js";
import { writePmtiles } from "../src/delineation/pmtiles.js";
import { encodePng } from "../src/delineation/png.js";

/** Terrarium: v + 32768 = R·256 + G + B/256. */
function terrariumPixel(v: number): number {
  const t = Math.round((v + 32768) * 256);
  return (
    (0xff000000 |
      (((t >> 16) & 255) << 16) |
      (((t >> 8) & 255) << 8) |
      (t & 255)) >>>
    0
  );
}

/**
 * The fixture's bytes (the test checks the committed file still holds the same content). `elevation` is the terrain,
 * fixtureElevation unless a test passes a changed one.
 */
export function buildFixture(elevation: (x: number, y: number) => number = fixtureElevation): Buffer {
  const tiles = [];
  for (let ty = 0; ty < FIXTURE_TILES; ty++) {
    for (let tx = 0; tx < FIXTURE_TILES; tx++) {
      const argb = new Uint32Array(FIXTURE_TILE * FIXTURE_TILE);
      for (let y = 0; y < FIXTURE_TILE; y++) {
        for (let x = 0; x < FIXTURE_TILE; x++)
          argb[y * FIXTURE_TILE + x] = terrariumPixel(
            elevation(tx * FIXTURE_TILE + x, ty * FIXTURE_TILE + y),
          );
      }
      tiles.push({
        z: FIXTURE_ZOOM,
        x: FIXTURE_X0 + tx,
        y: FIXTURE_Y0 + ty,
        data: encodePng({ width: FIXTURE_TILE, height: FIXTURE_TILE, argb }),
      });
    }
  }
  return writePmtiles(tiles, {
    tileType: 2,
    bounds: FIXTURE_BOUNDS,
    metadata: {
      name: "Synthetic DEM (invented terrain, water-management test fixture)",
      version: "1",
      attribution: "synthetic",
    },
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = fileURLToPath(FIXTURE_FILE);
  const archive = buildFixture();
  writeFileSync(out, archive);
  console.log(`Wrote ${out} (${(archive.length / 1024).toFixed(0)} KiB)`);
}
