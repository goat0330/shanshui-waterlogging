import * as Cesium from "cesium"
import "cesium/Build/Cesium/Widgets/widgets.css"
import "./style.css"

type ForecastKey = "NOW" | "PLUS_10" | "PLUS_30"
type SourceKey = "lujiazui-glb" | "shanghai" | "shanghai-local" | "shanghai-core" | "osm" | "local"
type MaterialMode = "style" | "shader"
type LayerKey = "city" | "river" | "flood" | "risk"

const SHANGHAI_TILES_URL = "https://data.mars3d.cn/3dtiles/jzw-shanghai/tileset.json"
const LOCAL_SHANGHAI_TILES_URL = "/data/tiles/shanghai-aoi/tileset.json"
const CORE_SHANGHAI_TILES_URL = "/data/runtime/shanghai-core/tileset.json"
const LUJIAZUI_GLB_URL = "/data/runtime/lujiazui-camera-max/lujiazui.glb"
const SOURCE_LABELS: Record<SourceKey, string> = {
  "lujiazui-glb": "陆家嘴群楼 · GLB local raw",
  shanghai: "Shanghai 3D Tiles · remote",
  "shanghai-local": "Shanghai AOI 本地缓存 · AOI cache",
  "shanghai-core": "Shanghai Core Local · core local",
  osm: "Cesium OSM Buildings · osm",
  local: "Local Demo Blocks · demo blocks"
}
const EVENT = { lon: 121.4874, lat: 31.2297 }
const LUJIAZUI_ANCHOR = { lon: 121.5018, lat: 31.2396 }
const LUJIAZUI_LOCAL_BOUNDS = {
  centerX: 160000,
  baseY: 0,
  centerZ: 150000,
  scale: 0.01,
  heading: 0
}
const LUJIAZUI_CLEANUP_NODE_NAMES = ["Sphere01", "Plane01"]
const BIMANGLE_DEFAULT_ORIGIN = { lon: 116.46, lat: 39.92 }
const HUANGPU_SHP_CENTER = { lon: 121.47797014, lat: 31.21940076 }
const HUANGPU_MODEL_CENTER_LOCAL = { x: 80.3409, y: -53.0326, z: 90 }

const forecastData: Record<ForecastKey, { depth: number; area: number; polygon: number[] }> = {
  NOW: {
    depth: 28.6,
    area: 0.38,
    polygon: [121.484, 31.226, 121.489, 31.226, 121.491, 31.231, 121.487, 31.235, 121.482, 31.232]
  },
  PLUS_10: {
    depth: 35.2,
    area: 0.64,
    polygon: [121.479, 31.223, 121.491, 31.223, 121.496, 31.231, 121.491, 31.239, 121.480, 31.236]
  },
  PLUS_30: {
    depth: 52.4,
    area: 1.28,
    polygon: [121.472, 31.218, 121.496, 31.219, 121.503, 31.232, 121.496, 31.247, 121.475, 31.243]
  }
}

const viewer = new Cesium.Viewer("cesiumContainer", {
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
  terrain: undefined
})

viewer.scene.backgroundColor = Cesium.Color.fromCssColorString("#071421")
viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#0a2232")
viewer.scene.globe.enableLighting = true
viewer.scene.globe.showGroundAtmosphere = false
viewer.scene.fog.enabled = true
viewer.scene.fog.density = 0.00008
viewer.scene.fog.screenSpaceErrorFactor = 2

const cityLayer = new Cesium.PrimitiveCollection()
viewer.scene.primitives.add(cityLayer)

const riverDataSource = new Cesium.CustomDataSource("river-layer")
const floodDataSource = new Cesium.CustomDataSource("flood-layer")
const riskDataSource = new Cesium.CustomDataSource("risk-layer")
const localCityDataSource = new Cesium.CustomDataSource("local-city-layer")
viewer.dataSources.add(riverDataSource)
viewer.dataSources.add(floodDataSource)
viewer.dataSources.add(riskDataSource)
viewer.dataSources.add(localCityDataSource)
localCityDataSource.show = false

const sceneStatus = document.querySelector<HTMLSpanElement>("#sceneStatus")!
const sourceStatus = document.querySelector<HTMLSpanElement>("#sourceStatus")!
const logLine = document.querySelector<HTMLParagraphElement>("#logLine")!
const depthValue = document.querySelector<HTMLElement>("#depthValue")!
const areaValue = document.querySelector<HTMLElement>("#areaValue")!
const sourceSelect = document.querySelector<HTMLSelectElement>("#sourceSelect")!
const materialSelect = document.querySelector<HTMLSelectElement>("#materialSelect")!

let activeTileset: Cesium.Cesium3DTileset | undefined
let activeModel: Cesium.Model | undefined
let currentForecast: ForecastKey = "NOW"
let currentSource: SourceKey = "lujiazui-glb"
let currentMaterialMode: MaterialMode = "style"

const MATERIAL_MODE_LABELS: Record<MaterialMode, string> = {
  style: "uniform blue-gray",
  shader: "blue-gray shader"
}

const BLUE_GRAY_SHADER = new Cesium.CustomShader({
  lightingModel: Cesium.LightingModel.PBR,
  fragmentShaderText: `
    void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
      const vec3 twinTint = vec3(0.10, 0.22, 0.32);
      material.diffuse = mix(material.diffuse, twinTint, 0.82);
      material.roughness = max(material.roughness, 0.72);
      material.emissive *= 0.15;
    }
  `
})

function setStatus(text: string, state: "pending" | "ready" | "error") {
  sceneStatus.textContent = text
  sceneStatus.className = `status-pill ${state}`
}

function setLog(text: string) {
  logLine.textContent = text
}

function applyCoreShanghaiPlacement(tileset: Cesium.Cesium3DTileset) {
  const sourceFrame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(BIMANGLE_DEFAULT_ORIGIN.lon, BIMANGLE_DEFAULT_ORIGIN.lat, 0)
  )
  const targetFrame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(HUANGPU_SHP_CENTER.lon, HUANGPU_SHP_CENTER.lat, 0)
  )
  const sourceCenterFrame = Cesium.Matrix4.multiply(
    sourceFrame,
    Cesium.Matrix4.fromTranslation(
      Cesium.Cartesian3.fromElements(
        HUANGPU_MODEL_CENTER_LOCAL.x,
        HUANGPU_MODEL_CENTER_LOCAL.y,
        HUANGPU_MODEL_CENTER_LOCAL.z
      ),
      new Cesium.Matrix4()
    ),
    new Cesium.Matrix4()
  )
  const sourceInverse = Cesium.Matrix4.inverse(sourceCenterFrame, new Cesium.Matrix4())
  tileset.modelMatrix = Cesium.Matrix4.multiply(targetFrame, sourceInverse, new Cesium.Matrix4())
}

function createLujiazuiModelMatrix() {
  const anchorFrame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(LUJIAZUI_ANCHOR.lon, LUJIAZUI_ANCHOR.lat, 0)
  )
  const modelAxes = Cesium.Matrix3.fromArray([
    1, 0, 0,
    0, 0, 1,
    0, 1, 0
  ])
  const headingRotation = Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(LUJIAZUI_LOCAL_BOUNDS.heading))
  const enuFromModel = Cesium.Matrix3.multiply(headingRotation, modelAxes, new Cesium.Matrix3())
  const enuFromModelFrame = Cesium.Matrix4.fromRotationTranslation(enuFromModel, Cesium.Cartesian3.ZERO)
  const localScale = Cesium.Matrix4.fromUniformScale(LUJIAZUI_LOCAL_BOUNDS.scale)
  const localCenter = Cesium.Matrix4.fromTranslation(
    Cesium.Cartesian3.fromElements(
      -LUJIAZUI_LOCAL_BOUNDS.centerX,
      -LUJIAZUI_LOCAL_BOUNDS.baseY,
      -LUJIAZUI_LOCAL_BOUNDS.centerZ
    )
  )
  const scaledLocal = Cesium.Matrix4.multiply(localScale, localCenter, new Cesium.Matrix4())
  const geographicLocal = Cesium.Matrix4.multiply(enuFromModelFrame, scaledLocal, new Cesium.Matrix4())
  return Cesium.Matrix4.multiply(anchorFrame, geographicLocal, new Cesium.Matrix4())
}

function flyToLujiazui() {
  const target = Cesium.Cartesian3.fromDegrees(LUJIAZUI_ANCHOR.lon, LUJIAZUI_ANCHOR.lat, 0)
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 1700), {
    offset: new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(25),
      Cesium.Math.toRadians(-38),
      5600
    ),
    duration: 1.4
  })
  setLog("已 FlyTo 陆家嘴 GLB 试验 anchor；业务事件仍保留独立 geographic entity")
}

function applyLujiazuiLighting(model: Cesium.Model) {
  const anchorFrame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(LUJIAZUI_ANCHOR.lon, LUJIAZUI_ANCHOR.lat, 0)
  )
  const enuToFixed = Cesium.Matrix4.getMatrix3(anchorFrame, new Cesium.Matrix3())
  const lightFromSurfaceEnu = Cesium.Cartesian3.normalize(
    new Cesium.Cartesian3(-0.35, -0.25, 0.9),
    new Cesium.Cartesian3()
  )
  const lightFromSurfaceFixed = Cesium.Matrix3.multiplyByVector(
    enuToFixed,
    lightFromSurfaceEnu,
    new Cesium.Cartesian3()
  )
  const lightDirection = Cesium.Cartesian3.negate(
    lightFromSurfaceFixed,
    new Cesium.Cartesian3()
  )
  viewer.scene.skyAtmosphere = new Cesium.SkyAtmosphere()
  viewer.scene.skyAtmosphere.hueShift = 0.58
  viewer.scene.skyAtmosphere.saturationShift = -0.18
  viewer.scene.skyAtmosphere.brightnessShift = -0.12
  viewer.scene.light = new Cesium.DirectionalLight({
    direction: lightDirection,
    color: Cesium.Color.fromCssColorString("#dbeeff"),
    intensity: 1.35
  })
  viewer.scene.shadowMap.enabled = true
  viewer.scene.shadowMap.softShadows = true
  viewer.scene.shadowMap.darkness = 0.62
  viewer.scene.shadowMap.maximumDistance = 6000
  // AO blackens this raw GLB in the current Chromium smoke environment; keep
  // the stage off so the material evidence remains readable.
  viewer.scene.postProcessStages.ambientOcclusion.enabled = false
  viewer.scene.postProcessStages.bloom.enabled = true
  viewer.scene.postProcessStages.bloom.uniforms.brightness = -0.18
  viewer.scene.postProcessStages.bloom.uniforms.contrast = 100.0
  viewer.scene.postProcessStages.bloom.uniforms.sigma = 2.0
  viewer.scene.postProcessStages.bloom.uniforms.stepSize = 1.0
  model.imageBasedLighting.imageBasedLightingFactor = new Cesium.Cartesian2(0.82, 0.62)
  model.lightColor = new Cesium.Cartesian3(1.0, 0.95, 0.9)
  model.shadows = Cesium.ShadowMode.ENABLED
}

function cleanupLujiazuiModel(model: Cesium.Model) {
  const hiddenNodes = LUJIAZUI_CLEANUP_NODE_NAMES.filter((nodeName) => {
    const node = model.getNode(nodeName)
    if (!node) return false
    node.show = false
    return true
  })
  return hiddenNodes.join(",") || "none"
}

function addRiverLayer() {
  riverDataSource.entities.add({
    id: "demo-huangpu-river",
    name: "黄浦江水系表达（场景几何）",
    polygon: {
      hierarchy: Cesium.Cartesian3.fromDegreesArray([
        121.496, 31.285,
        121.516, 31.283,
        121.512, 31.263,
        121.505, 31.247,
        121.512, 31.231,
        121.505, 31.214,
        121.495, 31.190,
        121.476, 31.190,
        121.484, 31.214,
        121.491, 31.232,
        121.485, 31.250,
        121.496, 31.285
      ]),
      material: Cesium.Color.fromCssColorString("#17495e").withAlpha(0.78),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString("#28c2c4").withAlpha(0.35),
      height: 1
    }
  })
}

function addFloodLayers() {
  for (const [key, data] of Object.entries(forecastData) as [ForecastKey, typeof forecastData.NOW][]) {
    const entity = floodDataSource.entities.add({
      id: `flood-${key}`,
      name: `积水预测 ${key}`,
      polygon: {
        hierarchy: Cesium.Cartesian3.fromDegreesArray(data.polygon),
        material: Cesium.Color.fromCssColorString(key === "PLUS_30" ? "#ff9a37" : "#208dff").withAlpha(key === "NOW" ? 0.58 : 0.32),
        outline: true,
        outlineColor: key === "PLUS_30" ? Cesium.Color.ORANGE.withAlpha(0.9) : Cesium.Color.CYAN.withAlpha(0.7),
        height: 4,
        extrudedHeight: key === "PLUS_30" ? 8 : 5
      },
      properties: {
        timeKey: key,
        maxDepthCm: data.depth,
        affectedAreaKm2: data.area
      }
    })
    entity.show = key === currentForecast
  }
}

function addRiskLayer() {
  riskDataSource.entities.add({
    id: "risk-event-FP202506010024",
    name: "人民路 × 滨江大道",
    position: Cesium.Cartesian3.fromDegrees(EVENT.lon, EVENT.lat, 18),
    point: {
      color: Cesium.Color.fromCssColorString("#ff5b4d"),
      outlineColor: Cesium.Color.fromCssColorString("#ffe8cc"),
      outlineWidth: 3,
      pixelSize: 15,
      heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND
    },
    label: {
      text: "人民路 × 滨江大道  ·  28.6 cm",
      font: "14px Microsoft YaHei, sans-serif",
      fillColor: Cesium.Color.WHITE,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString("#8b4218").withAlpha(0.88),
      backgroundPadding: new Cesium.Cartesian2(10, 7),
      pixelOffset: new Cesium.Cartesian2(0, -34),
      heightReference: Cesium.HeightReference.RELATIVE_TO_GROUND
    },
    ellipse: {
      semiMajorAxis: 100,
      semiMinorAxis: 100,
      material: Cesium.Color.fromCssColorString("#ff9a37").withAlpha(0.18),
      outline: true,
      outlineColor: Cesium.Color.fromCssColorString("#ff9a37").withAlpha(0.85),
      height: 6
    },
    properties: {
      eventId: "FP202506010024",
      riskLevel: "HIGH",
      currentDepthCm: 28.6,
      riseRateCmMin: 1.8
    }
  })
}

function addLocalCityLayer() {
  for (let x = -7; x <= 7; x += 1) {
    for (let y = -7; y <= 7; y += 1) {
      const lon = EVENT.lon + x * 0.0042
      const lat = EVENT.lat + y * 0.0036
      const height = 90 + ((x * x * 19 + y * y * 23 + (x + 10) * (y + 11) * 7) % 360)
      const position = Cesium.Cartesian3.fromDegrees(lon, lat, height / 2)
      localCityDataSource.entities.add({
        id: `local-building-${x}-${y}`,
        name: "本地演示建筑块",
        position,
        box: {
          dimensions: new Cesium.Cartesian3(220, 220, height),
          material: Cesium.Color.fromCssColorString(height > 360 ? "#8db5c2" : "#6f8fa7").withAlpha(0.86),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString("#b8e6ef").withAlpha(0.35)
        },
        properties: {
          source: "local-demo-blocks",
          isOfficialShanghaiModel: false
        }
      })
    }
  }
}

function updateForecast(next: ForecastKey) {
  currentForecast = next
  const data = forecastData[next]
  depthValue.textContent = data.depth.toFixed(1)
  areaValue.textContent = data.area.toFixed(2)
  for (const entity of floodDataSource.entities.values) {
    entity.show = entity.id === `flood-${next}`
  }
  document.querySelectorAll<HTMLButtonElement>(".forecast-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.forecast === next)
  })
  setLog(`预测状态 ${next} 已切换，中央积水范围同步更新`)
}

function updateLayer(key: LayerKey, visible: boolean) {
  if (key === "city") {
    cityLayer.show = visible
    localCityDataSource.show = visible && currentSource === "local"
  }
  if (key === "river") riverDataSource.show = visible
  if (key === "flood") floodDataSource.show = visible
  if (key === "risk") riskDataSource.show = visible
  setLog(`${key} 图层：${visible ? "显示" : "隐藏"}`)
}

function flyToEvent() {
  const target = Cesium.Cartesian3.fromDegrees(EVENT.lon, EVENT.lat, 0)
  viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(target, 250), {
    offset: new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(28),
      Cesium.Math.toRadians(-52),
      8500
    ),
    duration: 1.4
  })
  setLog("已 FlyTo 当前风险事件：人民路 × 滨江大道")
}

function applyMaterialMode() {
  if (activeModel) {
    setLog(`[source=${SOURCE_LABELS[currentSource]}] GLB 保留原始材质；本轮不应用 Tileset 着色`)
    return
  }
  if (!activeTileset) return

  if (currentMaterialMode === "shader") {
    activeTileset.style = undefined
    activeTileset.customShader = BLUE_GRAY_SHADER
    return
  }

  activeTileset.customShader = undefined
  activeTileset.style = new Cesium.Cesium3DTileStyle({
    color: "color('#6f8fa7', 0.78)"
  })
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

async function loadCitySource(source: SourceKey) {
  currentSource = source
  setStatus("加载中", "pending")
  sourceStatus.textContent = SOURCE_LABELS[source]
  setLog(`[source=${SOURCE_LABELS[source]}] 正在加载…`)

  if (activeTileset) {
    cityLayer.remove(activeTileset)
    activeTileset = undefined
  }
  if (activeModel) {
    cityLayer.remove(activeModel)
    activeModel = undefined
  }
  localCityDataSource.show = false

  try {
    if (source === "local") {
      localCityDataSource.show = cityLayer.show
      setStatus("已加载", "ready")
      flyToEvent()
      setLog("[source=demo blocks] 本地演示城市已加载，无外部三维网址依赖；模型不代表真实上海建筑")
      return
    }

    if (source === "lujiazui-glb") {
      const model = await Cesium.Model.fromGltfAsync({
        url: LUJIAZUI_GLB_URL,
        scene: viewer.scene,
        modelMatrix: createLujiazuiModelMatrix(),
        shadows: Cesium.ShadowMode.ENABLED,
        id: "lujiazui-camera-max-glb"
      })
      activeModel = model
      cityLayer.add(model)
      await waitForModelReady(model)
      const hiddenNodes = cleanupLujiazuiModel(model)
      applyLujiazuiLighting(model)
      flyToLujiazui()
      setStatus("已加载", "ready")
      setLog(`[source=${SOURCE_LABELS[source]}] GLB 已加载；anchor=陆家嘴东岸；scale=${LUJIAZUI_LOCAL_BOUNDS.scale}；原始材质 + Cesium 光照/IBL/阴影/Bloom；AO 为兼容性关闭；cleanup=${hiddenNodes}`)
      return
    }

    if (source === "shanghai" || source === "shanghai-local" || source === "shanghai-core") {
      const tilesUrl = source === "shanghai" ? SHANGHAI_TILES_URL : source === "shanghai-local" ? LOCAL_SHANGHAI_TILES_URL : CORE_SHANGHAI_TILES_URL
      if (source === "shanghai-core") {
        let response: Response
        try {
          response = await fetch(CORE_SHANGHAI_TILES_URL, { cache: "no-store" })
        } catch {
          throw new Error(`本地核心模型尚未就绪：无法访问 ${CORE_SHANGHAI_TILES_URL}`)
        }
        if (!response.ok) {
          throw new Error(`本地核心模型尚未就绪：${CORE_SHANGHAI_TILES_URL} 返回 HTTP ${response.status}`)
        }
      }
      activeTileset = await Cesium.Cesium3DTileset.fromUrl(tilesUrl, { maximumScreenSpaceError: 3 })
      if (source === "shanghai-core") {
        // BimAngle's current export carries its default Beijing ENU anchor;
        // keep the raw Tiles and apply the temporary Shanghai smoke placement at runtime.
        applyCoreShanghaiPlacement(activeTileset)
      }
    } else {
      const token = import.meta.env.VITE_CESIUM_ION_TOKEN
      if (!token) {
        throw new Error("缺少 VITE_CESIUM_ION_TOKEN，OSM Buildings 仅作为可选 fallback")
      }
      Cesium.Ion.defaultAccessToken = token
      activeTileset = await Cesium.createOsmBuildingsAsync()
    }

    cityLayer.add(activeTileset)
    applyMaterialMode()
    if (source === "shanghai-core") flyToEvent()
    setStatus("已加载", "ready")
    setLog(`[source=${SOURCE_LABELS[source]}] ${source === "shanghai" ? "上海 3D Tiles" : source === "shanghai-local" ? "上海 AOI 本地缓存" : source === "shanghai-core" ? "上海核心模型" : "OSM Buildings"} 已加载；material=${MATERIAL_MODE_LABELS[currentMaterialMode]}`)
  } catch (error) {
    if (source === "lujiazui-glb" && activeModel) {
      cityLayer.remove(activeModel)
      activeModel = undefined
    }
    if (source === "shanghai") {
      currentSource = "local"
      sourceSelect.value = "local"
      sourceStatus.textContent = SOURCE_LABELS.local
      localCityDataSource.show = cityLayer.show
      setStatus("已加载", "ready")
      console.warn("[L1 Cesium] Shanghai tiles unavailable; using local demo blocks", error)
      flyToEvent()
      setLog("[source=remote → demo blocks] 上海 3D Tiles 当前不可达，已切换本地演示城市；本地模型不代表真实上海建筑")
      return
    }
    if (source === "shanghai-core") {
      sourceStatus.textContent = "Shanghai Core Local · 未就绪"
      setStatus("本地核心模型尚未就绪", "error")
      setLog(`[source=core local] 本地核心模型尚未就绪；未使用真实上海核心模型。预留入口：${CORE_SHANGHAI_TILES_URL}`)
      console.warn("[L1 Cesium] core local model is not ready", error)
      return
    }
    setStatus("加载失败", "error")
    const message = error instanceof Error ? error.message : String(error)
    setLog(message)
    console.error("[L1 Cesium] source load failed", error)
  }
}

addRiverLayer()
addFloodLayers()
addRiskLayer()
addLocalCityLayer()
updateForecast("NOW")

viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(121.487, 31.23, 18000),
  orientation: {
    heading: Cesium.Math.toRadians(5),
    pitch: Cesium.Math.toRadians(-52),
    roll: 0
  }
})

document.querySelectorAll<HTMLButtonElement>(".forecast-button").forEach((button) => {
  button.addEventListener("click", () => updateForecast(button.dataset.forecast as ForecastKey))
})

document.querySelectorAll<HTMLInputElement>("[data-layer]").forEach((input) => {
  input.addEventListener("change", () => updateLayer(input.dataset.layer as LayerKey, input.checked))
})

document.querySelector<HTMLButtonElement>("#flyToEvent")!.addEventListener("click", flyToEvent)
document.querySelector<HTMLButtonElement>("#reloadSource")!.addEventListener("click", () => loadCitySource(sourceSelect.value as SourceKey))
materialSelect.addEventListener("change", () => {
  currentMaterialMode = materialSelect.value as MaterialMode
  if (!activeTileset) {
    setLog(`[source=${SOURCE_LABELS[currentSource]}] material=${MATERIAL_MODE_LABELS[currentMaterialMode]}；当前 GLB 保留原始材质或 source 没有可着色 Tileset`)
    return
  }
  applyMaterialMode()
  setLog(`[source=${SOURCE_LABELS[currentSource]}] material=${MATERIAL_MODE_LABELS[currentMaterialMode]} 已应用；Style 与 CustomShader 保持互斥`)
})

void loadCitySource(currentSource)
