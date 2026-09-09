"""Original abstract Tyche assets. Rebuild with Blender 5.1+.
blender --background --factory-startup --python assets/3d/build_scene.py
"""
import bpy
import math
import json
import struct
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'apps/web/public/models'
OUT.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.context.preferences.filepaths.save_version = 0
scene = bpy.context.scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 16
scene.render.resolution_x, scene.render.resolution_y = 1200, 800
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = True
scene.view_settings.view_transform = 'Standard'
scene.render.fps = 30
scene.frame_start, scene.frame_end = 1, 241
for prop in scene.render.bl_rna.properties:
    if prop.identifier.startswith('use_stamp') and prop.type == 'BOOLEAN':
        setattr(scene.render, prop.identifier, False)

def material(name, hex_color):
    # Flat source colors; the export below normalizes them to unlit glTF.
    rgb = [int(hex_color[i:i+2], 16) / 255 for i in (0, 2, 4)]
    rgb = [c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb]
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*rgb, 1)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    output = nodes.new('ShaderNodeOutputMaterial')
    flat = nodes.new('ShaderNodeEmission')
    flat.inputs['Color'].default_value = (*rgb, 1)
    flat.inputs['Strength'].default_value = 1
    mat.node_tree.links.new(flat.outputs[0], output.inputs['Surface'])
    return mat

chalk = material('Chalk', 'c8d8d1')
shade = material('Slate', '405f57')
mid = material('Sage', '80ad99')
line = material('Outline', '64776e')
peach = material('Sand', 'd5bdaa')


def empty(name, parent=None, at=(0, 0, 0)):
    obj = bpy.data.objects.new(name, None)
    scene.collection.objects.link(obj)
    obj.parent, obj.location = parent, at
    return obj


def finish(obj, name, mat, parent):
    obj.name, obj.parent = name, parent
    obj.data.materials.append(mat)
    return obj


def ring(name, radius, width, parent, mat, at=(0, 0, 0), rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=radius, minor_radius=width, major_segments=48, minor_segments=6, location=at, rotation=rotation)
    return finish(bpy.context.object, name, mat, parent)


def animate(obj, prop, values, clip):
    for frame, value in values:
        setattr(obj, prop, value)
        obj.keyframe_insert(data_path=prop, frame=frame)
    action = obj.animation_data.action
    action.name = f'{clip}_{obj.name}'
    track = obj.animation_data.nla_tracks.new()
    track.name = clip
    track.strips.new(action.name, 1, action)
    obj.animation_data.action = None


workflow = empty('Workflow')
core = empty('Core', workflow, (0, 0, .15))
# Three offset planes form the OpenDesign abstract study in editable geometry.
for index, offset in enumerate([-.24, 0, .24]):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(offset, offset * .45, .08 + index * .045), rotation=(0, -.13, -.22))
    obj = finish(bpy.context.object, f'Core_shape_{index}', [shade, mid, chalk][index], core)
    obj.scale = (.09, .91, 1.14)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bevel = obj.modifiers.new('Soft edge', 'BEVEL')
    bevel.width, bevel.segments = .035, 3
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=bevel.name)
orbit = empty('Orbit', workflow)
ring('Orbit_line', 1.65, .012, orbit, line, at=(0, 0, .05))
roles = ['orchestrator', 'preflight', 'btc-analyst', 'eth-analyst', 'synthesizer', 'reviewer']
for i, role in enumerate(roles):
    angle = math.radians(-90 + i * 60)
    node = empty(f'agent_{role}', workflow, (1.65 * math.cos(angle), 1.65 * math.sin(angle), .05))
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=.1)
    finish(bpy.context.object, f'Agent_glow_{i}', mid, node)
    animate(node, 'scale', [(1, (.6, .6, .6)), (31, (1, 1, 1))], 'Reveal')
animate(core, 'location', [(1, (0, 0, .15)), (121, (0, 0, .25)), (241, (0, 0, .15))], 'Idle')
animate(core, 'rotation_euler', [(1, (0, 0, -.1)), (121, (0, 0, .1)), (241, (0, 0, -.1))], 'Idle')

trading = empty('Trading')
for symbol, x in [('BTC_USDT', -1.24), ('ETH_USDT', 1.24)]:
    node = empty(f'asset_{symbol}', trading, (x, 0, 0))
    hover = empty(f'Asset_hover_{symbol}', node, (0, 0, .28))
    if symbol == 'BTC_USDT':
        ring('BTC_shape', .42, .09, hover, peach, rotation=(.2, 0, 0))
    else:
        vertices = [(0, 0, .55), (0, 0, -.25), (-.32, 0, 0), (0, -.32, 0), (.32, 0, 0), (0, .32, 0)]
        faces = [(0, 2, 3), (0, 3, 4), (0, 4, 5), (0, 5, 2), (1, 3, 2), (1, 4, 3), (1, 5, 4), (1, 2, 5)]
        mesh = bpy.data.meshes.new('ETH_shape')
        mesh.from_pydata(vertices, [], faces)
        obj = bpy.data.objects.new('ETH_shape', mesh)
        scene.collection.objects.link(obj)
        finish(obj, 'ETH_shape', mid, hover)
        obj.data.materials.append(shade)
        obj.data.materials.append(chalk)
        for i, face in enumerate(obj.data.polygons):
            face.material_index = i % 3
    animate(hover, 'location', [(1, (0, 0, .28)), (121, (0, 0, .38)), (241, (0, 0, .28))], 'Idle')
    animate(node, 'scale', [(1, (.7, .7, .7)), (31, (1, 1, 1))], 'Reveal')

scene.frame_set(60)
bpy.ops.object.select_all(action='DESELECT')
for root in (workflow, trading):
    for obj in (root, *root.children_recursive):
        obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(OUT / 'tyche-console.glb'), export_format='GLB', use_selection=True,
    export_animations=True, export_animation_mode='NLA_TRACKS', export_merge_animation='NLA_TRACK',
    export_force_sampling=True, export_lights=False, export_cameras=False)
# Blender writes emission-only nodes as PBR emission. Preserve their exact colors
# in the standard unlit extension so browser lighting cannot add highlights.
asset_path = OUT / 'tyche-console.glb'
raw = asset_path.read_bytes()
json_length = struct.unpack_from('<I', raw, 12)[0]
gltf = json.loads(raw[20:20 + json_length])
for mat in gltf['materials']:
    color = mat.pop('emissiveFactor', [1, 1, 1])
    mat['pbrMetallicRoughness'] = {'baseColorFactor': [*color, 1], 'metallicFactor': 0, 'roughnessFactor': 1}
    mat.setdefault('extensions', {})['KHR_materials_unlit'] = {}
gltf['extensionsUsed'] = sorted(set(gltf.get('extensionsUsed', []) + ['KHR_materials_unlit']))
payload = json.dumps(gltf, separators=(',', ':')).encode()
payload += b' ' * ((-len(payload)) % 4)
binary = raw[20 + json_length:]
asset_path.write_bytes(struct.pack('<4sII', b'glTF', 2, 20 + len(payload) + len(binary)) + struct.pack('<I4s', len(payload), b'JSON') + payload + binary)

bpy.ops.object.camera_add(location=(4, -6.5, 6.3))
camera = bpy.context.object
camera.name = 'Review_camera'
camera.rotation_euler = (Vector((0, 0, .08)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type, camera.data.ortho_scale = 'ORTHO', 5.1
scene.camera = camera


def hide(root, value):
    for obj in (root, *root.children_recursive):
        obj.hide_render = value
        obj.hide_set(value)

hide(trading, True)
scene.render.filepath = '//../../apps/web/public/models/workflow-poster.png'
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type == 'VIEW_3D':
            area.spaces.active.region_3d.view_perspective = 'CAMERA'
            area.spaces.active.overlay.show_overlays = False
            area.spaces.active.shading.type = 'MATERIAL'
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / 'assets/3d/tyche-console.blend'))
scene.render.filepath = str(OUT / 'workflow-poster.png')
bpy.ops.render.render(write_still=True)
hide(workflow, True)
hide(trading, False)
scene.render.filepath = str(OUT / 'trading-poster.png')
bpy.ops.render.render(write_still=True)
print('TYCHE_ABSTRACT_ASSETS_COMPLETE')
