import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(here, '..')
const strict = process.env.STRICT_VISUAL_DEMO === '1'
const warnings = []
const warn = (msg) => { warnings.push(msg); console.warn(`WARN: ${msg}`) }
const failOrWarn = (msg) => strict ? assert.fail(msg) : warn(msg)

const read = (p) => fsp.readFile(path.join(frontend, p), 'utf8')

const scene = await read('src/CesiumScene.tsx')
assert.match(scene, /applyMvpSceneLook/)
assert.match(scene, /applyStyleDemoSceneLook/)
assert.match(scene, /shadows:\s*visualDemo/)
assert.match(scene, /visualDemo\) applyStyleDemoSceneLook\(viewer, basemapLayer\)[\s\S]*else applyMvpSceneLook\(viewer, basemapLayer, WORLD_TERRAIN_ENABLED\)/)
assert.ok(!scene.includes('applyBuildingSurfaceV3('), 'v3 surface must not be active')
assert.match(scene, /applyBuildingSurfaceV4\(tileset\)/)
assert.match(scene, /data-context-surface=\{visualDemo \? 'building-surface-v4' : 'existing'\}/)
assert.ok(!scene.includes('basemapLayer.alpha = 0.08'), 'visual basemap values must live outside CesiumScene')
assert.ok(!scene.includes("viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#54626b')"), 'visual look must be isolated in preset')

const mvpLook = await read('src/scene/mvpSceneLook.ts')
for (const token of ["'#0a1118'", "'#0d1921'", 'basemapLayer.alpha = 0.72', 'basemapLayer.brightness = 0.48', 'basemapLayer.contrast = 1.14', 'basemapLayer.saturation = 0.18', 'depthTestAgainstTerrain = worldTerrainEnabled']) {
  assert.ok(mvpLook.includes(token), `MVP baseline missing ${token}`)
}

const visualLook = await read('src/scene/styleDemoSceneLook.ts')
for (const token of ['highDynamicRange = true', 'basemapLayer.alpha = 0.18', 'ambientOcclusion', 'softShadows = true', "fromIso8601('2026-06-01T04:00:00Z')"]) {
  assert.ok(visualLook.includes(token), `Visual preset missing ${token}`)
}

const surface = await read('src/scene/buildingSurfaceV4.ts')
assert.ok(surface.includes("getProperty('cesium#estimatedHeight')"), 'v4 must use real OSM numeric height metadata when available')
assert.ok(surface.includes('tileVisible'), 'v4 must apply height families when OSM tiles become visible')
assert.ok(!surface.includes('hash11('), 'v4 must not assign material families by random hash')
assert.ok(!surface.includes('featureId_0'), 'v4 must not use feature ID lottery')
assert.ok(surface.includes('Cesium.ShadowMode.ENABLED'), 'OSM context must receive+cast visual-demo shadows')

const model = await read('src/scene/lujiazuiModel.ts')
assert.ok(model.includes('LUJIAZUI_ASSET_VERSION'), 'Astra asset cache version module not wired')
assert.ok(model.includes('VITE_LUJIAZUI_GLB_URL'), 'Render external asset override not wired')

const landusePath = path.join(frontend, 'public/data/scene/shanghai-landuse.geojson')
if (fs.existsSync(landusePath)) {
  const landuse = JSON.parse(await fsp.readFile(landusePath, 'utf8'))
  assert.ok(landuse.features?.length >= 8000, `Expected ~8526 real OSM landuse polygons, found ${landuse.features?.length ?? 0}`)
}

const roadsPath = path.join(frontend, 'public/data/scene/shanghai-demo-roads.geojson')
if (fs.existsSync(roadsPath)) {
  const roads = JSON.parse(await fsp.readFile(roadsPath, 'utf8'))
  const classes = new Set((roads.features || []).map((f) => f.properties?.fclass))
  assert.ok(classes.has('secondary') || classes.has('tertiary'), 'Detailed demo roads should include secondary/tertiary streets')
  assert.ok(classes.has('residential') || classes.has('unclassified') || classes.has('service'), 'Detailed demo roads should include local streets')
  console.log(`Road hierarchy: ${roads.features.length} OSM ways, ${classes.size} classes`)
} else {
  failOrWarn('frontend/public/data/scene/shanghai-demo-roads.geojson is missing. Run python frontend/scripts/fetch_shanghai_demo_roads.py before final Render deployment.')
}

const glbPath = path.join(frontend, 'public/runtime/lujiazui-camera-max/lujiazui.glb')
const manifestPath = path.join(frontend, 'public/runtime/lujiazui-camera-max/lujiazui.asset.json')
const external = process.env.VITE_LUJIAZUI_GLB_URL?.trim()
if (external && !external.startsWith('/')) {
  console.log(`Astra asset: external Render URL configured (${external})`)
} else if (fs.existsSync(glbPath)) {
  const stat = await fsp.stat(glbPath)
  if (stat.size === 97_315_476) failOrWarn('Runtime GLB is still the known 97,315,476-byte remote baseline, not the final Astra asset.')
  if (!fs.existsSync(manifestPath)) {
    failOrWarn('lujiazui.asset.json missing. Run python frontend/scripts/install_astra_glb.py to fingerprint the final asset.')
  } else {
    const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
    const hash = crypto.createHash('sha256')
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(glbPath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', resolve)
    })
    const digest = hash.digest('hex')
    assert.equal(manifest.sha256, digest, 'Astra asset manifest hash mismatch')
    assert.equal(manifest.size, stat.size, 'Astra asset manifest size mismatch')
    assert.ok((manifest.images ?? 0) > 0, 'Final Astra asset should contain embedded images')
    console.log(`Astra asset: ${stat.size.toLocaleString()} bytes, sha256 ${digest.slice(0, 12)}, images=${manifest.images}`)
  }
} else {
  failOrWarn('Runtime GLB missing and no external VITE_LUJIAZUI_GLB_URL configured.')
}

console.log(`PASS: strict MVP/visual look isolation, Building Surface v4 ownership, real OSM landuse${warnings.length ? `; ${warnings.length} deployment warning(s)` : ''}`)
