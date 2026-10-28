"""The soil water capacity grid for the regional GR4J prior (issue #622 step 2;
docs/maps.md § Soil water capacity, docs/deployment.md § Reference datasets).
Standard library only; operator-run, offline, never by the app or the ingest
Lambda.

Reads SoilGrids 2.0's water retention (ISRIC, CC BY 4.0) at its six standard
depths, water content at field capacity (``wv0033``, 33 kPa) and at wilting
point (``wv1500``, 1500 kPa), and iSDAsoil's depth to bedrock (iSDA, CC BY
4.0), all resampled by the operator onto one WGS 84 grid and written as ESRI
ASCII grids (``gdalwarp -t_srs EPSG:4326 -te 10 -35.5 41 -8 -tr 0.05 0.05
-r average``, then ``gdal_translate -of AAIGrid``; deployment.md has the
recipe). For each cell whose centre is inside the region (D1 by default):

    root depth = min(200 cm, depth to bedrock)
    PAWC (mm)  = sum over the layers 0-5, 5-15, 15-30, 30-60, 60-100, 100-200 cm
                 of max(0, wv0033 - wv1500) x (the layer's thickness inside
                 the root zone, cm) / 100

SoilGrids stores water content in 10^-3 cm3/cm3, which is mm of water per m of
soil, hence the / 100 for a thickness in cm. A cell missing a layer it needs
is left out; a cell with no bedrock value is taken as deep (root depth 200 cm,
counted in the summary: iSDAsoil masks some land); a cell with bedrock at the
surface (0 cm) holds no root zone and is left out.

Writes the JSON ``backend/src/geo/soilGrid.ts`` reads (``pnpm import:soils``
loads it; a production load takes it through load-reference.yml kind
``soils``)::

    python3 ingest/soils.py --wv0033 <dir> --wv1500 <dir> --bedrock <file.asc>
        --out soils.json.gz [--region w,s,e,n]

``<dir>`` holds the six depths as ``<prop>_<top>-<bottom>cm_mean.asc``
(SoilGrids' own names, e.g. ``wv0033_0-5cm_mean.asc``).
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import sys
from dataclasses import dataclass
from typing import Iterable, Sequence

#: SoilGrids 2.0's six standard depths, cm.
LAYERS_CM: tuple[tuple[int, int], ...] = ((0, 5), (5, 15), (15, 30), (30, 60), (60, 100), (100, 200))
#: The deepest root zone the grid describes, cm (SoilGrids' last depth).
MAX_ROOT_CM = 200.0
#: Region D1, the copy's (backend/src/mirror/grid.ts MIRROR_REGION): west, south, east, north.
REGION_D1 = (10.0, -35.5, 41.0, -8.0)

SOURCE = (
    "SoilGrids 2.0 volumetric water content at 33 kPa (wv0033) and 1500 kPa (wv1500), six depths to 200 cm "
    "(ISRIC, Turek et al. 2023, https://doi.org/10.1016/j.iswcr.2022.08.001), CC BY 4.0; depth to bedrock from "
    "iSDAsoil (iSDA, https://registry.opendata.aws/isdasoil), CC BY 4.0"
)
VERSION = "SoilGrids 2.0 (2023 water retention); iSDAsoil v1"
ATTRIBUTION = (
    "Soil water retention: SoilGrids 2.0 © ISRIC – World Soil Information, CC BY 4.0. "
    "Depth to bedrock: iSDAsoil © Innovative Solutions for Decision Agriculture (iSDA), CC BY 4.0."
)


class GridError(ValueError):
    """A grid file this reader can't take, or grids that don't line up."""


@dataclass(frozen=True)
class AsciiGrid:
    ncols: int
    nrows: int
    #: The south-west corner of the south-west cell, degrees.
    xll: float
    yll: float
    cellsize: float
    #: Row 0 is the northernmost (the file's order); None is no data.
    values: list[list[float | None]]

    def frame(self) -> tuple[int, int, float, float, float]:
        return (self.ncols, self.nrows, round(self.xll, 9), round(self.yll, 9), round(self.cellsize, 12))


def read_ascii_grid(lines: Iterable[str], name: str = "grid") -> AsciiGrid:
    """An ESRI ASCII grid (AAIGrid): the header, then nrows rows of ncols values."""
    header: dict[str, str] = {}
    it = iter(lines)
    body: list[str] = []
    for line in it:
        parts = line.split()
        if not parts:
            continue
        key = parts[0].lower()
        if key in ("ncols", "nrows", "xllcorner", "yllcorner", "xllcenter", "yllcenter", "cellsize", "nodata_value"):
            if len(parts) != 2:
                raise GridError(f"{name}: a bad header line: {line.strip()[:60]}")
            header[key] = parts[1]
            continue
        body.append(line)
        break
    try:
        ncols = int(header["ncols"])
        nrows = int(header["nrows"])
        cellsize = float(header["cellsize"])
    except (KeyError, ValueError) as e:
        raise GridError(f"{name}: no ncols, nrows and cellsize in the header") from e
    if ncols <= 0 or nrows <= 0 or not cellsize > 0:
        raise GridError(f"{name}: ncols, nrows and cellsize must be positive")
    if "xllcorner" in header and "yllcorner" in header:
        xll, yll = float(header["xllcorner"]), float(header["yllcorner"])
    elif "xllcenter" in header and "yllcenter" in header:
        xll, yll = float(header["xllcenter"]) - cellsize / 2, float(header["yllcenter"]) - cellsize / 2
    else:
        raise GridError(f"{name}: no xllcorner/yllcorner (or xllcenter/yllcenter) in the header")
    nodata = float(header["nodata_value"]) if "nodata_value" in header else None
    flat: list[float | None] = []
    for line in [*body, *it]:
        for tok in line.split():
            v = float(tok)
            flat.append(None if (nodata is not None and v == nodata) or not math.isfinite(v) else v)
    if len(flat) != ncols * nrows:
        raise GridError(f"{name}: {len(flat)} values, the header says {ncols} x {nrows}")
    values = [flat[r * ncols : (r + 1) * ncols] for r in range(nrows)]
    return AsciiGrid(ncols, nrows, xll, yll, cellsize, values)


def thickness_in_root_zone(layer: tuple[int, int], root_cm: float) -> float:
    """How many cm of the layer lie above `root_cm`."""
    top, bottom = layer
    return max(0.0, min(bottom, root_cm) - top)


def cell_pawc(wv0033: Sequence[float | None], wv1500: Sequence[float | None], root_cm: float) -> float | None:
    """One cell's PAWC (mm) to `root_cm`; None when a layer it needs has no value."""
    total = 0.0
    for i, layer in enumerate(LAYERS_CM):
        t = thickness_in_root_zone(layer, root_cm)
        if t <= 0:
            continue
        fc, wp = wv0033[i], wv1500[i]
        if fc is None or wp is None:
            return None
        total += max(0.0, fc - wp) * t / 100.0
    return total


@dataclass
class Summary:
    cells: list[list[float]]
    #: Cells inside the region left out: a layer with no value, or bedrock at the surface.
    no_value: int = 0
    at_surface: int = 0
    #: Cells kept with no bedrock value (taken as deep).
    deep_assumed: int = 0


def soil_cells(wv0033: Sequence[AsciiGrid], wv1500: Sequence[AsciiGrid], bedrock: AsciiGrid, region: tuple[float, float, float, float] = REGION_D1) -> Summary:
    """Each cell inside `region` as [lon, lat, pawcMm, rootDepthCm], west to east, north to south."""
    if len(wv0033) != len(LAYERS_CM) or len(wv1500) != len(LAYERS_CM):
        raise GridError(f"give {len(LAYERS_CM)} depths of wv0033 and of wv1500")
    frame = bedrock.frame()
    for g in (*wv0033, *wv1500):
        if g.frame() != frame:
            raise GridError("the grids aren't on one frame: resample them onto the same grid first (same ncols, nrows, corner and cellsize)")
    w, s, e, n = region
    step = bedrock.cellsize
    out = Summary(cells=[])
    for r in range(bedrock.nrows):
        lat = bedrock.yll + (bedrock.nrows - r - 0.5) * step
        if not s <= lat <= n:
            continue
        for c in range(bedrock.ncols):
            lon = bedrock.xll + (c + 0.5) * step
            if not w <= lon <= e:
                continue
            depth = bedrock.values[r][c]
            if depth is None:
                root = MAX_ROOT_CM
            elif depth <= 0:
                out.at_surface += 1
                continue
            else:
                root = min(MAX_ROOT_CM, depth)
            pawc = cell_pawc([g.values[r][c] for g in wv0033], [g.values[r][c] for g in wv1500], root)
            if pawc is None:
                out.no_value += 1
                continue
            if depth is None:
                out.deep_assumed += 1
            out.cells.append([round(lon, 6), round(lat, 6), round(min(pawc, 1000.0), 1), round(root, 1)])
    return out


def to_json(summary: Summary, cellsize: float, source: str = SOURCE, version: str = VERSION, attribution: str = ATTRIBUTION) -> str:
    return json.dumps(
        {"kind": "pawc", "cellDeg": cellsize, "source": source, "version": version, "attribution": attribution, "cells": summary.cells},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def layer_file(directory: str, prop: str, layer: tuple[int, int]) -> str:
    return os.path.join(directory, f"{prop}_{layer[0]}-{layer[1]}cm_mean.asc")


def _read(path: str) -> AsciiGrid:
    with open(path, encoding="ascii") as f:
        return read_ascii_grid(f, os.path.basename(path))


def _region(text: str) -> tuple[float, float, float, float]:
    try:
        w, s, e, n = (float(x) for x in text.split(","))
    except ValueError as err:
        raise argparse.ArgumentTypeError("--region is west,south,east,north in degrees") from err
    if not (w < e and s < n):
        raise argparse.ArgumentTypeError("--region is west,south,east,north in degrees")
    return (w, s, e, n)


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Root-zone plant-available water capacity from SoilGrids 2.0 and iSDAsoil.")
    p.add_argument("--wv0033", required=True, help="directory of wv0033_<top>-<bottom>cm_mean.asc")
    p.add_argument("--wv1500", required=True, help="directory of wv1500_<top>-<bottom>cm_mean.asc")
    p.add_argument("--bedrock", required=True, help="iSDAsoil depth to bedrock (cm) on the same grid, .asc")
    p.add_argument("--out", required=True, help="the JSON to write (.json or .json.gz)")
    p.add_argument("--region", type=_region, default=REGION_D1, help="west,south,east,north (default region D1)")
    a = p.parse_args(argv)
    if not (a.out.endswith(".json") or a.out.endswith(".json.gz")):
        p.error("--out is a .json or .json.gz file")
    try:
        fc = [_read(layer_file(a.wv0033, "wv0033", layer)) for layer in LAYERS_CM]
        wp = [_read(layer_file(a.wv1500, "wv1500", layer)) for layer in LAYERS_CM]
        summary = soil_cells(fc, wp, _read(a.bedrock), a.region)
    except (OSError, GridError, ValueError) as e:
        print(f"soils.py: {e}", file=sys.stderr)
        return 1
    if not summary.cells:
        print("soils.py: no cell inside the region has a value: check the files and --region", file=sys.stderr)
        return 1
    text = to_json(summary, fc[0].cellsize)
    if a.out.endswith(".gz"):
        with gzip.open(a.out, "wt", encoding="utf-8") as f:
            f.write(text)
    else:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
    print(
        f"{len(summary.cells)} cells written to {a.out}; left out: {summary.no_value} missing a layer, "
        f"{summary.at_surface} with bedrock at the surface; {summary.deep_assumed} with no bedrock value taken as 200 cm deep"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
