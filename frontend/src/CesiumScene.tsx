import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { FloodEvent, FloodPoint, ForecastFrame, ForecastKey, SensorState } from './types'
import { CITY_LABEL_SOURCE_LABEL, loadCityLabelLayer } from './scene/cityLabelLayer'
import { addDemoCityBlocks } from './scene/demoCityLayer'
import { SHANGHAI_WATER_POLYGONS_GEOJSON_URL, SHANGHAI_WATER_SOURCE_LABEL, SHANGHAI_WATERWAYS_GEOJSON_URL, loadShanghaiHydroSystemLayer } from './scene/hydroSystemLayer'
import { loadMajorRoadLayer, MAJOR_ROADS_GEOJSON_URL, MAJOR_ROADS_SOURCE_LABEL } from './scene/majorRoadLayer'
import { addGeographicSensorEntity } from './scene/sensorEntity'
import { applyOsmContextVisuals } from './scene/osmContextFacadeShader'
import { getShanghaiSceneMode } from './scene/styleDemoMode'
import { applyStyleDemoSceneLook } from './scene/styleDemoSceneLook'
import { applyBuildingSurfaceV3 } from './scene/buildingSurfaceV3'
import { loadShanghaiLanduseLayer } from './scene/landuseLayer'
import {
  LUJIAZUI_ANCHOR,
  LUJIAZUI_CONTROL_POINTS,
  LUJIAZUI_GLB_URL,
  LUJIAZUI_WATER_CLIP_BBOX,
  createLujiazuiContextClippingPolygons,
  addLujiazuiCalibrationMarkers,
  getInitialLujiazuiModelMatrix,
  getLujiazuiCalibrationMode,
  saveLujiazuiModelMatrix,
  solveLujiazuiSimilarityCorrection,
  type LujiazuiGeoreferenceStatus,
} from './scene/lujiazuiModel'

const CORE_TILES_URL = '/data/runtime/shanghai-core/tileset.json'
const OSM_BASEMAP_URL = 'https://tile.openstreetmap.org/'
const CESIUM_ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN?.trim()
const WORLD_TERRAIN_ENABLED = Boolean(CESIUM_ION_TOKEN)
const SENSOR_STATE_SOURCE = 'sensor-state-input'
const FLOOD_POINT_FALLBACK_SOURCE = 'floodpoint-fallback'
const EVENT_FALLBACK_SOURCE = 'event-fallback'
const BIMANGLE_ORIGIN = { lon: 116.46, lat: 39.92 }
const HUANGPU_SHP_CENTER = { lon: 121.47797014, lat: 31.21940076 }
const HUANGPU_MODEL_CENTER_LOCAL = { x: 80.3409, y: -53.0326, z: 90 }
const DEFAULT_EVENT = { lon: 121.4874, lat: 31.2297 }
const CONTEXT_CACHE_BYTES = 192 * 1024 * 1024
const CONTEXT_OVERFLOW_BYTES = 96 * 1024 * 1024
const CONTEXT_BUILDING_STYLE = new Cesium.Cesium3DTileStyle({
  color: "color('#bbc4ca', 1.0)",
})
const LUJIAZUI_CLEANUP_NODE_NAMES = ['Sphere01', 'Plane01']
const LUJIAZUI_CALIBRATION_MODE = getLujiazuiCalibrationMode()
const LUJIAZUI_NO_TEXTURE_READABILITY_SHADER = new Cesium.CustomShader({
  lightingModel: Cesium.LightingModel.PBR,
  fragmentShaderText: `
    void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
      vec3 sourceColor = material.diffuse;
      float roofFactor = smoothstep(0.62, 0.92, abs(fsInput.attributes.normalEC.z));
      float facadeBand = 0.96 + 0.04 * abs(fsInput.attributes.normalEC.x);
      vec3 facadeTone = vec3(1.0, 0.99, 0.96);
      vec3 roofTone = vec3(0.82, 0.86, 0.88);
      material.diffuse = sourceColor * mix(facadeTone, roofTone, roofFactor) * facadeBand;
      material.roughness = max(material.roughness, 0.62);
    }
  `,
})
const FORECAST_FILL: Record<ForecastKey, Cesium.Color> = {
  NOW: new Cesium.Color(0.08, 0.68, 0.76, 0.28),
  PLUS_10: new Cesium.Color(0.14, 0.38, 0.78, 0.3),
  PLUS_30: new Cesium.Color(0.92, 0.42, 0.12, 0.34),
}
const FORECAST_STROKE: Record<ForecastKey, Cesium.Color> = {
  NOW: new Cesium.Color(0.25, 0.83, 0.86, 0.88),
  PLUS_10: new Cesium.Color(0.38, 0.61, 0.95, 0.9),
  PLUS_30: new Cesium.Color(1, 0.64, 0.24, 0.94),
}
type SourceAttemptReason = 'none' | 'token_missing' | 'osm_init_failed'
type SourceReason =
  | 'none'
  | 'token_missing'
  | 'osm_init_failed'
  | 'local_core_unavailable'
  | 'token_missing+local_core_unavailable'
  | 'osm_init_failed+local_core_unavailable'

type LujiazuiMaterialStatus = 'unknown' | 'source-pbr' | 'source-factors-readability'

function getLocalFailureReason(attemptReason: SourceAttemptReason): SourceReason {
  if (attemptReason === 'token_missing') return 'token_missing+local_core_unavailable'
  if (attemptReason === 'osm_init_failed') return 'osm_init_failed+local_core_unavailable'
  return 'local_core_unavailable'
}

export interface SceneAnchorPosition {
  x: number
  y: number
  viewportWidth: number
  viewportHeight: number
  visible: boolean
}

interface CesiumSceneProps {
  event: FloodEvent | null
  points: FloodPoint[]
  sensor?: SensorState | null
  activeForecast: ForecastKey
  forecastFrame: ForecastFrame | null
  selectedPointId: string
  layers: LayerVisibility
  onPointSelect: (id: string) => void
  onSelectedPointScreenPosition?: (position: SceneAnchorPosition | null) => void
}

type LayerVisibility = {
  base: boolean
  water: boolean
  depth: boolean
  network: boolean
  video: boolean
  measure: boolean
}

function placeHuangpuByRange(tileset: Cesium.Cesium3DTileset) {
  const sourceFrame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(BIMANGLE_ORIGIN.lon, BIMANGLE_ORIGIN.lat, 0),
  )
  const targetFrame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(HUANGPU_SHP_CENTER.lon, HUANGPU_SHP_CENTER.lat, 0),
  )
  const sourceCenterFrame = Cesium.Matrix4.multiply(
    sourceFrame,
    Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.fromElements(
      HUANGPU_MODEL_CENTER_LOCAL.x,
      HUANGPU_MODEL_CENTER_LOCAL.y,
      HUANGPU_MODEL_CENTER_LOCAL.z,
    ), new Cesium.Matrix4()),
    new Cesium.Matrix4(),
  )
  const sourceInverse = Cesium.Matrix4.inverse(sourceCenterFrame, new Cesium.Matrix4())
  tileset.modelMatrix = Cesium.Matrix4.multiply(targetFrame, sourceInverse, new Cesium.Matrix4())
}

function flyToTarget(viewer: Cesium.Viewer, target: { lon: number; lat: number }, duration = 0.8) {
  viewer.camera.flyToBoundingSphere(
    new Cesium.BoundingSphere(
      Cesium.Cartesian3.fromDegrees(target.lon, target.lat, 0),
      900,
    ),
    {
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(28),
        Cesium.Math.toRadians(-34),
        3200,
      ),
      duration,
    },
  )
}

async function waitForModelReady(model: Cesium.Model) {
  if (model.ready) return
  await new Promise<void>((resolve, reject) => {
    let removeReady: () => void = () => {}
    let removeError: () => void = () => {}
    removeReady = model.readyEvent.addEventListener(() => {
      removeReady()
      removeError()
      resolve()
    })
    removeError = model.errorEvent.addEventListener((error) => {
      removeReady()
      removeError()
      reject(error)
    })
  })
}

function cleanupLujiazuiModel(model: Cesium.Model) {
  const hiddenNodes = LUJIAZUI_CLEANUP_NODE_NAMES.filter((nodeName) => {
    const node = model.getNode(nodeName)
    if (!node) return false
    node.show = false
    return true
  })
  return hiddenNodes.join(',') || 'none'
}

type Coordinate2 = [number, number]
type PolygonCoordinates = Coordinate2[][]
type MultiPolygonCoordinates = PolygonCoordinates[]

function ringIntersectsLujiazuiBbox(ring: readonly Coordinate2[]) {
  if (!ring.length) return false
  let west = Number.POSITIVE_INFINITY
  let south = Number.POSITIVE_INFINITY
  let east = Number.NEGATIVE_INFINITY
  let north = Number.NEGATIVE_INFINITY
  ring.forEach(([lon, lat]) => {
    west = Math.min(west, lon)
    east = Math.max(east, lon)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  })
  return !(
    east < LUJIAZUI_WATER_CLIP_BBOX.west
    || west > LUJIAZUI_WATER_CLIP_BBOX.east
    || north < LUJIAZUI_WATER_CLIP_BBOX.south
    || south > LUJIAZUI_WATER_CLIP_BBOX.north
  )
}

function isRiverFeature(properties: Record<string, unknown> | undefined) {
  if (!properties) return false
  const water = typeof properties.water === 'string' ? properties.water : ''
  const otherTags = typeof properties.other_tags === 'string' ? properties.other_tags : ''
  return water === 'river' || otherTags.includes('"water"=>"river"') || otherTags.includes('water=>river')
}

function clippingPolygonFromRing(ring: readonly Coordinate2[]) {
  const closed = ring.length > 1
    && ring[0][0] === ring[ring.length - 1][0]
    && ring[0][1] === ring[ring.length - 1][1]
  const openRing = ring.slice(0, closed ? -1 : undefined)
  const stride = Math.max(1, Math.ceil(openRing.length / 220))
  const simplified = openRing.filter((_, index) => index % stride === 0)
  const positions = simplified.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat))
  return positions.length >= 3 ? new Cesium.ClippingPolygon({ positions }) : null
}

async function applyLujiazuiRiverMask(model: Cesium.Model) {
  try {
    const response = await fetch(SHANGHAI_WATER_POLYGONS_GEOJSON_URL, { cache: 'force-cache' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const payload = await response.json() as {
      features?: Array<{
        properties?: Record<string, unknown>
        geometry?: { type?: string; coordinates?: unknown }
      }>
    }
    const polygons: Cesium.ClippingPolygon[] = []
    for (const feature of payload.features ?? []) {
      if (!isRiverFeature(feature.properties)) continue
      const geometry = feature.geometry
      if (!geometry) continue
      const polygonParts: PolygonCoordinates[] = geometry.type === 'Polygon'
        ? [geometry.coordinates as PolygonCoordinates]
        : geometry.type === 'MultiPolygon'
          ? geometry.coordinates as MultiPolygonCoordinates
          : []
      for (const part of polygonParts) {
        const outerRing = part[0]
        if (!outerRing || !ringIntersectsLujiazuiBbox(outerRing)) continue
        const clippingPolygon = clippingPolygonFromRing(outerRing)
        if (clippingPolygon) polygons.push(clippingPolygon)
      }
    }
    if (!polygons.length) return 0
    model.clippingPolygons = new Cesium.ClippingPolygonCollection({ polygons })
    return polygons.length
  } catch (error) {
    console.warn('[CesiumScene] geographic river mask unavailable; keeping calibrated model geometry', error)
    return 0
  }
}

function createNeutralLighting(specular: number) {
  const lighting = new Cesium.ImageBasedLighting()
  lighting.imageBasedLightingFactor = new Cesium.Cartesian2(1, specular)
  lighting.sphericalHarmonicCoefficients = [new Cesium.Cartesian3(0.65, 0.68, 0.72), ...Array.from({ length: 8 }, () => new Cesium.Cartesian3())]
  return lighting
}

function tuneContextTileset(tileset: Cesium.Cesium3DTileset, inset: boolean, osm = false) {
  tileset.style = osm ? undefined : CONTEXT_BUILDING_STYLE
  // Opaque replacement avoids see-through walls and tinting by OSM source colors.
  tileset.colorBlendMode = Cesium.Cesium3DTileColorBlendMode.REPLACE
  tileset.imageBasedLighting = createNeutralLighting(0)
  tileset.maximumScreenSpaceError = 8
  tileset.cacheBytes = CONTEXT_CACHE_BYTES
  tileset.maximumCacheOverflowBytes = CONTEXT_OVERFLOW_BYTES
  tileset.cullRequestsWhileMoving = true
  tileset.cullRequestsWhileMovingMultiplier = 80
  if (inset) tileset.clippingPolygons = createLujiazuiContextClippingPolygons()
}

export function CesiumScene({ event, points, sensor = null, activeForecast, forecastFrame, selectedPointId, layers, onPointSelect, onSelectedPointScreenPosition }: CesiumSceneProps) {
  const sceneMode = getShanghaiSceneMode()
  const visualDemo = sceneMode === 'visual'
  const [landuseStatus, setLanduseStatus] = useState('disabled')
  const [landuseCount, setLanduseCount] = useState(0)
  const [contextLoaded, setContextLoaded] = useState(false)
  const [cameraPreset, setCameraPreset] = useState(new URLSearchParams(window.location.search).get('sceneView') === 'astra-aerial-45' ? 'astra-aerial-45' : 'city')
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const basemapLayerRef = useRef<Cesium.ImageryLayer | null>(null)
  const baseImageryRef = basemapLayerRef
  const lastAnchorRef = useRef<SceneAnchorPosition | null>(null)
  const cityLayerRef = useRef<Cesium.PrimitiveCollection | null>(null)
  const hydroDataSourceRef = useRef<Cesium.GeoJsonDataSource[]>([])
  const roadDataSourceRef = useRef<Cesium.GeoJsonDataSource | null>(null)
  const landuseDataSourceRef = useRef<Cesium.GeoJsonDataSource | null>(null)
  const labelDataSourceRef = useRef<Cesium.CustomDataSource | null>(null)
  const forecastDataSourceRef = useRef<Cesium.GeoJsonDataSource | null>(null)
  const modelRef = useRef<Cesium.Model | null>(null)
  const contextTilesetRef = useRef<Cesium.Cesium3DTileset | null>(null)
  const calibrationPicksRef = useRef<Cesium.Cartesian3[]>([])
  const calibrationMarkerRefs = useRef<Cesium.Entity[]>([])
  const layersDepthRef = useRef(layers.depth)
  const [viewerReady, setViewerReady] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [source, setSource] = useState<'lujiazui' | 'osm' | 'local' | 'demo' | null>(null)
  const [contextSource, setContextSource] = useState<'osm' | 'local' | 'demo' | 'none'>('none')
  const [riverClipCount, setRiverClipCount] = useState(0)
  const [georeferenceStatus, setGeoreferenceStatus] = useState<LujiazuiGeoreferenceStatus>('approximate')
  const [lujiazuiMaterialStatus, setLujiazuiMaterialStatus] = useState<LujiazuiMaterialStatus>('unknown')
  const [calibrationMessage, setCalibrationMessage] = useState(
    LUJIAZUI_CALIBRATION_MODE === 'capture'
      ? `校准 1/${LUJIAZUI_CONTROL_POINTS.length}：点击模型中的 ${LUJIAZUI_CONTROL_POINTS[0].name} 建筑中心`
      : '',
  )
  const [sourceReason, setSourceReason] = useState<SourceReason>('none')
  const [hydroStatus, setHydroStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [roadStatus, setRoadStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [labelStatus, setLabelStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [roadSourceUrl, setRoadSourceUrl] = useState(MAJOR_ROADS_GEOJSON_URL)
  const [roadAttribution, setRoadAttribution] = useState(MAJOR_ROADS_SOURCE_LABEL)
  const [roadFallback, setRoadFallback] = useState(false)
  const [forecastStatus, setForecastStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading')
  const [sensorEntityCount, setSensorEntityCount] = useState(0)
  const selectedPoint = points.find((point) => point.id === selectedPointId) ?? null
  const target = event?.coordinates ?? selectedPoint?.coordinates ?? DEFAULT_EVENT

  useEffect(() => {
    if (!containerRef.current) return

    // OSM Buildings and the ground must share Cesium World Terrain's vertical datum.
    // Do not compensate building height with a hard-coded Z translation.
    if (CESIUM_ION_TOKEN) Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN
    const worldTerrain = WORLD_TERRAIN_ENABLED
      ? Cesium.Terrain.fromWorldTerrain()
      : undefined

    const viewer = new Cesium.Viewer(containerRef.current, {
      shadows: true,
      animation: false,
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      terrain: worldTerrain,
    })
    const cityLayer = new Cesium.PrimitiveCollection()
    viewer.scene.primitives.add(cityLayer)
    cityLayerRef.current = cityLayer
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#54626b')
    if (viewer.scene.skyBox) viewer.scene.skyBox.show = false
    if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#7c8588')
    viewer.scene.highDynamicRange = true
    // Log depth causes coplanar facade striping on this centimetre-scale source.
    viewer.scene.logarithmicDepthBuffer = false
    viewer.camera.frustum.near = 10
    viewer.scene.postProcessStages.exposure = 1.05
    // Embedded material AO is retained. Screen-space AO creates terrain banding
    // at this geographic scale, so it must not be stacked over the baked AO.
    viewer.scene.postProcessStages.ambientOcclusion.enabled = false
    viewer.scene.postProcessStages.fxaa.enabled = true
    viewer.shadowMap.softShadows = true
    viewer.shadowMap.size = 2048
    viewer.shadowMap.darkness = 0.22
    viewer.clock.currentTime = Cesium.JulianDate.fromIso8601('2026-06-01T04:00:00Z')
    const basemapProvider = new Cesium.OpenStreetMapImageryProvider({
      url: OSM_BASEMAP_URL,
      maximumLevel: 19,
    })
    const basemapLayer = viewer.imageryLayers.addImageryProvider(basemapProvider, 0)
    basemapLayer.alpha = 0.08
    basemapLayer.brightness = 0.9
    basemapLayer.contrast = 0.65
    basemapLayer.saturation = 0.0
    basemapLayer.show = layers.base
    basemapLayerRef.current = basemapLayer
    viewer.scene.globe.enableLighting = false
    viewer.scene.globe.showGroundAtmosphere = false
    // The source site sits slightly below terrain; draw it without changing its datum.
    viewer.scene.globe.depthTestAgainstTerrain = false
    viewer.scene.fog.enabled = true
    viewer.scene.fog.density = 0.00008
    viewer.scene.fog.screenSpaceErrorFactor = 2
    if (visualDemo) applyStyleDemoSceneLook(viewer, basemapLayer)
    viewerRef.current = viewer
    setViewerReady(true)

    let disposed = false

    const loadLocalCore = async (attemptReason: SourceAttemptReason, inset: boolean) => {
      try {
        const tileset = await Cesium.Cesium3DTileset.fromUrl(CORE_TILES_URL, { maximumScreenSpaceError: 8 })
        if (disposed) {
          tileset.destroy()
          return false
        }
        placeHuangpuByRange(tileset)
        tuneContextTileset(tileset, inset)
        cityLayer.add(tileset)
        contextTilesetRef.current = tileset
        setContextSource('local')
        setSourceReason(attemptReason)
        if (!inset) {
          setSource('local')
          viewer.camera.flyToBoundingSphere(tileset.boundingSphere, {
            offset: new Cesium.HeadingPitchRange(
              Cesium.Math.toRadians(28),
              Cesium.Math.toRadians(-42),
              6500,
            ),
            duration: 0.8,
          })
        }
        setStatus('ready')
        return true
      } catch {
        if (disposed) return false
        setSourceReason(getLocalFailureReason(attemptReason))
        if (inset) {
          setContextSource('none')
          return false
        }
        try {
          addDemoCityBlocks(cityLayer)
          setContextSource('demo')
          setSource('demo')
          setStatus('ready')
          flyToTarget(viewer, target)
          return true
        } catch {
          setStatus('error')
          return false
        }
      }
    }

    const loadLujiazuiModel = async () => {
      let model: Cesium.Model | undefined
      let modelAdded = false
      let gltfImageCount = 0
      try {
        const initialPlacement = getInitialLujiazuiModelMatrix()
        setGeoreferenceStatus(initialPlacement.status)
        model = await Cesium.Model.fromGltfAsync({
          url: LUJIAZUI_GLB_URL,
          scene: viewer.scene,
          modelMatrix: initialPlacement.matrix,
          upAxis: Cesium.Axis.Z,
          forwardAxis: Cesium.Axis.X,
          // Receiving self-shadows produces banding at the imported source scale.
          // Keep soft shadow casting and the asset's baked AO without that artifact.
          shadows: Cesium.ShadowMode.CAST_ONLY,
          backFaceCulling: false,
          imageBasedLighting: createNeutralLighting(0.45),
          gltfCallback: (gltf) => {
            gltfImageCount = Array.isArray(gltf.images) ? gltf.images.length : 0
            // Original lawn node only: mute its runtime color without editing the asset.
            const lawn = gltf.nodes?.[14]
            const lawnMaterials = new Set<number>((gltf.meshes?.[lawn?.mesh]?.primitives ?? []).map((primitive: { material: number }) => primitive.material))
            lawnMaterials.forEach((index) => {
              const pbr = gltf.materials?.[index]?.pbrMetallicRoughness
              const color = pbr?.baseColorFactor
              if (!color) return
              const gray = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722
              pbr.baseColorFactor = [0, 1, 2].map((channel) => (gray * 0.45 + color[channel] * 0.55) * 0.88).concat(color[3])
            })
          },
          environmentMapOptions: {
            enabled: true,
            maximumPositionEpsilon: 600,
            maximumSecondsDifference: 1800,
            atmosphereScatteringIntensity: 0.0,
            brightness: 1.0,
            saturation: 0.15,
            groundColor: Cesium.Color.fromCssColorString('#9ca4aa'),
            groundAlbedo: 0.45,
          },
          id: 'lujiazui-camera-max-glb',
        })
        if (disposed) {
          model.destroy()
          return false
        }
        cityLayer.add(model)
        modelAdded = true
        modelRef.current = model
        await waitForModelReady(model)
        const hiddenNodes = cleanupLujiazuiModel(model)
        // The source asphalt sheet extends kilometres beyond the core and
        // occludes real parcels/roads. Replace that sheet only in the demo.
        if (visualDemo) {
          const asphalt = model.getNode('DK__柏油马路')
          if (asphalt) asphalt.show = false
        }
        const riverMasks = await applyLujiazuiRiverMask(model)
        if (disposed) return false
        setRiverClipCount(riverMasks)
        if (gltfImageCount === 0) {
          model.customShader = LUJIAZUI_NO_TEXTURE_READABILITY_SHADER
          setLujiazuiMaterialStatus('source-factors-readability')
        } else {
          setLujiazuiMaterialStatus('source-pbr')
          // Embedded PBR stays intact; scene lighting supplies neutral overcast fill.
        }
        if (LUJIAZUI_CALIBRATION_MODE === 'capture') {
          calibrationMarkerRefs.current = addLujiazuiCalibrationMarkers(viewer)
        }
        setSource('lujiazui')
        setSourceReason('none')
        setStatus('ready')
        flyToTarget(viewer, LUJIAZUI_ANCHOR, 1)
        console.info(`[CesiumScene] source=lujiazui-glb georef=${initialPlacement.status} material=gltf-pbr cleanup=${hiddenNodes} riverMasks=${riverMasks}`)
        return true
      } catch (error) {
        if (modelAdded && model) cityLayer.remove(model)
        modelRef.current = null
        setRiverClipCount(0)
        console.warn('[CesiumScene] Lujiazui GLB unavailable; continuing with OSM/local fallback', error)
        return false
      }
    }

    const loadCityContext = async (inset: boolean) => {
      if (disposed) return
      if (!CESIUM_ION_TOKEN) {
        await loadLocalCore('token_missing', inset)
        return
      }

      try {
        const tileset = await Cesium.createOsmBuildingsAsync({
          showOutline: false,
          enableShowOutline: false,
          defaultColor: Cesium.Color.fromCssColorString('#aab4b7'),
        })
        applyOsmContextVisuals(tileset)
        if (disposed) {
          tileset.destroy()
          return
        }
        tuneContextTileset(tileset, inset, true)
        if (visualDemo) applyBuildingSurfaceV3(tileset)
        if (visualDemo) {
          tileset.allTilesLoaded.addEventListener(() => { if (!disposed) setContextLoaded(true) })
          tileset.loadProgress.addEventListener((pending, processing) => {
            if (!disposed && (pending > 0 || processing > 0)) setContextLoaded(false)
          })
        }
        cityLayer.add(tileset)
        contextTilesetRef.current = tileset
        setContextSource('osm')
        if (!inset) {
          setSource('osm')
          flyToTarget(viewer, target, 1)
        }
        setSourceReason('none')
        setStatus('ready')
      } catch {
        if (!disposed) await loadLocalCore('osm_init_failed', inset)
      }
    }

    void (async () => {
      const hasLujiazui = await loadLujiazuiModel()
      if (disposed) return
      await loadCityContext(hasLujiazui)
    })()

    return () => {
      disposed = true
      cityLayerRef.current = null
      baseImageryRef.current = null
      lastAnchorRef.current = null
      basemapLayerRef.current = null
      hydroDataSourceRef.current = []
      forecastDataSourceRef.current = null
      calibrationPicksRef.current = []
      calibrationMarkerRefs.current = []
      modelRef.current = null
      contextTilesetRef.current = null
      viewerRef.current = null
      setViewerReady(false)
      viewer.destroy()
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !viewerReady) return
    if (cameraPreset === 'astra-aerial-45' && modelRef.current) {
      // Blender review_scene.py: convert Z-up camera into the source model axes.
      const matrix = modelRef.current.modelMatrix
      const destination = Cesium.Matrix4.multiplyByPoint(matrix, new Cesium.Cartesian3(-95000, 175000, 330000), new Cesium.Cartesian3())
      const focus = Cesium.Matrix4.multiplyByPoint(matrix, new Cesium.Cartesian3(88000, 16000, 132000), new Cesium.Cartesian3())
      const direction = Cesium.Cartesian3.normalize(Cesium.Cartesian3.subtract(focus, destination, new Cesium.Cartesian3()), new Cesium.Cartesian3())
      const vertical = Cesium.Cartesian3.normalize(Cesium.Matrix4.multiplyByPointAsVector(matrix, Cesium.Cartesian3.UNIT_Y, new Cesium.Cartesian3()), new Cesium.Cartesian3())
      const right = Cesium.Cartesian3.normalize(Cesium.Cartesian3.cross(direction, vertical, new Cesium.Cartesian3()), new Cesium.Cartesian3())
      const up = Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3())
      viewer.camera.cancelFlight()
      ;(viewer.camera.frustum as Cesium.PerspectiveFrustum).fov = 2 * Math.atan(36 / (2 * 52))
      viewer.camera.setView({ destination, orientation: { direction, up } })
    } else if (visualDemo) {
      viewer.camera.cancelFlight()
      ;(viewer.camera.frustum as Cesium.PerspectiveFrustum).fov = Cesium.Math.toRadians(50)
      const close = cameraPreset === 'context-close'
      viewer.camera.lookAt(Cesium.Cartesian3.fromDegrees(close ? 121.479 : 121.484, 31.239, 40),
        new Cesium.HeadingPitchRange(Cesium.Math.toRadians(55), Cesium.Math.toRadians(-24), close ? 2800 : 4500))
      viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY)
    } else {
      ;(viewer.camera.frustum as Cesium.PerspectiveFrustum).fov = Cesium.Math.toRadians(60)
      flyToTarget(viewer, target)
    }
  }, [target.lat, target.lon, viewerReady, source, cameraPreset])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !viewerReady || !onSelectedPointScreenPosition) return
    const coordinates = selectedPoint?.coordinates ?? event?.coordinates ?? null
    if (!coordinates) {
      lastAnchorRef.current = null
      onSelectedPointScreenPosition(null)
      return
    }
    const world = Cesium.Cartesian3.fromDegrees(coordinates.lon, coordinates.lat, 2)

    const publish = () => {
      if (viewer.isDestroyed()) return
      const windowPosition = viewer.scene.cartesianToCanvasCoordinates(world)
      const viewportWidth = viewer.scene.canvas.clientWidth
      const viewportHeight = viewer.scene.canvas.clientHeight
      const toPoint = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.subtract(world, viewer.camera.positionWC, new Cesium.Cartesian3()),
        new Cesium.Cartesian3(),
      )
      const visible = Boolean(windowPosition)
        && Cesium.Cartesian3.dot(viewer.camera.directionWC, toPoint) > 0
        && windowPosition!.x >= 0
        && windowPosition!.y >= 0
        && windowPosition!.x <= viewportWidth
        && windowPosition!.y <= viewportHeight
      const next: SceneAnchorPosition = {
        x: windowPosition?.x ?? 0,
        y: windowPosition?.y ?? 0,
        viewportWidth,
        viewportHeight,
        visible,
      }
      const previous = lastAnchorRef.current
      if (previous
        && previous.visible === next.visible
        && Math.abs(previous.x - next.x) < 1
        && Math.abs(previous.y - next.y) < 1
        && previous.viewportWidth === next.viewportWidth
        && previous.viewportHeight === next.viewportHeight) return
      lastAnchorRef.current = next
      onSelectedPointScreenPosition(next)
    }

    publish()
    viewer.scene.postRender.addEventListener(publish)
    return () => {
      if (!viewer.isDestroyed()) viewer.scene.postRender.removeEventListener(publish)
    }
  }, [event?.coordinates.lat, event?.coordinates.lon, onSelectedPointScreenPosition, selectedPoint?.coordinates.lat, selectedPoint?.coordinates.lon, viewerReady])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !viewerReady) return

    let cancelled = false
    setHydroStatus('loading')
    void loadShanghaiHydroSystemLayer(viewer, visualDemo).then((dataSource) => {
      if (cancelled || viewerRef.current !== viewer || viewer.isDestroyed()) {
        if (!viewer.isDestroyed()) dataSource.forEach((source) => viewer.dataSources.remove(source, true))
        return
      }
      dataSource.forEach((source) => { source.show = layers.water })
      hydroDataSourceRef.current = dataSource
      setHydroStatus('ready')
    }).catch(() => {
      if (!cancelled) setHydroStatus('error')
    })

    return () => {
      cancelled = true
      if (hydroDataSourceRef.current.length && viewerRef.current === viewer && !viewer.isDestroyed()) {
        hydroDataSourceRef.current.forEach((source) => viewer.dataSources.remove(source, true))
        hydroDataSourceRef.current = []
      }
    }
  }, [viewerReady])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !viewerReady) return

    let cancelled = false
    setRoadStatus('loading')
    setLabelStatus('loading')
    const prepareParcels = async () => {
      if (!visualDemo) return
      setLanduseStatus('loading')
      try {
        const parcels = await loadShanghaiLanduseLayer(viewer)
        if (cancelled || viewer.isDestroyed()) {
          if (!viewer.isDestroyed()) viewer.dataSources.remove(parcels, true)
          return
        }
        landuseDataSourceRef.current = parcels
        setLanduseCount(parcels.entities.values.length)
        setLanduseStatus('ready')
      } catch {
        if (!cancelled) setLanduseStatus('error')
      }
    }
    void prepareParcels().then(() => {
      if (cancelled || viewer.isDestroyed()) return null
      return loadMajorRoadLayer(viewer, visualDemo)
    }).then(async (result) => {
      if (!result) return
      if (cancelled || viewerRef.current !== viewer || viewer.isDestroyed()) {
        if (!viewer.isDestroyed()) viewer.dataSources.remove(result.dataSource, true)
        return
      }
      result.dataSource.show = layers.base
      roadDataSourceRef.current = result.dataSource
      setRoadSourceUrl(result.sourceUrl)
      setRoadAttribution(result.sourceLabel)
      setRoadFallback(result.fallback)
      setRoadStatus('ready')

      try {
        const labelDataSource = await loadCityLabelLayer(viewer, result.dataSource, result.sourceLabel)
        if (cancelled || viewerRef.current !== viewer || viewer.isDestroyed()) {
          if (!viewer.isDestroyed()) viewer.dataSources.remove(labelDataSource, true)
          return
        }
        labelDataSource.show = layers.base
        labelDataSourceRef.current = labelDataSource
        setLabelStatus('ready')
      } catch {
        if (!cancelled) setLabelStatus('error')
      }
    }).catch(() => {
      if (!cancelled) {
        setRoadStatus('error')
        setLabelStatus('error')
      }
    })

    return () => {
      cancelled = true
      if (landuseDataSourceRef.current && !viewer.isDestroyed()) {
        viewer.dataSources.remove(landuseDataSourceRef.current, true)
        landuseDataSourceRef.current = null
      }
      if (roadDataSourceRef.current && viewerRef.current === viewer && !viewer.isDestroyed()) {
        viewer.dataSources.remove(roadDataSourceRef.current, true)
        roadDataSourceRef.current = null
      }
      if (labelDataSourceRef.current && viewerRef.current === viewer && !viewer.isDestroyed()) {
        viewer.dataSources.remove(labelDataSourceRef.current, true)
        labelDataSourceRef.current = null
      }
    }
  }, [viewerReady])

  useEffect(() => {
    layersDepthRef.current = layers.depth
    if (forecastDataSourceRef.current) forecastDataSourceRef.current.show = layers.depth
  }, [layers.depth])

  useEffect(() => {
    hydroDataSourceRef.current.forEach((source) => { source.show = layers.water })
  }, [layers.water])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !viewerReady) return

    const markerData: Array<{
      id: string
      selectId: string
      sensorId: string
      siteId?: string
      eventId?: string
      name: string
      source: string
      coordinates: FloodPoint['coordinates']
      depthCm: number
      riskLevel: FloodPoint['riskLevel']
      fallback: boolean
      historical: boolean
    }> = [
      ...(sensor ? [{
        id: sensor.sensorId,
        selectId: selectedPointId || 'FP-001',
        sensorId: sensor.sensorId,
        siteId: sensor.siteId,
        eventId: event?.id,
        name: event?.name ?? selectedPoint?.name ?? sensor.siteId,
        source: sensor.source ?? SENSOR_STATE_SOURCE,
        coordinates: sensor.coordinates,
        depthCm: sensor.depthCm,
        riskLevel: event?.riskLevel ?? selectedPoint?.riskLevel ?? 'NORMAL',
        fallback: false,
        historical: false,
      }] : []),
      ...points
        .filter((point) => !sensor || point.id !== selectedPointId)
        .map((point) => ({
          id: `floodpoint-fallback-${point.id}`,
          selectId: point.id,
          sensorId: `floodpoint-fallback-${point.id}`,
          eventId: point.id === selectedPointId ? event?.id : undefined,
          name: point.name,
          source: FLOOD_POINT_FALLBACK_SOURCE,
          coordinates: point.coordinates,
          depthCm: point.depthCm,
          riskLevel: point.riskLevel,
          fallback: true,
          historical: Boolean(point.historicalCaseId),
        })),
      ...(sensor || points.length > 0 || !event ? [] : [{
        id: `event-fallback-${event.id}`,
        selectId: selectedPointId || 'FP-001',
        sensorId: `event-fallback-${event.id}`,
        eventId: event.id,
        name: event.name,
        source: EVENT_FALLBACK_SOURCE,
        coordinates: event.coordinates,
        depthCm: event.currentDepthCm,
        riskLevel: event.riskLevel,
        fallback: true,
        historical: false,
      }]),
    ]

    const entities = markerData.map((marker) => addGeographicSensorEntity(viewer, {
      entityId: marker.id,
      sensorId: marker.sensorId,
      floodPointId: marker.selectId,
      name: marker.name,
      coordinates: marker.coordinates,
      depthCm: marker.depthCm,
      riskLevel: marker.riskLevel,
      selected: marker.selectId === selectedPointId,
      historical: marker.historical,
      source: marker.source,
      eventId: marker.eventId,
      siteId: marker.siteId,
      fallback: marker.fallback,
    }))
    setSensorEntityCount(entities.length)

    return () => {
      if (!viewer.isDestroyed()) entities.forEach((entity) => viewer.entities.remove(entity))
    }
  }, [event, points, selectedPointId, sensor, selectedPoint, viewerReady])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !viewerReady) return

    const handleClick = (movement: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      const picked = viewer.scene.pick(movement.position) as { id?: unknown; primitive?: unknown } | undefined

      if (LUJIAZUI_CALIBRATION_MODE === 'capture' && source === 'lujiazui' && modelRef.current) {
        if ((picked?.primitive === modelRef.current || picked?.id === 'lujiazui-camera-max-glb') && viewer.scene.pickPositionSupported) {
          const world = viewer.scene.pickPosition(movement.position)
          if (world) {
            const picks = calibrationPicksRef.current
            picks.push(Cesium.Cartesian3.clone(world))
            if (picks.length < LUJIAZUI_CONTROL_POINTS.length) {
              const next = LUJIAZUI_CONTROL_POINTS[picks.length]
              setCalibrationMessage(`校准 ${picks.length + 1}/${LUJIAZUI_CONTROL_POINTS.length}：点击模型中的 ${next.name} 建筑中心`)
            } else {
              try {
                const result = solveLujiazuiSimilarityCorrection(picks)
                const corrected = Cesium.Matrix4.multiply(
                  result.matrix,
                  modelRef.current.modelMatrix,
                  new Cesium.Matrix4(),
                )
                modelRef.current.modelMatrix = corrected
                saveLujiazuiModelMatrix(corrected)
                setGeoreferenceStatus('calibrated')
                setCalibrationMessage(`校准完成 · RMS ${result.rmsResidualM.toFixed(1)} m · 旋转 ${result.headingCorrectionDeg.toFixed(2)}° · 比例 ×${result.scaleCorrection.toFixed(4)} · 已保存`)
                console.info('[CesiumScene] lujiazui-calibration', {
                  rmsResidualM: result.rmsResidualM,
                  headingCorrectionDeg: result.headingCorrectionDeg,
                  scaleCorrection: result.scaleCorrection,
                  modelMatrix: Cesium.Matrix4.toArray(corrected),
                })
              } catch (error) {
                setCalibrationMessage(`校准失败：${error instanceof Error ? error.message : String(error)}。刷新后重试。`)
              } finally {
                calibrationPicksRef.current = []
              }
            }
            return
          }
        }
      }

      const entity = picked && picked.id instanceof Cesium.Entity ? picked.id : null
      const properties = entity?.properties?.getValue(Cesium.JulianDate.now())
      if (typeof properties?.floodPointId === 'string') onPointSelect(properties.floodPointId)
    }

    viewer.screenSpaceEventHandler.setInputAction(handleClick, Cesium.ScreenSpaceEventType.LEFT_CLICK)
    return () => {
      if (!viewer.isDestroyed()) viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK)
    }
  }, [onPointSelect, source, viewerReady])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !viewerReady) return

    const geometryUrl = forecastFrame?.geometryUrl
    const fill = FORECAST_FILL[activeForecast]
    const stroke = FORECAST_STROKE[activeForecast]
    let cancelled = false
    let loadedDataSource: Cesium.GeoJsonDataSource | null = null
    const previousDataSource = forecastDataSourceRef.current
    forecastDataSourceRef.current = null
    if (previousDataSource) viewer.dataSources.remove(previousDataSource, true)
    if (!geometryUrl) {
      setForecastStatus('empty')
      return () => {
        cancelled = true
      }
    }
    setForecastStatus('loading')

    void Cesium.GeoJsonDataSource.load(geometryUrl, {
      clampToGround: true,
      fill,
      stroke,
      strokeWidth: 2,
    }).then((dataSource) => {
      if (cancelled || viewerRef.current !== viewer || viewer.isDestroyed()) return
      dataSource.entities.values.forEach((entity) => {
        if (!entity.polygon) return
        entity.polygon.heightReference = new Cesium.ConstantProperty(Cesium.HeightReference.CLAMP_TO_GROUND)
        entity.polygon.classificationType = new Cesium.ConstantProperty(Cesium.ClassificationType.TERRAIN)
        entity.polygon.outline = new Cesium.ConstantProperty(true)
        entity.polygon.outlineColor = new Cesium.ConstantProperty(stroke)
        entity.polygon.zIndex = new Cesium.ConstantProperty(2)
      })
      dataSource.show = layersDepthRef.current
      loadedDataSource = dataSource
      forecastDataSourceRef.current = dataSource
      viewer.dataSources.add(dataSource)
      setForecastStatus('ready')
    }).catch(() => {
      if (!cancelled) setForecastStatus('error')
    })

    return () => {
      cancelled = true
      if (loadedDataSource && viewerRef.current === viewer && !viewer.isDestroyed()) {
        viewer.dataSources.remove(loadedDataSource, true)
        if (forecastDataSourceRef.current === loadedDataSource) forecastDataSourceRef.current = null
      }
    }
  }, [activeForecast, forecastFrame?.geometryUrl, viewerReady])

  useEffect(() => {
    if (baseImageryRef.current) baseImageryRef.current.show = layers.base
    if (cityLayerRef.current) cityLayerRef.current.show = layers.base
    if (roadDataSourceRef.current) roadDataSourceRef.current.show = layers.base
    if (labelDataSourceRef.current) labelDataSourceRef.current.show = layers.base
  }, [layers.base])

  const sourceReasonSuffix = sourceReason === 'none' ? '' : ` · reason=${sourceReason}`

  return (
    <div
      className="cesium-scene-mount"
      data-scene-mode={sceneMode}
      data-landuse-status={landuseStatus}
      data-landuse-count={landuseCount}
      data-context-surface={visualDemo ? 'building-surface-v3' : 'existing'}
      data-context-loaded={visualDemo ? contextLoaded : undefined}
      ref={containerRef}
      aria-label="上海 Cesium 三维城市底座"
      data-camera-preset={cameraPreset}
      data-source={source ?? 'loading'}
      data-source-reason={sourceReason}
      data-model-source={source === 'lujiazui' ? LUJIAZUI_GLB_URL : 'none'}
      data-model-material={source === 'lujiazui' ? lujiazuiMaterialStatus : 'none'}
      data-model-georeference={source === 'lujiazui' ? georeferenceStatus : 'none'}
      data-model-anchor={source === 'lujiazui' ? `${LUJIAZUI_ANCHOR.lon},${LUJIAZUI_ANCHOR.lat}` : 'none'}
      data-context-source={contextSource}
      data-context-cache-mb={contextSource === 'none' ? '0' : String(CONTEXT_CACHE_BYTES / 1024 / 1024)}
      data-river-clip-count={riverClipCount}
      data-local-tileset={CORE_TILES_URL}
      data-coordinate-system="WGS84 lon/lat"
      data-ground-source="osm-online-dimmed"
      data-hydro-source={SHANGHAI_WATER_POLYGONS_GEOJSON_URL}
      data-hydro-waterways-source={SHANGHAI_WATERWAYS_GEOJSON_URL}
      data-hydro-attribution={SHANGHAI_WATER_SOURCE_LABEL}
      data-hydro-status={hydroStatus}
      data-road-source={roadSourceUrl}
      data-road-attribution={roadAttribution}
      data-road-fallback={roadFallback}
      data-road-status={roadStatus}
      data-label-attribution={CITY_LABEL_SOURCE_LABEL}
      data-label-status={labelStatus}
      data-sensor-entity-count={sensorEntityCount}
      data-sensor-mode={sensor ? 'sensor-state' : 'floodpoint-fallback'}
      data-sensor-id={sensor?.sensorId ?? 'none'}
      data-sensor-source={sensor?.source ?? (sensor ? SENSOR_STATE_SOURCE : FLOOD_POINT_FALLBACK_SOURCE)}
      data-sensor-depth-cm={sensor ? String(sensor.depthCm) : 'none'}
      data-selected-point-id={selectedPointId}
      data-selected-event-id={event?.id ?? 'none'}
      data-forecast-source={activeForecast}
      data-forecast-geometry={forecastFrame?.geometryUrl ?? 'none'}
      data-forecast-status={forecastStatus}
    >
      <div className="scene-camera-presets" style={{ position: 'absolute', top: 34, left: '50%', transform: 'translateX(-50%)', zIndex: 10, display: 'flex', gap: 8, pointerEvents: 'auto' }}>
        <button onClick={() => setCameraPreset('astra-aerial-45')}>Astra aerial_45</button>
        <button onClick={() => setCameraPreset('city')}>{visualDemo ? '城市全景' : '城市业务视角'}</button>
        {visualDemo && <button onClick={() => setCameraPreset('context-close')}>外围材质近景</button>}
        {visualDemo && <a href="/">返回正式 MVP</a>}
      </div>
      {visualDemo && <span className="style-demo-caption">上海 · 冷灰蓝三维 Demo · OSM 地块 {landuseStatus === 'ready' ? landuseCount : landuseStatus}</span>}
      {status === 'loading' && <span className="cesium-scene-status">{CESIUM_ION_TOKEN ? 'LOCAL GLB / OSM BUILDINGS LOADING' : 'LOCAL CITY MODEL LOADING'}</span>}
      {status === 'error' && <span className="cesium-scene-status cesium-scene-status--error">CITY DATA UNAVAILABLE</span>}
      {status === 'ready' && source && <span className="cesium-scene-source">{source === 'lujiazui' ? `LUJIAZUI GLB · ${georeferenceStatus === 'calibrated' ? 'CALIBRATED WGS84' : 'APPROXIMATE WGS84'} · ${lujiazuiMaterialStatus === 'source-pbr' ? 'SOURCE PBR' : lujiazuiMaterialStatus === 'source-factors-readability' ? 'SOURCE FACTORS · TEXTURES MISSING' : 'MATERIAL CHECKING'} · CONTEXT ${contextSource.toUpperCase()} · RIVER MASK ${riverClipCount}` : source === 'osm' ? 'OSM BUILDINGS · OSM ONLINE BASEMAP' : source === 'local' ? `LOCAL HUANGPU · OSM ONLINE BASEMAP${sourceReasonSuffix}` : `DEMO CITY BLOCKS · OSM ONLINE BASEMAP${sourceReasonSuffix}`}</span>}
      {LUJIAZUI_CALIBRATION_MODE === 'capture' && source === 'lujiazui' && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: 14,
            right: 14,
            zIndex: 8,
            maxWidth: 420,
            padding: '10px 12px',
            border: '1px solid rgba(255,154,61,0.65)',
            borderRadius: 8,
            background: 'rgba(7,20,29,0.9)',
            color: '#f4f7f8',
            fontSize: 12,
            lineHeight: 1.5,
            boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
            pointerEvents: 'none',
          }}
        >
          <strong style={{ color: '#ffad5b' }}>陆家嘴 WGS84 快速校准</strong><br />
          {calibrationMessage}<br />
          <span style={{ color: '#9db0ba' }}>目标点为橙色编号。若要重置：?lujiazuiCalibrate=reset</span>
        </div>
      )}
      <a className="cesium-scene-attribution" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Water data © OpenStreetMap contributors · ODbL</a>
    </div>
  )
}
