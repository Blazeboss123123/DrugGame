// Builds a single self-contained HTML file that loads Three.js and Rapier from jsDelivr via an import map.
// Usage: node tools/build-standalone.mjs <path-to-esbuild>   (output: build/underworld-empire.html)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const esbuild = process.argv[2] ?? 'npx esbuild';
mkdirSync('build', { recursive: true });
execFileSync(esbuild, [
  'src/main.ts',
  '--bundle',
  '--format=esm',
  '--target=es2022',
  '--minify',
  '--outfile=build/game.js',
  '--external:three',
  '--external:three/addons/*',
  '--external:@dimforge/rapier3d-compat',
  '--loader:.css=css',
], { stdio: 'inherit' });

const js = readFileSync('build/game.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const css = readFileSync('build/game.css', 'utf8');
const THREE = 'https://cdn.jsdelivr.net/npm/three@0.170.0';
const RAPIER = 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js';
const importMap = {
  imports: {
    three: `${THREE}/build/three.module.js`,
    'three/addons/': `${THREE}/examples/jsm/`,
    '@dimforge/rapier3d-compat': RAPIER,
  },
};

const html = `<title>Underworld Empire</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@600;800;900&family=Archivo:wght@400;500;600&family=IBM+Plex+Mono:wght@500&display=swap">
<style>${css}</style>
<script type="importmap">${JSON.stringify(importMap)}</script>
<div id="app"></div>
<script type="module">${js}</script>
`;
writeFileSync('build/underworld-empire.html', html);
console.log(`build/underworld-empire.html ${(html.length / 1024).toFixed(0)} KB`);
