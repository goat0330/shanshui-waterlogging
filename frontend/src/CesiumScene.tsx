import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import type { FloodEvent, FloodPoint, ForecastFrame, ForecastKey, SensorState } from './types'
import { CITY_LABEL_SOURCE_LABEL, loadCityLabelLayer } from './scene/cityLabelLayer'
import { addDemoCityBlocks } from './scene/demoCityLayer'
import { SHANGHAI_WATER_POLYGONS_GEOJSON_URL, SHANGHAI_WATER_SOURCE_LABEL, SHANGHAI_WATERWAYS_GEOJSON_URL, loadShanghaiHydroSystemLayer } from './scene/hydroSystemLayer'
import { loadMajorRoadLayer, MAJOR_ROADS_GEOJSON_URL, MAJOR_ROADS_SOURCE_LABEL } from './scene/majorRoadLayer'
import { addGeographicSensorEntity } from './scene/sensorEntity'
import {
  LUJIAZUI_ANCHOR,
  LUJIAZUI_CONTROL_POINTS,
  LUJIAZUI_GLB_URL,
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
const LUJIAZUI_CLEANUP_NODE_NAMES = ['Sphere01', 'Plane01']
const LUJIAZUI_CALIBRATION_MODE = getLujiazuiCalibrationMode()
const OSM_BUILDING_STYLE = new Cesium.Cesium3DTileStyle({ color: "color('#c8c2b8', 0.94)" })
const LUJIAZUI_UNTEXTURED_FALLBACK_SHADER = new Cesium.CustomShader({
  lightingModel: Cesium.LightingModel.PBR,
  fragmentShaderText: `
    void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
      const vec3 facadeTint = vec3(0.38, 0.50, 0.56);
      material.diffuse = mix(material.diffuse, facadeTint, 0.82);
      material.specular = vec3(0.12);
      material.roughness = max(material.roughness, 0.74);
      material.emissive = max(material.emissive, vec3(0.025, 0.04, 0.05));
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

type LujiazuiMaterialStatus = 'unknown' | 'source-pbr' | 'procedural-fallback'

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

function applyLujiazuiLighting(viewer: Cesium.Viewer, model: Cesium.Model) {
  const anchorFrame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(LUJIAZUI_ANCHOR.lon, LUJIAZUI_ANCHOR.lat, 0),
  )
  const enuToFixed = Cesium.Matrix4.getMatrix3(anchorFrame, new Cesium.Matrix3())
  const lightFromSurfaceEnu = Cesium.Cartesian3.normalize(
    new Cesium.Cartesian3(-0.42, -0.28, 0.86),
    new Cesium.Cartesian3(),
  )
  const lightFromSurfaceFixed = Cesium.Matrix3.multiplyByVector(
    enuToFixed,
    lightFromSurfaceEnu,
    new Cesium.Cartesian3(),
  )

  viewer.scene.highDynamicRange = viewer.scene.highDynamicRangeSupported
  viewer.scene.postProcessStages.exposure = 0.92
  viewer.scene.atmosphere.dynamicLighting = Cesium.DynamicAtmosphereLightingType.SCENE_LIGHT
  viewer.scene.atmosphere.hueShift = 0.02
  viewer.scene.atmosphere.saturationShift = -0.28
  viewer.scene.atmosphere.brightnessShift = -0.1
  viewer.scene.skyAtmosphere = new Cesium.SkyAtmosphere()
  viewer.scene.skyAtmosphere.hueShift = 0.02
  viewer.scene.skyAtmosphere.saturationShift = -0.26
  viewer.scene.skyAtmosphere.brightnessShift = -0.12
  viewer.scene.light = new Cesium.DirectionalLight({
    direction: Cesium.Cartesian3.negate(lightFromSurfaceFixed, new Cesium.Cartesian3()),
    color: Cesium.Color.fromCssColorString('#e3ebee'),
    intensity: 1.05,
  })
  viewer.scene.shadowMap.enabled = true
  viewer.scene.shadowMap.softShadows = true
  viewer.scene.shadowMap.darkness = 0.48
  viewer.scene.shadowMap.maximumDistance = 6500

  const ambientOcclusion = viewer.scene.postProcessStages.ambientOcclusion
  ambientOcclusion.enabled = true
  ambientOcclusion.uniforms.intensity = 2.25
  ambientOcclusion.uniforms.bias = 0.08
  ambientOcclusion.uniforms.lengthCap = 0.55
  ambientOcclusion.uniforms.stepSize = 1.55
  ambientOcclusion.uniforms.frustumLength = 5000

  const bloom = viewer.scene.postProcessStages.bloom
  bloom.enabled = true
  bloom.uniforms.brightness = -0.32
  bloom.uniforms.contrast = 82.0
  bloom.uniforms.sigma = 2.0
  bloom.uniforms.stepSize = 1.0

  model.imageBasedLighting.imageBasedLightingFactor = new Cesium.Cartesian2(0.92, 1.0)
  model.shadows = Cesium.ShadowMode.ENABLED
  const environment = model.environmentMapManager
  environment.enabled = true
  environment.atmosphereScatteringIntensity = 2.4
  environment.brightness = 0.92
  environment.saturation = 0.72
  environment.groundColor = Cesium.Color.fromCssColorString('#4a5355')
  environment.groundAlbedo = 0.2
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

export function CesiumScene({ event, points, sensor = null, activeForecast, forecastFrame, selectedPointId, layers, onPointSelect, onSelectedPointScreenPosition }: CesiumSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const basemapLayerRef = useRef<Cesium.ImageryLayer | null>(null)
  const baseImageryRef = basemapLayerRef
  const lastAnchorRef = useRef<SceneAnchorPosition | null>(null)
  const cityLayerRef = useRef<Cesium.PrimitiveCollection | null>(null)
  const hydroDataSourceRef = useRef<Cesium.GeoJsonDataSource[]>([])
  const roadDataSourceRef = useRef<Cesium.GeoJsonDataSource | null>(null)
  const labelDataSourceRef = useRef<Cesium.CustomDataSource | null>(null)
  const forecastDataSourceRef = useRef<Cesium.GeoJsonDataSource | null>(null)
  const modelRef = useRef<Cesium.Model | null>(null)
  const calibrationPicksRef = useRef<Cesium.Cartesian3[]>([])
  const calibrationMarkerRefs = useRef<Cesium.Entity[]>([])
  const layersDepthRef = useRef(layers.depth)
  const [viewerReady, setViewerReady] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [source, setSource] = useState<'lujiazui' | 'osm' | 'local' | 'demo' | null>(null)
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
    viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0a1118')
    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0d1921')
    const basemapProvider = new Cesium.OpenStreetMapImageryProvider({
      url: OSM_BASEMAP_URL,
      maximumLevel: 19,
    })
    const basemapLayer = viewer.imageryLayers.addImageryProvider(basemapProvider, 0)
    basemapLayer.alpha = 0.72
    basemapLayer.brightness = 0.48
    basemapLayer.contrast = 1.14
    basemapLayer.saturation = 0.18
    basemapLayer.show = layers.base
    basemapLayerRef.current = basemapLayer
    viewer.scene.globe.enableLighting = false
    viewer.scene.globe.showGroundAtmosphere = false
    viewer.scene.globe.depthTestAgainstTerrain = WORLD_TERRAIN_ENABLED
    viewer.scene.fog.enabled = true
    viewer.scene.fog.density = 0.00008
    viewer.scene.fog.screenSpaceErrorFactor = 2
    viewerRef.current = viewer
    setViewerReady(true)

    let disposed = false

    const loadLocalCore = async (attemptReason: SourceAttemptReason) => {
      try {
        const tileset = await Cesium.Cesium3DTileset.fromUrl(CORE_TILES_URL, { maximumScreenSpaceError: 3 })
        if (disposed) {
          tileset.destroy()
          return
        }
        placeHuangpuByRange(tileset)
        tileset.style = new Cesium.Cesium3DTileStyle({ color: "color('#beb9b0', 0.96)" })
        cityLayer.add(tileset)
        setSource('local')
        setSourceReason(attemptReason)
        setStatus('ready')
        viewer.camera.flyToBoundingSphere(tileset.boundingSphere, {
          offset: new Cesium.HeadingPitchRange(
            Cesium.Math.toRadians(28),
            Cesium.Math.toRadians(-42),
            6500,
          ),
          duration: 0.8,
        })
      } catch {
        if (disposed) return
        setSourceReason(getLocalFailureReason(attemptReason))
        try {
          addDemoCityBlocks(cityLayer)
          setSource('demo')
          setStatus('ready')
          flyToTarget(viewer, target)
        } catch {
          setStatus('error')
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
          shadows: Cesium.ShadowMode.ENABLED,
          backFaceCulling: false,
          gltfCallback: (gltf) => {
            gltfImageCount = Array.isArray(gltf.images) ? gltf.images.length : 0
          },
          environmentMapOptions: {
            enabled: true,
            maximumPositionEpsilon: 600,
            maximumSecondsDifference: 1800,
            atmosphereScatteringIntensity: 2.4,
            brightness: 0.92,
            saturation: 0.72,
            groundColor: Cesium.Color.fromCssColorString('#4a5355'),
            groundAlbedo: 0.2,
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
        if (gltfImageCount === 0) {
          model.customShader = LUJIAZUI_UNTEXTURED_FALLBACK_SHADER
          setLujiazuiMaterialStatus('procedural-fallback')
        } else {
          setLujiazuiMaterialStatus('source-pbr')
          applyLujiazuiLighting(viewer, model)
        }
        if (LUJIAZUI_CALIBRATION_MODE === 'capture') {
          calibrationMarkerRefs.current = addLujiazuiCalibrationMarkers(viewer)
        }
        setSource('lujiazui')
        setSourceReason('none')
        setStatus('ready')
        flyToTarget(viewer, LUJIAZUI_ANCHOR, 1)
        console.info(`[CesiumScene] source=lujiazui-glb georef=${initialPlacement.status} material=gltf-pbr cleanup=${hiddenNodes}`)
        return true
      } catch (error) {
        if (modelAdded && model) cityLayer.remove(model)
        modelRef.current = null
        console.warn('[CesiumScene] Lujiazui GLB unavailable; continuing with OSM/local fallback', error)
        return false
      }
    }

    const loadOsmBuildings = async () => {
      if (await loadLujiazuiModel()) return
      if (disposed) return
      if (!CESIUM_ION_TOKEN) {
        await loadLocalCore('token_missing')
        return
      }

      try {
        const tileset = await Cesium.createOsmBuildingsAsync({
          style: OSM_BUILDING_STYLE,
          showOutline: false,
          enableShowOutline: false,
        })
        if (disposed) {
          tileset.destroy()
          return
        }
        cityLayer.add(tileset)
        setSource('osm')
        setSourceReason('none')
        setStatus('ready')
        flyToTarget(viewer, target, 1)

      } catch {
        if (!disposed) await loadLocalCore('osm_init_failed')
      }
    }

    void loadOsmBuildings()

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
      viewerRef.current = null
      setViewerReady(false)
      viewer.destroy()
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !viewerReady) return
    flyToTarget(viewer, target)
  }, [target.lat, target.lon, viewerReady, source])

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
    void loadShanghaiHydroSystemLayer(viewer).then((dataSource) => {
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
    void loadMajorRoadLayer(viewer).then(async (result) => {
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
      ref={containerRef}
      aria-label="上海 Cesium 三维城市底座"
      data-source={source ?? 'loading'}
      data-source-reason={sourceReason}
      data-model-source={source === 'lujiazui' ? LUJIAZUI_GLB_URL : 'none'}
      data-model-material={source === 'lujiazui' ? lujiazuiMaterialStatus : 'none'}
      data-model-georeference={source === 'lujiazui' ? georeferenceStatus : 'none'}
      data-model-anchor={source === 'lujiazui' ? `${LUJIAZUI_ANCHOR.lon},${LUJIAZUI_ANCHOR.lat}` : 'none'}
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
      {status === 'loading' && <span className="cesium-scene-status">{CESIUM_ION_TOKEN ? 'LOCAL GLB / OSM BUILDINGS LOADING' : 'LOCAL CITY MODEL LOADING'}</span>}
      {status === 'error' && <span className="cesium-scene-status cesium-scene-status--error">CITY DATA UNAVAILABLE</span>}
      {status === 'ready' && source && <span className="cesium-scene-source">{source === 'lujiazui' ? `LUJIAZUI GLB · ${georeferenceStatus === 'calibrated' ? 'CALIBRATED WGS84' : 'APPROXIMATE WGS84'} · ${lujiazuiMaterialStatus === 'source-pbr' ? 'SOURCE PBR' : lujiazuiMaterialStatus === 'procedural-fallback' ? 'PROCEDURAL FALLBACK · TEXTURES MISSING' : 'MATERIAL CHECKING'}` : source === 'osm' ? 'OSM BUILDINGS · OSM ONLINE BASEMAP' : source === 'local' ? `LOCAL HUANGPU · OSM ONLINE BASEMAP${sourceReasonSuffix}` : `DEMO CITY BLOCKS · OSM ONLINE BASEMAP${sourceReasonSuffix}`}</span>}
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
