"""Topographic contour lines for the landing page's background texture (issue #57).

Reads the diorama's height grid (heights.json, written by diorama.py) and
traces its contours with marching squares, so the texture is the same terrain
as the render. Stdlib only. Writes one SVG: a path per contour level, drawn in
currentColor, so the page sets the colour and the opacity (4–6 %).

    python3 scripts/landing-art/contours.py heights.json out.svg [--step 0.18]
"""

import argparse
import json
import math

ap = argparse.ArgumentParser()
ap.add_argument("heights")
ap.add_argument("out")
ap.add_argument("--step", type=float, default=0.18, help="height between contours")
ap.add_argument("--width", type=int, default=1500)
args = ap.parse_args()

grid = json.load(open(args.heights))
nx, ny, Z = grid["nx"], grid["ny"], grid["z"]
W = args.width
H = round(W * (ny - 1) / (nx - 1))
sx, sy = W / (nx - 1), H / (ny - 1)


def at(i, j):
    """Grid point → picture point (y flipped: upstream at the top)."""
    return (i * sx, H - j * sy)


def edge_point(level, a, b):
    (ia, ja, za), (ib, jb, zb) = a, b
    t = (level - za) / (zb - za)
    return at(ia + (ib - ia) * t, ja + (jb - ja) * t)


def segments(level):
    """Marching squares: the contour's pieces in each cell."""
    out = []
    for j in range(ny - 1):
        for i in range(nx - 1):
            c = [(i, j, Z[j][i]), (i + 1, j, Z[j][i + 1]), (i + 1, j + 1, Z[j + 1][i + 1]), (i, j + 1, Z[j + 1][i])]
            crossings = []
            for k in range(4):
                a, b = c[k], c[(k + 1) % 4]
                if (a[2] < level) != (b[2] < level):
                    crossings.append(edge_point(level, a, b))
            # Two crossings: one piece; four (a saddle): pair them in order.
            for k in range(0, len(crossings) - 1, 2):
                out.append((crossings[k], crossings[k + 1]))
    return out


def key(p):
    return (round(p[0], 3), round(p[1], 3))


def chain(segs):
    """Join the pieces end to end into polylines."""
    ends = {}
    for s in segs:
        for p in s:
            ends.setdefault(key(p), []).append(s)
    used, lines = set(), []
    for s in segs:
        if id(s) in used:
            continue
        used.add(id(s))
        line = [s[0], s[1]]
        for forward in (True, False):
            while True:
                tip = line[-1] if forward else line[0]
                nxt = next((t for t in ends.get(key(tip), []) if id(t) not in used), None)
                if nxt is None:
                    break
                used.add(id(nxt))
                far = nxt[1] if key(nxt[0]) == key(tip) else nxt[0]
                if forward:
                    line.append(far)
                else:
                    line.insert(0, far)
        lines.append(line)
    return lines


def simplify(pts, tol=1.2):
    """Ramer–Douglas–Peucker."""
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    L = math.hypot(x2 - x1, y2 - y1) or 1e-9
    far, idx = 0.0, 0
    for k in range(1, len(pts) - 1):
        x0, y0 = pts[k]
        d = abs((y2 - y1) * x0 - (x2 - x1) * y0 + x2 * y1 - y2 * x1) / L
        if d > far:
            far, idx = d, k
    if far <= tol:
        return [pts[0], pts[-1]]
    return simplify(pts[: idx + 1], tol)[:-1] + simplify(pts[idx:], tol)


lo = min(min(r) for r in Z)
hi = max(max(r) for r in Z)
paths = []
level = math.ceil(lo / args.step) * args.step
n = 0
while level < hi:
    d = []
    for line in chain(segments(level)):
        pts = simplify(line)
        if len(pts) < 3 and math.dist(pts[0], pts[-1]) < 12:
            continue  # specks
        d.append("M" + " ".join(f"{x:.0f} {y:.0f}" for x, y in pts))
    if d:
        # Every fifth line is an index contour, drawn heavier (as on a map).
        width = 1.6 if n % 5 == 0 else 0.9
        paths.append(f'<path d="{" ".join(d)}" stroke-width="{width}"/>')
    level += args.step
    n += 1

with open(args.out, "w") as f:
    f.write(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" fill="none" stroke="currentColor" '
        f'stroke-linecap="round" stroke-linejoin="round">\n'
        + "\n".join(paths)
        + "\n</svg>\n"
    )
print(f"contours: {len(paths)} levels, {W} × {H}")
