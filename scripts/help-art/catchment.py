"""Illustrated catchment for the /help landing page, rendered with Blender.

A diorama of one small invented catchment, cut out of the ground like a block:
mountains with rain clouds at the back, a river down the valley, two farm dams
joined by a transfer pipeline, an orchard and a vineyard, a farmhouse, and the
weir with its gauging hut at the outlet in front. Everything is procedural, so
a run is reproducible and the scene can be changed in code.

Besides the picture it writes the 2D position (as % of the image) of each
labelled feature, projected through the same camera, so the page's numbered
hotspots always sit on the thing they describe.

Run through bin/gen-help-art.sh (pnpm gen:help-art), or directly:

    blender -b --factory-startup --python scripts/help-art/catchment.py -- \
        --out /tmp/catchment.png --hotspots /tmp/hotspots.json \
        [--width 1600] [--samples 96] [--device OPTIX|CUDA|CPU]
"""

import argparse
import json
import math
import random
import sys

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector
from mathutils.noise import fractal

# --------------------------------------------------------------------------
# Arguments
# --------------------------------------------------------------------------
argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--out", required=True)
ap.add_argument("--hotspots", required=True)
ap.add_argument("--width", type=int, default=1600)
ap.add_argument("--samples", type=int, default=96)
ap.add_argument("--device", default="OPTIX")
args = ap.parse_args(argv)

random.seed(7)

# --------------------------------------------------------------------------
# Terrain: one height function, reused to place everything on the ground
# --------------------------------------------------------------------------
X0, X1, Y0, Y1 = -6.0, 6.0, -4.0, 4.0  # block footprint (y+ = upstream)
BASE = -1.1  # bottom of the diorama block


def river_x(y):
    """Main river's centre line: meanders from the headwaters to the outlet."""
    return 0.9 * math.sin(0.55 * y + 0.4) - 0.2


def trib(y):
    """Left tributary from the mountains, joining the river near y = 0.3."""
    t = (y - 0.3) / (Y1 - 0.3)
    return river_x(0.3) + (-4.6 - river_x(0.3)) * t**0.8


DAMS = {
    # name: (centre x, centre y, radius x, radius y, water level)
    "left": (-2.55, 2.0, 0.85, 0.55, 0.0),
    "right": (3.05, -0.35, 0.8, 0.55, 0.0),
}


def smoothstep(e0, e1, v):
    t = min(max((v - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def raw_height(x, y):
    # Rising towards the back, mountains along the back edge.
    h = 0.18 * (y - Y0)
    h += 1.9 * smoothstep(1.2, 3.8, y) * (0.75 + 0.45 * fractal(Vector((x * 0.45, y * 0.45, 3.1)), 0.6, 2.1, 4))
    # Side ridges.
    h += 0.7 * smoothstep(3.6, 6.0, abs(x)) * (0.8 + 0.3 * fractal(Vector((x * 0.6, y * 0.6, 7.3)), 0.6, 2.0, 3))
    # Gentle undulation everywhere.
    h += 0.12 * fractal(Vector((x * 0.9, y * 0.9, 1.7)), 0.5, 2.0, 4)
    # The valley the river runs in, and its channel.
    d = abs(x - river_x(y))
    h -= 0.55 * math.exp(-(d * d) / (2 * 1.5**2))
    h -= 0.14 * math.exp(-(d * d) / (2 * 0.16**2))
    # The tributary's valley and channel (upstream of the confluence only).
    if y > 0.3:
        dt = abs(x - trib(y))
        h -= 0.35 * math.exp(-(dt * dt) / (2 * 0.8**2)) * smoothstep(0.3, 1.0, y)
        h -= 0.1 * math.exp(-(dt * dt) / (2 * 0.13**2)) * smoothstep(0.3, 0.8, y)
    return h


def dam_level(name):
    cx, cy, *_ = DAMS[name]
    return raw_height(cx, cy) + 0.05


for _name in DAMS:
    cx, cy, rx, ry, _ = DAMS[_name]
    DAMS[_name] = (cx, cy, rx, ry, dam_level(_name))


def height(x, y):
    h = raw_height(x, y)
    # Each dam's basin: the ground inside the ellipse drops below the water.
    for cx, cy, rx, ry, level in DAMS.values():
        e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
        if e < 1.6:
            floor = level - 0.12 * (1 - min(e, 1.0))
            h = min(h, floor + (h - floor) * smoothstep(1.0, 1.6, e))
    return h


def ground(x, y, lift=0.0):
    return Vector((x, y, height(x, y) + lift))


# --------------------------------------------------------------------------
# Scene
# --------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def material(name, color, rough=0.8, **kw):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*color, 1.0)
    p.inputs["Roughness"].default_value = rough
    for k, v in kw.items():
        p.inputs[k].default_value = v
    return m


def srgb(hexstr):
    """Hex sRGB → linear RGB tuple."""
    c = [int(hexstr[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def mesh_object(name, verts, faces, mat, smooth=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    if smooth:
        me.shade_smooth()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    return ob


# ---- the ground block, with vertex colours by height, slope and land use --
N, M = 240, 160
xs = np.linspace(X0, X1, N)
ys = np.linspace(Y0, Y1, M)
H = np.array([[height(x, y) for x in xs] for y in ys])

verts = [(x, y, H[j, i]) for j, y in enumerate(ys) for i, x in enumerate(xs)]
faces = [(j * N + i, j * N + i + 1, (j + 1) * N + i + 1, (j + 1) * N + i) for j in range(M - 1) for i in range(N - 1)]
top = len(verts)
# Skirt: the cut sides of the block, down to BASE.
ring = (
    [(0, i) for i in range(N)]
    + [(j, N - 1) for j in range(1, M)]
    + [(M - 1, i) for i in range(N - 2, -1, -1)]
    + [(j, 0) for j in range(M - 2, 0, -1)]
)
for j, i in ring:
    verts.append((xs[i], ys[j], BASE))
R = len(ring)
side_faces = []
for k in range(R):
    j0, i0 = ring[k]
    j1, i1 = ring[(k + 1) % R]
    side_faces.append((j0 * N + i0, top + k, top + (k + 1) % R, j1 * N + i1))
bottom = [top + k for k in range(R)][::-1]

GRASS = np.array(srgb("#7da04a"))
DRY = np.array(srgb("#b7ab6a"))
FYNBOS = np.array(srgb("#6f7d4f"))
ROCK = np.array(srgb("#8d877c"))
RIVERBANK = np.array(srgb("#4f7f3a"))


def land_colour(x, y, z, slope):
    d = abs(x - river_x(y))
    c = GRASS * (1 - smoothstep(0.2, 1.2, z)) + DRY * smoothstep(0.2, 1.2, z)
    c = c * (1 - smoothstep(1.0, 2.0, z)) + FYNBOS * smoothstep(1.0, 2.0, z)
    c = c * (1 - smoothstep(2.1, 2.8, z)) + ROCK * smoothstep(2.1, 2.8, z)
    # Steep ground is rock, except the banks the dams' basins cut.
    basin = min(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 for cx, cy, rx, ry, _ in DAMS.values())
    rock = smoothstep(0.35, 0.7, slope) * smoothstep(1.6, 2.4, basin)
    c = c * (1 - rock) + ROCK * rock
    wet = math.exp(-(d * d) / (2 * 0.45**2))
    c = c * (1 - wet) + RIVERBANK * wet
    n = 0.06 * fractal(Vector((x * 3.0, y * 3.0, 5.0)), 0.5, 2.0, 3)
    return np.clip(c * (1 + n), 0, 1)


gy, gx = np.gradient(H, ys, xs)
slope = np.sqrt(gx**2 + gy**2) / 3.0
land = mesh_object("Land", verts, faces + side_faces + [tuple(bottom)], material("land", (1, 1, 1), 0.9))
ca = land.data.color_attributes.new("col", "FLOAT_COLOR", "POINT")
SOIL_TOP = np.array(srgb("#6b4a2f"))
SOIL_LOW = np.array(srgb("#3f2c1d"))
for vi, (x, y, z) in enumerate(verts):
    if vi < top:
        j, i = divmod(vi, N)
        c = land_colour(x, y, z, slope[j, i])
    else:
        c = SOIL_LOW
    ca.data[vi].color = (*c, 1.0)
# The cut sides: a soil gradient from the surface down, via a second material.
soil = bpy.data.materials.new("soil")
soil.use_nodes = True
nt = soil.node_tree
p = nt.nodes["Principled BSDF"]
p.inputs["Roughness"].default_value = 0.95
geo = nt.nodes.new("ShaderNodeNewGeometry")
sep = nt.nodes.new("ShaderNodeSeparateXYZ")
ramp = nt.nodes.new("ShaderNodeValToRGB")
mapr = nt.nodes.new("ShaderNodeMapRange")
mapr.inputs["From Min"].default_value = BASE
mapr.inputs["From Max"].default_value = 1.0
ramp.color_ramp.elements[0].color = (*SOIL_LOW, 1)
ramp.color_ramp.elements[1].color = (*SOIL_TOP, 1)
ramp.color_ramp.elements.new(0.62).color = (*srgb("#8a6a45"), 1)
nt.links.new(geo.outputs["Position"], sep.inputs[0])
nt.links.new(sep.outputs["Z"], mapr.inputs["Value"])
nt.links.new(mapr.outputs["Result"], ramp.inputs["Fac"])
nt.links.new(ramp.outputs["Color"], p.inputs["Base Color"])
land.data.materials.append(soil)
for poly in land.data.polygons:
    if poly.index >= len(faces):
        poly.material_index = 1
        poly.use_smooth = False
# Surface material reads the vertex colours.
lm = land.data.materials[0]
attr = lm.node_tree.nodes.new("ShaderNodeVertexColor")
attr.layer_name = "col"
lm.node_tree.links.new(attr.outputs["Color"], lm.node_tree.nodes["Principled BSDF"].inputs["Base Color"])

# ---- water -------------------------------------------------------------------
WATER = material("water", srgb("#2f86c4"), 0.08, **{"Specular IOR Level": 0.6})


def ribbon(name, path, width, lift=0.02, clip=None):
    """A flat strip of water following `path` (list of (x, y)) at channel level."""
    vs, fs = [], []
    for k, (x, y) in enumerate(path):
        x2, y2 = path[min(k + 1, len(path) - 1)]
        x1, y1 = path[max(k - 1, 0)]
        tx, ty = x2 - x1, y2 - y1
        L = math.hypot(tx, ty) or 1
        nx, ny = -ty / L, tx / L
        w = width(k / (len(path) - 1)) if callable(width) else width
        z = height(x, y) + lift
        vs += [(x + nx * w, y + ny * w, z), (x - nx * w, y - ny * w, z)]
        if k:
            a = 2 * (k - 1)
            fs.append((a, a + 1, a + 3, a + 2))
    return mesh_object(name, vs, fs, WATER)


main = [(river_x(y), y) for y in np.linspace(Y1 - 0.25, Y0, 220)]
ribbon("River", main, lambda t: 0.05 + 0.1 * t, lift=0.03)
tri = [(trib(y), y) for y in np.linspace(Y1 - 0.25, 0.3, 90)]
ribbon("Tributary", tri, 0.055)

dam_walls = material("concrete", srgb("#c9c4ba"), 0.7)
for name, (cx, cy, rx, ry, level) in DAMS.items():
    vs = [(cx, cy, level)]
    K = 64
    for k in range(K):
        a = 2 * math.pi * k / K
        wob = 1 + 0.06 * math.sin(3 * a + 1)
        vs.append((cx + rx * wob * math.cos(a), cy + ry * wob * math.sin(a), level))
    fs = [(0, 1 + k, 1 + (k + 1) % K) for k in range(K)]
    mesh_object(f"Dam {name}", vs, fs, WATER)
    # The dam wall on the downstream (front) side: a low curved embankment.
    wall = []
    for k in range(25):
        a = math.pi * (1.15 + 0.7 * k / 24)
        wall.append((cx + rx * 1.08 * math.cos(a), cy + ry * 1.12 * math.sin(a)))
    wv, wf = [], []
    for k, (x, y) in enumerate(wall):
        z0 = min(height(x, y), level) - 0.05
        wv += [(x, y, z0), (x, y, level + 0.06)]
        if k:
            a = 2 * (k - 1)
            wf.append((a, a + 2, a + 3, a + 1))
    w = mesh_object(f"Wall {name}", wv, wf, dam_walls, smooth=False)
    mod = w.modifiers.new("solid", "SOLIDIFY")
    mod.thickness = 0.09

# ---- fields: an orchard and a vineyard -----------------------------------------
LEAF = material("leaf", srgb("#3f7a2e"), 0.85)
LEAF2 = material("leaf2", srgb("#5c8f34"), 0.85)
TRUNK = material("trunk", srgb("#5a4030"), 0.9)
VINE = material("vine", srgb("#7a9a3a"), 0.85)
FIELD = material("field", srgb("#9c8a5a"), 0.95)

bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.085)
tree_proto = bpy.context.object
tree_proto.data.materials.append(LEAF)
tree_proto.data.shade_smooth()
bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=0.015, depth=0.09)
trunk_proto = bpy.context.object
trunk_proto.data.materials.append(TRUNK)

ORCHARD = (-4.2, -2.4, -1.2, 0.4)  # x0, x1, y0, y1: below the left dam
for x in np.arange(ORCHARD[0], ORCHARD[1], 0.22):
    for y in np.arange(ORCHARD[2], ORCHARD[3], 0.24):
        z = height(x, y)
        t = tree_proto.copy()
        t.location = (x, y, z + 0.11 + random.uniform(-0.01, 0.01))
        s = random.uniform(0.85, 1.15)
        t.scale = (s, s, s * 0.9)
        if random.random() < 0.3:
            t.data = tree_proto.data.copy()
            t.data.materials[0] = LEAF2
        scene.collection.objects.link(t)
        tr = trunk_proto.copy()
        tr.location = (x, y, z + 0.04)
        scene.collection.objects.link(tr)

VINEYARD = (1.7, 4.4, -2.9, -1.35)  # below the right dam
for y in np.arange(VINEYARD[2], VINEYARD[3], 0.13):
    row = []
    for x in np.linspace(VINEYARD[0], VINEYARD[1], 40):
        row.append((x, y))
    vs, fs = [], []
    for k, (x, y2) in enumerate(row):
        z = height(x, y2)
        vs += [(x, y2 - 0.035, z + 0.005), (x, y2 + 0.035, z + 0.005), (x, y2 - 0.03, z + 0.075), (x, y2 + 0.03, z + 0.075)]
        if k:
            a = 4 * (k - 1)
            fs += [(a, a + 4, a + 6, a + 2), (a + 1, a + 3, a + 7, a + 5), (a + 2, a + 6, a + 7, a + 3)]
    mesh_object("Vines", vs, fs, VINE)
# Bushes: riparian trees along the river, and fynbos scattered on the slopes.
BUSH = material("bush", srgb("#556b35"), 0.9)
bush_data = tree_proto.data.copy()
bush_data.materials[0] = BUSH


def clear_of_features(x, y):
    for cx, cy, rx, ry, _ in DAMS.values():
        if ((x - cx) / (rx + 0.3)) ** 2 + ((y - cy) / (ry + 0.3)) ** 2 < 1:
            return False
    for x0, x1, y0, y1 in (ORCHARD, VINEYARD):
        if x0 - 0.2 < x < x1 + 0.2 and y0 - 0.2 < y < y1 + 0.2:
            return False
    return True


for y in np.arange(Y0 + 0.8, Y1 - 1.2, 0.17):
    for side in (-1, 1):
        if random.random() < 0.55:
            x = river_x(y) + side * random.uniform(0.2, 0.34)
            if clear_of_features(x, y):
                t = tree_proto.copy()
                t.data = bush_data
                s2 = random.uniform(0.7, 1.1)
                t.scale = (s2, s2, s2 * 1.2)
                t.location = (x, y, height(x, y) + 0.07)
                scene.collection.objects.link(t)
for _ in range(260):
    x, y = random.uniform(X0 + 0.2, X1 - 0.2), random.uniform(Y0 + 0.2, Y1 - 0.2)
    z = height(x, y)
    if 0.5 < z < 2.3 and clear_of_features(x, y) and abs(x - river_x(y)) > 0.5:
        t = tree_proto.copy()
        t.data = bush_data
        s2 = random.uniform(0.35, 0.6)
        t.scale = (s2, s2, s2 * 0.8)
        t.location = (x, y, z + 0.03)
        scene.collection.objects.link(t)

tree_proto.hide_render = trunk_proto.hide_render = True
tree_proto.location = trunk_proto.location = (0, 0, -50)

# ---- farmhouse ---------------------------------------------------------------
WALL = material("house", srgb("#f2efe6"), 0.7)
ROOF = material("roof", srgb("#8e3b2e"), 0.6)
hx, hy = -1.55, -2.25
hz = height(hx, hy)
bpy.ops.mesh.primitive_cube_add(size=1, location=(hx, hy, hz + 0.09))
house = bpy.context.object
house.scale = (0.34, 0.2, 0.18)
house.data.materials.append(WALL)
bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.27, depth=0.14, location=(hx, hy, hz + 0.25))
roof = bpy.context.object
roof.scale = (1.3, 0.8, 1)
roof.rotation_euler = (0, 0, math.pi / 4)
roof.data.materials.append(ROOF)

# ---- transfer pipeline, left dam → right dam, on low piers ---------------------
PIPE = material("pipe", srgb("#d4d1c9"), 0.35, Metallic=0.6)
l_cx, l_cy, l_rx, _, l_lvl = DAMS["left"]
r_cx, r_cy, r_rx, _, r_lvl = DAMS["right"]
a = Vector((l_cx + l_rx * 0.7, l_cy - 0.3, 0))
b = Vector((r_cx - r_rx * 0.8, r_cy + 0.15, 0))
pts = []
for k in range(60):
    t = k / 59
    p2 = a.lerp(b, t) + Vector((0, 0.35 * math.sin(math.pi * t), 0))
    pts.append(Vector((p2.x, p2.y, max(height(p2.x, p2.y), min(l_lvl, r_lvl) - 0.2) + 0.09)))
curve = bpy.data.curves.new("pipe", "CURVE")
curve.dimensions = "3D"
curve.bevel_depth = 0.028
curve.bevel_resolution = 3
spl = curve.splines.new("POLY")
spl.points.add(len(pts) - 1)
for k, p3 in enumerate(pts):
    spl.points[k].co = (*p3, 1)
pipe = bpy.data.objects.new("Pipeline", curve)
pipe.data.materials.append(PIPE)
scene.collection.objects.link(pipe)
for k in range(4, 60, 7):
    p3 = pts[k]
    g = height(p3.x, p3.y)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(p3.x, p3.y, (g + p3.z) / 2))
    pier = bpy.context.object
    pier.scale = (0.035, 0.035, max(p3.z - g, 0.02))
    pier.data.materials.append(dam_walls)

# ---- irrigation lines: each dam feeds its field -----------------------------------
IRRIG = material("irrigation", srgb("#2d5f86"), 0.5)


def ground_line(name, p0, p1, radius, mat):
    c = bpy.data.curves.new(name, "CURVE")
    c.dimensions = "3D"
    c.bevel_depth = radius
    sp = c.splines.new("POLY")
    n = 30
    sp.points.add(n - 1)
    for k in range(n):
        x = p0[0] + (p1[0] - p0[0]) * k / (n - 1)
        y = p0[1] + (p1[1] - p0[1]) * k / (n - 1)
        sp.points[k].co = (x, y, height(x, y) + radius, 1)
    ob = bpy.data.objects.new(name, c)
    ob.data.materials.append(mat)
    scene.collection.objects.link(ob)


ground_line("Irrigation left", (l_cx - 0.5, l_cy - 0.5), ((ORCHARD[0] + ORCHARD[1]) / 2, ORCHARD[3] + 0.05), 0.018, IRRIG)
ground_line("Irrigation right", (r_cx, r_cy - 0.62), ((VINEYARD[0] + VINEYARD[1]) / 2, VINEYARD[3] + 0.05), 0.018, IRRIG)

# ---- weir and gauging hut at the outlet -----------------------------------------
wy = Y0 + 0.55
wx = river_x(wy)
wz = height(wx, wy)
bpy.ops.mesh.primitive_cube_add(size=1, location=(wx, wy, wz + 0.03))
weir = bpy.context.object
weir.scale = (0.62, 0.07, 0.14)
weir.rotation_euler = (0, 0, math.atan(0.9 * 0.55 * math.cos(0.55 * wy + 0.4)))
weir.data.materials.append(dam_walls)
gx0, gy0 = wx + 0.55, wy + 0.1
gz0 = height(gx0, gy0)
bpy.ops.mesh.primitive_cube_add(size=1, location=(gx0, gy0, gz0 + 0.1))
hut = bpy.context.object
hut.scale = (0.16, 0.16, 0.2)
hut.data.materials.append(WALL)
bpy.ops.mesh.primitive_cube_add(size=1, location=(gx0, gy0, gz0 + 0.215))
hroof = bpy.context.object
hroof.scale = (0.2, 0.2, 0.03)
hroof.data.materials.append(material("hutroof", srgb("#44546a"), 0.5))

# ---- clouds and rain over the headwaters ---------------------------------------
CLOUD = material("cloud", srgb("#f4f6f8"), 1.0)
cloud_spots = [(-2.4, 3.0, 3.5), (0.4, 3.3, 3.75), (2.8, 2.6, 3.45)]
for cx, cy, cz in cloud_spots:
    mb = bpy.data.metaballs.new("cloud")
    mb.resolution = 0.06
    ob = bpy.data.objects.new("Cloud", mb)
    scene.collection.objects.link(ob)
    ob.location = (cx, cy, cz)
    for _ in range(9):
        e = mb.elements.new()
        e.co = (random.uniform(-0.8, 0.8), random.uniform(-0.35, 0.35), random.uniform(-0.05, 0.25))
        e.radius = random.uniform(0.35, 0.55)
    ob.scale = (1.0, 1.0, 0.55)
    ob.data.materials.append(CLOUD)

rain = bpy.data.materials.new("rain")
rain.use_nodes = True
rn = rain.node_tree.nodes
rl = rain.node_tree.links
out = rn["Material Output"]
rn.remove(rn["Principled BSDF"])
mix = rn.new("ShaderNodeMixShader")
mix.inputs["Fac"].default_value = 0.45
tr = rn.new("ShaderNodeBsdfTransparent")
em = rn.new("ShaderNodeEmission")
em.inputs["Color"].default_value = (*srgb("#9cc4e6"), 1)
em.inputs["Strength"].default_value = 1.2
rl.new(tr.outputs[0], mix.inputs[1])
rl.new(em.outputs[0], mix.inputs[2])
rl.new(mix.outputs[0], out.inputs["Surface"])
rain_v, rain_f = [], []
for cx, cy, cz in cloud_spots:
    for _ in range(60):
        x = cx + random.uniform(-0.9, 0.9)
        y = cy + random.uniform(-0.35, 0.35)
        z_top = cz - 0.1 - random.uniform(0, 0.1)
        z_bot = max(height(x, y) + 0.1, z_top - random.uniform(1.0, 1.8))
        # Each drop's fall is drawn as short dashes, slanted by the wind.
        z = z_top - random.uniform(0, 0.15)
        while z - 0.12 > z_bot:
            k = len(rain_v)
            w = 0.007
            dx = 0.08 * (z_top - z)
            rain_v += [(x - dx - w, y, z), (x - dx + w, y, z), (x - dx - 0.01 + w, y, z - 0.12), (x - dx - 0.01 - w, y, z - 0.12)]
            rain_f.append((k, k + 1, k + 2, k + 3))
            z -= random.uniform(0.2, 0.3)
mesh_object("Rain", rain_v, rain_f, rain, smooth=False)

# ---- sun (evaporation) -------------------------------------------------------------
sun_mat = bpy.data.materials.new("sunball")
sun_mat.use_nodes = True
sn = sun_mat.node_tree.nodes
sn.remove(sn["Principled BSDF"])
se = sn.new("ShaderNodeEmission")
se.inputs["Color"].default_value = (*srgb("#ff9f0a"), 1)
se.inputs["Strength"].default_value = 1.25
sun_mat.node_tree.links.new(se.outputs[0], sn["Material Output"].inputs["Surface"])
SUN_AT = Vector((4.1, 3.6, 4.0))
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.46, location=SUN_AT, segments=32, ring_count=16)
sunball = bpy.context.object
sunball.data.materials.append(sun_mat)
sunball.visible_shadow = False

# --------------------------------------------------------------------------
# Light, camera, render settings
# --------------------------------------------------------------------------
world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs["Color"].default_value = (*srgb("#cfe3f2"), 1)
bg.inputs["Strength"].default_value = 0.9

bpy.ops.object.light_add(type="SUN", rotation=(math.radians(48), math.radians(12), math.radians(35)))
sun = bpy.context.object
sun.data.energy = 3.2
sun.data.angle = math.radians(4)

bpy.ops.object.camera_add(location=(10.2, -14.6, 10.6))
cam = bpy.context.object
cam.data.lens = 44
target = bpy.data.objects.new("target", None)
target.location = (0.1, 0.5, 0.9)
scene.collection.objects.link(target)
track = cam.constraints.new("TRACK_TO")
track.target = target
track.track_axis = "TRACK_NEGATIVE_Z"
track.up_axis = "UP_Y"
scene.camera = cam

scene.render.engine = "CYCLES"
scene.cycles.samples = args.samples
scene.cycles.use_denoising = True
scene.render.film_transparent = True
scene.render.resolution_x = args.width
scene.render.resolution_y = round(args.width * 0.62)
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"
if args.device != "CPU":
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = args.device
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == args.device
    scene.cycles.device = "GPU"

# --------------------------------------------------------------------------
# Crop to the scene: project everything visible through the camera and render
# only that box (plus a small margin), so the picture has no empty border.
# The output keeps the requested width.
# --------------------------------------------------------------------------
bpy.context.view_layer.update()
deps = bpy.context.evaluated_depsgraph_get()
pts2d = []
for ob in scene.objects:
    if ob.hide_render or ob.type not in {"MESH", "CURVE", "META"}:
        continue
    if ob.name == "Land":
        vs_ = ob.data.vertices
        co = [ob.matrix_world @ vs_[i].co for i in range(0, len(vs_), 7)]
    else:
        co = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    pts2d += [world_to_camera_view(scene, cam, c) for c in co]
M_ = 0.02
bx0 = max(min(p2.x for p2 in pts2d) - M_, 0.0)
bx1 = min(max(p2.x for p2 in pts2d) + M_, 1.0)
by0 = max(min(p2.y for p2 in pts2d) - M_, 0.0)
by1 = min(max(p2.y for p2 in pts2d) + M_, 1.0)
full_w = round(args.width / (bx1 - bx0))
scene.render.resolution_x = full_w
scene.render.resolution_y = round(full_w * 0.62)
scene.render.use_border = True
scene.render.use_crop_to_border = True
scene.render.border_min_x, scene.render.border_max_x = bx0, bx1
scene.render.border_min_y, scene.render.border_max_y = by0, by1
out_w = round(full_w * (bx1 - bx0))
out_h = round(scene.render.resolution_y * (by1 - by0))

# --------------------------------------------------------------------------
# Hotspots: each labelled feature's position in the cropped image, in %
# --------------------------------------------------------------------------
mid_pipe = pts[len(pts) // 2]
anchors = {
    "rain": Vector((0.4, 3.1, 2.7)),
    "evaporation": SUN_AT,
    "runoff": ground(-4.4, 3.2, 0.05),
    "dam": Vector((l_cx, l_cy, l_lvl)),
    "irrigation": ground((ORCHARD[0] + ORCHARD[1]) / 2, (ORCHARD[2] + ORCHARD[3]) / 2, 0.2),
    "transfer": mid_pipe,
    "river": ground(river_x(-1.7), -1.7, 0.02),
    "outlet": ground(wx, wy, 0.1),
}
spots = {}
for key, co in anchors.items():
    v = world_to_camera_view(scene, cam, co)
    x = (v.x - bx0) / (bx1 - bx0)
    y = (by1 - v.y) / (by1 - by0)
    assert 0 < x < 1 and 0 < y < 1, f"hotspot {key} is outside the picture: {(x, y)}"
    spots[key] = {"x": round(x * 100, 1), "y": round(y * 100, 1)}
with open(args.hotspots, "w") as f:
    json.dump({"width": out_w, "height": out_h, "spots": spots}, f, indent=1)
    f.write("\n")

scene.render.filepath = args.out
bpy.ops.render.render(write_still=True)
print("rendered", args.out)
