// Converts the Quaternius Downtown City MegaKit glTF exports into web-sized assets.
// Usage: node tools/convert-megakit.cjs <megakit-root> <out-dir>
const fs = require('fs');
const path = require('path');
const sharp = require(process.env.SHARP || 'sharp');
const [root, out] = process.argv.slice(2);
const gl = path.join(root, 'Exports', 'glTF (Godot)');
const MODELS = ['Building_Large_2', 'Building_Medium_2_001', 'Building_Small_1', 'Prop_ACUnit', 'Prop_Bollard', 'Prop_Planter_Single', 'Prop_ManholeCover'];
const images = new Set();
(async () => {
  for (const m of MODELS) {
    const d = JSON.parse(fs.readFileSync(path.join(gl, m + '.gltf'), 'utf8'));
    for (const img of d.images ?? []) {
      images.add(img.uri);
      img.uri = img.uri.replace(/\.png$/i, '.jpg');
      img.mimeType = 'image/jpeg';
    }
    // Embed the buffer so each model is a single JSON file (servable anywhere, no .bin MIME issues).
    for (const b of d.buffers) b.uri = 'data:application/octet-stream;base64,' + fs.readFileSync(path.join(gl, b.uri)).toString('base64');
    fs.writeFileSync(path.join(out, m + '.json'), JSON.stringify(d));
  }
  for (const uri of images) {
    const src = path.join(root, 'Textures', uri);
    const size = /BaseColor/.test(uri) ? 1024 : 512;
    await sharp(src).resize(size, size, { fit: 'inside' }).flatten({ background: '#808080' }).jpeg({ quality: /Normal/.test(uri) ? 88 : 80 }).toFile(path.join(out, uri.replace(/\.png$/i, '.jpg')));
  }
  console.log('models', MODELS.length, 'textures', images.size);
})();
