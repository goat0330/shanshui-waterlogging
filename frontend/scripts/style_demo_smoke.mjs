import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import ts from 'typescript'

const root = new URL('../src/scene/', import.meta.url)
const urls = new Map()
async function moduleUrl(name) {
  if (urls.has(name)) return urls.get(name)
  let source = await fs.readFile(new URL(`${name}.ts`, root), 'utf8')
  source = source.replaceAll("from 'cesium'", `from '${import.meta.resolve('cesium')}'`)
  if (source.includes("from './styleDemoPalette'")) {
    source = source.replace("from './styleDemoPalette'", `from '${await moduleUrl('styleDemoPalette')}'`)
  }
  const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText
  const url = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
  urls.set(name, url)
  return url
}
const {getShanghaiSceneMode} = await import(await moduleUrl('styleDemoMode'))
for (const query of ['', '?view=mvp', '?sceneView=astra-aerial-45', '?view=3d-demo-other']) assert.equal(getShanghaiSceneMode(query), 'mvp')
assert.equal(getShanghaiSceneMode('?view=3d-demo'), 'visual')
const {applyStyleDemoSceneLook} = await import(await moduleUrl('styleDemoSceneLook'))
const viewer = {camera: {frustum: {}}, scene: {globe: {}, fog: {}, postProcessStages: {exposure: 1.05, ambientOcclusion: {uniforms: {}}, bloom: {}}}}
const imagery = {}
applyStyleDemoSceneLook(viewer, imagery)
assert.equal(viewer.scene.postProcessStages.exposure, 1.05)
assert.equal(imagery.alpha, 0.18)
const {applyBuildingSurfaceV3} = await import(await moduleUrl('buildingSurfaceV3'))
const tileset = {style: {color: 'old'}}
applyBuildingSurfaceV3(tileset)
assert.equal(tileset.style, undefined)
assert.ok(tileset.customShader.vertexShaderText.includes('featureId_0'))
assert.ok(tileset.customShader.fragmentShaderText.includes('floor(v_seed + 0.5)'))
assert.ok(!Object.keys(tileset.customShader.varyings).includes('v_positionMC'))
tileset.customShader.destroy()
const data = JSON.parse(await fs.readFile(new URL('../public/data/scene/shanghai-landuse.geojson', import.meta.url)))
assert.ok(data.features.length > 0)
const ids = new Set()
for (const f of data.features) {
  assert.equal(f.properties.source, 'OpenStreetMap')
  assert.ok(['residential', 'commercial', 'industrial', 'civic', 'green'].includes(f.properties.class))
  assert.ok(!ids.has(f.id)); ids.add(f.id)
  const ring = f.geometry.coordinates[0]
  assert.deepEqual(ring[0], ring.at(-1))
  assert.ok(ring.every(([lon, lat]) => lon > 120 && lon < 123 && lat > 30 && lat < 33))
}
console.log(`PASS: mode isolation, unchanged exposure, shader ownership, ${ids.size} real OSM polygons`)
