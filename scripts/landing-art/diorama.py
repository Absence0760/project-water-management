"""The landing page's catchment diorama, rendered with Blender (issue #57).

It is the help pictures' scene (scripts/help-art/catchment.py), built by
running that script with no shots, then lit twice from one camera:

  day   the help pictures' light: a blue sky and a high sun (light mode)
  dusk  a low warm sun under a deep blue sky, the sun a pale moon, a lit
        farmhouse window (dark mode)

For each lighting it writes the hero (the whole block, trimmed to it on a
transparent background) and the Open Graph card's backdrop (1200 × 630, the
block on the right, sky behind). Beside the pictures it writes overlay.json:
where the rivers, dams, clouds, gauge and farms fall in the hero, as % of the
picture, projected through the camera, so the page's SVG motion layer (rain,
the pulse down the river, the dams filling, the gauge) sits on the render;
and heights.json, the terrain's height grid, for the contour texture
(contours.py).

Run through bin/gen-landing-art.sh (pnpm gen:landing-art), or directly:

    blender -b --factory-startup --python-exit-code 1 \\
        --python scripts/landing-art/diorama.py -- --outdir /tmp/landing-art \\
        [--samples 128] [--device OPTIX|CUDA|ONEAPI|HIP|METAL|CPU] [--width 2400]

Writes <outdir>/hero-{day,dusk}.png, og-{day,dusk}.png, overlay.json and
heights.json.
"""

import argparse
import json
import math
import os
import runpy
import sys

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
ap = argparse.ArgumentParser()
ap.add_argument("--outdir", required=True)
ap.add_argument("--samples", type=int, default=128)
ap.add_argument("--device", default="OPTIX")
ap.add_argument("--width", type=int, default=2400, help="hero width in pixels")
args = ap.parse_args(argv)

# ---- the help scene, with no shots rendered --------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
HELP = os.path.join(HERE, "..", "help-art", "catchment.py")
saved_argv = sys.argv
sys.argv = [HELP, "--", "--outdir", args.outdir, "--only", "__none__", "--samples", str(args.samples), "--device", args.device]
try:
    S = runpy.run_path(HELP, run_name="__main__")
finally:
    sys.argv = saved_argv
os.remove(os.path.join(args.outdir, "shots.json"))  # the help run's (empty) report

import bpy  # noqa: E402  (after the scene exists)
from bpy_extras.object_utils import world_to_camera_view  # noqa: E402
from mathutils import Vector  # noqa: E402

scene, cam, target = S["scene"], S["cam"], S["target"]
height, ground, river_x, trib = S["height"], S["ground"], S["river_x"], S["trib"]
DAMS, ORCHARD, VINEYARD = S["DAMS"], S["ORCHARD"], S["VINEYARD"]
X0, X1, Y0, Y1 = S["X0"], S["X1"], S["Y0"], S["Y1"]
srgb, material = S["srgb"], S["material"]
wx, wy, gx0, gy0 = S["wx"], S["wy"], S["gx0"], S["gy0"]
cloud_spots, SUN_AT, sunball = S["cloud_spots"], S["SUN_AT"], S["sunball"]
hx, hy, hz = S["hx"], S["hy"], S["hz"]
np = S["np"]

# ---- the dusk rig's extra pieces, hidden by day ---------------------------
# A lit window on the farmhouse's downstream face.
glow = bpy.data.materials.new("window")
glow.use_nodes = True
gn = glow.node_tree.nodes
gn.remove(gn["Principled BSDF"])
ge = gn.new("ShaderNodeEmission")
ge.inputs["Color"].default_value = (*srgb("#ffc56b"), 1)
ge.inputs["Strength"].default_value = 6.0
glow.node_tree.links.new(ge.outputs[0], gn["Material Output"].inputs["Surface"])
windows = []
for dx in (-0.08, 0.08):
    bpy.ops.mesh.primitive_plane_add(size=1, location=(hx + dx, hy - 0.101, hz + 0.1))
    w = bpy.context.object
    w.scale = (0.045, 0.045, 1)
    w.rotation_euler = (math.pi / 2, 0, 0)
    w.data.materials.append(glow)
    windows.append(w)
# A warm lamp over the gauging hut.
bpy.ops.object.light_add(type="POINT", location=(gx0, gy0 - 0.3, height(gx0, gy0) + 0.45))
hut_lamp = bpy.context.object
hut_lamp.data.energy = 6
hut_lamp.data.color = srgb("#ffc56b")

sun = next(o for o in scene.objects if o.type == "LIGHT" and o.data.type == "SUN")
# Dusk's second light: the last of the sunset, low from the west, warm.
bpy.ops.object.light_add(type="SUN", rotation=(math.radians(80), 0, math.radians(-100)))
sunset = bpy.context.object
sunset.data.energy = 0.9
sunset.data.color = srgb("#ff9a5c")
sunset.data.angle = math.radians(6)
bg = scene.world.node_tree.nodes["Background"]
sun_emit = sunball.data.materials[0].node_tree.nodes["Emission"]


def light(mode):
    dusk = mode == "dusk"
    for w in windows:
        w.hide_render = not dusk
    hut_lamp.hide_render = not dusk
    sunset.hide_render = not dusk
    if dusk:
        # Moonlight as the key: cool, from where the day's sun is, a little lower.
        bg.inputs["Color"].default_value = (*srgb("#2a4468"), 1)
        bg.inputs["Strength"].default_value = 0.8
        sun.rotation_euler = (math.radians(52), math.radians(12), math.radians(35))
        sun.data.energy = 1.5
        sun.data.color = srgb("#b9cdee")
        sun_emit.inputs["Color"].default_value = (*srgb("#e8eef6"), 1)
        sun_emit.inputs["Strength"].default_value = 2.2
    else:
        bg.inputs["Color"].default_value = (*srgb("#cfe3f2"), 1)
        bg.inputs["Strength"].default_value = 0.9
        sun.rotation_euler = (math.radians(48), math.radians(12), math.radians(35))
        sun.data.energy = 3.2
        sun.data.color = (1, 1, 1)
        sun_emit.inputs["Color"].default_value = (*srgb("#ff9f0a"), 1)
        sun_emit.inputs["Strength"].default_value = 1.25


# ---- the hero camera: the help landing shot, a little higher and wider ----
# Wide enough that the whole block is inside the frame: at 42 mm, aimed at
# (0, 0.2, 0.8), the block's front corner fell 16 % of the frame below the
# bottom edge and scene_crop's clamp cut it off. Measured through the camera,
# this framing puts everything between 3 % and 95 % of the frame's height, so
# the crop's 2 % margin never meets an edge; modules.mjs fails the run if the
# hero's outermost rows or columns hold anything.
HERO = dict(loc=(10.8, -14.2, 11.8), target=(0.0, -0.4, -0.1), lens=35)
OG = dict(loc=(13.4, -15.8, 12.0), target=(-3.2, 0.2, 0.6), lens=36)


def aim(shot):
    cam.location = shot["loc"]
    target.location = shot["target"]
    cam.data.lens = shot["lens"]
    bpy.context.view_layer.update()


def render(path):
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("rendered", os.path.basename(path), scene.render.resolution_x, scene.render.resolution_y)


# Hero: the frame trimmed to the block (the help script's own crop), transparent.
aim(HERO)
scene.render.film_transparent = True
scene.render.resolution_percentage = 100
scene.render.resolution_x = args.width
scene.render.resolution_y = round(args.width * 0.62)
bx0, bx1, by0, by1 = S["scene_crop"]()
full_w = round(args.width / (bx1 - bx0))
scene.render.resolution_x = full_w
scene.render.resolution_y = round(full_w * 0.62)
scene.render.use_border = True
scene.render.use_crop_to_border = True
scene.render.border_min_x, scene.render.border_max_x = bx0, bx1
scene.render.border_min_y, scene.render.border_max_y = by0, by1
hero_w = round(scene.render.resolution_x * (bx1 - bx0))
hero_h = round(scene.render.resolution_y * (by1 - by0))


def pct(co):
    v = world_to_camera_view(scene, cam, co)
    return [round((v.x - bx0) / (bx1 - bx0) * 100, 2), round((by1 - v.y) / (by1 - by0) * 100, 2)]


def line(points):
    return [pct(p) for p in points]


def ring(cx, cy, rx, ry, z, n=36):
    return [pct(Vector((cx + rx * math.cos(2 * math.pi * k / n), cy + ry * math.sin(2 * math.pi * k / n), z))) for k in range(n)]


overlay = {
    "width": hero_w,
    "height": hero_h,
    # Upstream → downstream, so a dash animation runs with the flow.
    "river": line([ground(river_x(y), y, 0.03) for y in np.linspace(Y1 - 0.25, Y0, 60)]),
    "tributary": line([ground(trib(y), y, 0.02) for y in np.linspace(Y1 - 0.25, 0.3, 30)]),
    "dams": {name: ring(cx, cy, rx, ry, lvl) for name, (cx, cy, rx, ry, lvl) in DAMS.items()},
    "clouds": [pct(Vector(c)) for c in cloud_spots],
    # Where rain lands on the ridges under each cloud.
    "ridges": [pct(ground(c[0], c[1], 0.05)) for c in cloud_spots],
    "sun": pct(SUN_AT),
    "gauge": pct(ground(gx0, gy0, 0.24)),
    "outlet": pct(ground(wx, wy, 0.1)),
    "reach": line([ground(river_x(y), y, 0.03) for y in np.linspace(-1.2, Y0, 14)]),
    "farms": {
        "orchard": pct(ground((ORCHARD[0] + ORCHARD[1]) / 2, (ORCHARD[2] + ORCHARD[3]) / 2, 0.2)),
        "vineyard": pct(ground((VINEYARD[0] + VINEYARD[1]) / 2, (VINEYARD[2] + VINEYARD[3]) / 2, 0.1)),
    },
    "slopes": [pct(ground(-4.4, 3.2, 0.05)), pct(ground(4.4, 2.6, 0.05)), pct(ground(-1.2, 2.9, 0.05))],
}
for mode in ("day", "dusk"):
    light(mode)
    render(f"{args.outdir}/hero-{mode}.png")

# Open Graph backdrop: fills 1200 × 630 over the sky; the headline goes on the left.
aim(OG)
scene.render.film_transparent = False
scene.render.use_border = False
scene.render.resolution_x, scene.render.resolution_y = 1200, 630
for mode in ("day", "dusk"):
    light(mode)
    render(f"{args.outdir}/og-{mode}.png")

with open(f"{args.outdir}/overlay.json", "w") as f:
    json.dump(overlay, f, separators=(",", ":"))
    f.write("\n")

# The terrain's heights on a coarse grid (top view, y+ upstream), for contours.py.
GX, GY = 150, 100
xs, ys = np.linspace(X0, X1, GX), np.linspace(Y0, Y1, GY)
with open(f"{args.outdir}/heights.json", "w") as f:
    json.dump({"nx": GX, "ny": GY, "z": [[round(height(x, y), 3) for x in xs] for y in ys]}, f, separators=(",", ":"))
