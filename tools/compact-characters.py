"""Converts Quaternius 'Ultimate Modular Men' glTF characters into compact web assets.

Each character keeps only its mesh + skin; one shared file keeps the animations we use.
Usage: python3 tools/compact-characters.py <glTF folder> <out folder>
"""
import base64, json, os, struct, sys

KEEP_CHARS = ['Casual_Hoodie', 'Casual_2', 'Beach', 'Farmer', 'Punk', 'Suit', 'Worker', 'Swat', 'Adventurer']
KEEP_ANIMS = ['Idle', 'Idle_Neutral', 'Walk', 'Run', 'Interact', 'Wave', 'HitRecieve', 'Punch_Right']

def load(path):
    d = json.load(open(path))
    uri = d['buffers'][0]['uri']
    raw = base64.b64decode(uri.split(',', 1)[1])
    return d, raw

def compact(d, raw, keep_anims, keep_meshes):
    used_acc = set()
    if keep_meshes:
        for m in d['meshes']:
            for p in m['primitives']:
                used_acc.update(p['attributes'].values())
                if 'indices' in p: used_acc.add(p['indices'])
                for t in p.get('targets', []): used_acc.update(t.values())
        for s in d.get('skins', []):
            if 'inverseBindMatrices' in s: used_acc.add(s['inverseBindMatrices'])
    anims = [a for a in d.get('animations', []) if a['name'] in keep_anims]
    for a in anims:
        for s in a['samplers']:
            used_acc.add(s['input']); used_acc.add(s['output'])
    acc_map, new_acc, new_views = {}, [], []
    out = bytearray()
    for i in sorted(used_acc):
        a = dict(d['accessors'][i])
        bv = d['bufferViews'][a['bufferView']]
        comp = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}[a['componentType']]
        ncomp = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
        elem = comp * ncomp
        stride = bv.get('byteStride', elem)
        start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        chunk = bytearray()
        for k in range(a['count']):
            chunk += raw[start + k * stride: start + k * stride + elem]
        while len(out) % 4: out.append(0)
        view = {'buffer': 0, 'byteOffset': len(out), 'byteLength': len(chunk)}
        if 'target' in bv: view['target'] = bv['target']
        out += chunk
        new_views.append(view)
        a['bufferView'] = len(new_views) - 1
        a.pop('byteOffset', None)
        acc_map[i] = len(new_acc)
        new_acc.append(a)
    if keep_meshes:
        for m in d['meshes']:
            for p in m['primitives']:
                p['attributes'] = {k: acc_map[v] for k, v in p['attributes'].items()}
                if 'indices' in p: p['indices'] = acc_map[p['indices']]
                if 'targets' in p: p['targets'] = [{k: acc_map[v] for k, v in t.items()} for t in p['targets']]
        for s in d.get('skins', []):
            if 'inverseBindMatrices' in s: s['inverseBindMatrices'] = acc_map[s['inverseBindMatrices']]
    else:
        # Animation-only file: drop meshes and skins, keep the node hierarchy for bone names.
        for n in d['nodes']:
            n.pop('mesh', None); n.pop('skin', None)
        d.pop('meshes', None); d.pop('skins', None); d.pop('materials', None)
    for a in anims:
        for s in a['samplers']:
            s['input'] = acc_map[s['input']]; s['output'] = acc_map[s['output']]
    d['animations'] = anims
    if not anims: d.pop('animations')
    d['accessors'] = new_acc
    d['bufferViews'] = new_views
    d['buffers'] = [{'byteLength': len(out), 'uri': 'data:application/octet-stream;base64,' + base64.b64encode(bytes(out)).decode()}]
    return d

src, dst = sys.argv[1], sys.argv[2]
os.makedirs(dst, exist_ok=True)
for name in KEEP_CHARS:
    d, raw = load(os.path.join(src, name + '.gltf'))
    c = compact(d, raw, [], True)
    p = os.path.join(dst, name + '.json')
    json.dump(c, open(p, 'w'), separators=(',', ':'))
    print(name, os.path.getsize(p))
d, raw = load(os.path.join(src, 'Casual_Hoodie.gltf'))
a = compact(d, raw, KEEP_ANIMS, False)
p = os.path.join(dst, 'Animations.json')
json.dump(a, open(p, 'w'), separators=(',', ':'))
print('Animations', os.path.getsize(p), [x['name'] for x in a['animations']])
