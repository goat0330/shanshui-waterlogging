import * as Cesium from 'cesium'

export const LUJIAZUI_GLB_URL = '/runtime/lujiazui-camera-max/lujiazui.glb?v=astra-context'
export const LUJIAZUI_ANCHOR = { lon: 121.5014, lat: 31.2357 }
export const LUJIAZUI_LOCAL_BOUNDS = {
  centerX: 93665,
  baseY: 267.0371,
  centerZ: 142626,
  scale: 0.01,
  heading: 0,
}

// Keep lower-detail context outside the purchased high-detail inset. The GLB
// remains the foreground model; OSM/local tiles stay visible around it.
export const LUJIAZUI_DETAIL_FOOTPRINT: readonly { lon: number; lat: number }[] = [
  { lon: 121.4919, lat: 31.2446 },
  { lon: 121.4960, lat: 31.2468 },
  { lon: 121.5029, lat: 31.2461 },
  { lon: 121.5087, lat: 31.2426 },
  { lon: 121.5102, lat: 31.2362 },
  { lon: 121.5077, lat: 31.2306 },
  { lon: 121.5025, lat: 31.2278 },
  { lon: 121.4964, lat: 31.2298 },
  { lon: 121.4924, lat: 31.2353 },
] as const

export const LUJIAZUI_WATER_CLIP_BBOX = {
  west: 121.488,
  south: 31.224,
  east: 121.516,
  north: 31.250,
}

const MODEL_MATRIX_STORAGE_KEY = 'qixiao:lujiazui-model-matrix:v2'

export function createLujiazuiContextClippingPolygons() {
  return new Cesium.ClippingPolygonCollection({
    polygons: [
      new Cesium.ClippingPolygon({
        positions: LUJIAZUI_DETAIL_FOOTPRINT.map((point) => Cesium.Cartesian3.fromDegrees(point.lon, point.lat)),
      }),
    ],
  })
}

export type LujiazuiGeoreferenceStatus = 'approximate' | 'calibrated'

export interface LujiazuiControlPoint {
  id: string
  name: string
  lon: number
  lat: number
}

// WGS84 control points from Wikidata/OpenStreetMap-backed locations. They are
// used only to calibrate the purchased model; they do not alter application data.
export const LUJIAZUI_CONTROL_POINTS: readonly LujiazuiControlPoint[] = [
  { id: 'oriental-pearl', name: '东方明珠', lon: 121.4947167, lat: 31.2416694 },
  { id: 'shanghai-tower', name: '上海中心', lon: 121.5010000, lat: 31.2355000 },
  { id: 'jin-mao', name: '金茂大厦', lon: 121.5013889, lat: 31.2372222 },
  { id: 'swfc', name: '环球金融中心', lon: 121.5027778, lat: 31.2366667 },
] as const

export interface LujiazuiCalibrationResult {
  matrix: Cesium.Matrix4
  rmsResidualM: number
  scaleCorrection: number
  headingCorrectionDeg: number
}

export function getLujiazuiCalibrationMode(): 'off' | 'capture' | 'reset' {
  const value = new URLSearchParams(window.location.search).get('lujiazuiCalibrate')
  if (value === 'reset') return 'reset'
  return value === '1' ? 'capture' : 'off'
}

export function createDefaultLujiazuiModelMatrix() {
  const anchorFrame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(LUJIAZUI_ANCHOR.lon, LUJIAZUI_ANCHOR.lat, 0),
  )
  const modelAxes = Cesium.Matrix3.fromArray([
    1, 0, 0,
    0, 0, 1,
    0, -1, 0,
  ])
  const headingRotation = Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(LUJIAZUI_LOCAL_BOUNDS.heading))
  const enuFromModel = Cesium.Matrix3.multiply(headingRotation, modelAxes, new Cesium.Matrix3())
  const enuFromModelFrame = Cesium.Matrix4.fromRotationTranslation(enuFromModel, Cesium.Cartesian3.ZERO)
  const localScale = Cesium.Matrix4.fromUniformScale(LUJIAZUI_LOCAL_BOUNDS.scale)
  const localCenter = Cesium.Matrix4.fromTranslation(Cesium.Cartesian3.fromElements(
    -LUJIAZUI_LOCAL_BOUNDS.centerX,
    -LUJIAZUI_LOCAL_BOUNDS.baseY,
    -LUJIAZUI_LOCAL_BOUNDS.centerZ,
  ))
  const scaledLocal = Cesium.Matrix4.multiply(localScale, localCenter, new Cesium.Matrix4())
  const geographicLocal = Cesium.Matrix4.multiply(enuFromModelFrame, scaledLocal, new Cesium.Matrix4())
  return Cesium.Matrix4.multiply(anchorFrame, geographicLocal, new Cesium.Matrix4())
}

export function clearStoredLujiazuiModelMatrix() {
  try {
    window.localStorage.removeItem(MODEL_MATRIX_STORAGE_KEY)
  } catch {
    // localStorage can be unavailable in locked-down browsers; fallback remains deterministic.
  }
}

export function loadStoredLujiazuiModelMatrix(): Cesium.Matrix4 | null {
  try {
    const raw = window.localStorage.getItem(MODEL_MATRIX_STORAGE_KEY)
    if (!raw) return null
    const values = JSON.parse(raw)
    if (!Array.isArray(values) || values.length !== 16 || values.some((value) => !Number.isFinite(value))) return null
    return Cesium.Matrix4.fromArray(values)
  } catch {
    return null
  }
}

export function saveLujiazuiModelMatrix(matrix: Cesium.Matrix4) {
  try {
    window.localStorage.setItem(MODEL_MATRIX_STORAGE_KEY, JSON.stringify(Cesium.Matrix4.toArray(matrix)))
  } catch {
    // Calibration still applies for the current session even if persistence is unavailable.
  }
}

export function getInitialLujiazuiModelMatrix(): { matrix: Cesium.Matrix4; status: LujiazuiGeoreferenceStatus } {
  const mode = getLujiazuiCalibrationMode()
  if (mode === 'reset') clearStoredLujiazuiModelMatrix()
  const stored = loadStoredLujiazuiModelMatrix()
  if (stored) return { matrix: stored, status: 'calibrated' }
  return { matrix: createDefaultLujiazuiModelMatrix(), status: 'approximate' }
}

function toReferenceEnu(world: Cesium.Cartesian3, enuFromFixed: Cesium.Matrix4) {
  return Cesium.Matrix4.multiplyByPoint(enuFromFixed, world, new Cesium.Cartesian3())
}

export function solveLujiazuiSimilarityCorrection(
  pickedWorldPositions: readonly Cesium.Cartesian3[],
): LujiazuiCalibrationResult {
  if (pickedWorldPositions.length !== LUJIAZUI_CONTROL_POINTS.length) {
    throw new Error(`Expected ${LUJIAZUI_CONTROL_POINTS.length} calibration picks.`)
  }

  const referenceFrame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(LUJIAZUI_ANCHOR.lon, LUJIAZUI_ANCHOR.lat, 0),
  )
  const enuFromFixed = Cesium.Matrix4.inverseTransformation(referenceFrame, new Cesium.Matrix4())
  const source = pickedWorldPositions.map((world) => toReferenceEnu(world, enuFromFixed))
  const target = LUJIAZUI_CONTROL_POINTS.map((point) => toReferenceEnu(
    Cesium.Cartesian3.fromDegrees(point.lon, point.lat, 0),
    enuFromFixed,
  ))

  const sourceCx = source.reduce((sum, point) => sum + point.x, 0) / source.length
  const sourceCy = source.reduce((sum, point) => sum + point.y, 0) / source.length
  const targetCx = target.reduce((sum, point) => sum + point.x, 0) / target.length
  const targetCy = target.reduce((sum, point) => sum + point.y, 0) / target.length

  let denominator = 0
  let aNumerator = 0
  let bNumerator = 0
  source.forEach((point, index) => {
    const sx = point.x - sourceCx
    const sy = point.y - sourceCy
    const tx = target[index].x - targetCx
    const ty = target[index].y - targetCy
    denominator += sx * sx + sy * sy
    aNumerator += sx * tx + sy * ty
    bNumerator += sx * ty - sy * tx
  })
  if (denominator < 1e-6) throw new Error('Calibration picks are degenerate.')

  const a = aNumerator / denominator
  const b = bNumerator / denominator
  const scale = Math.hypot(a, b)
  const heading = Math.atan2(b, a)
  if (!Number.isFinite(scale) || scale < 0.7 || scale > 1.3) {
    throw new Error(`Calibration scale correction ${scale.toFixed(3)} is outside the safe range.`)
  }

  const tx = targetCx - (a * sourceCx - b * sourceCy)
  const ty = targetCy - (b * sourceCx + a * sourceCy)

  const rotation = Cesium.Matrix4.fromRotationTranslation(
    Cesium.Matrix3.fromRotationZ(heading),
    Cesium.Cartesian3.ZERO,
  )
  const uniformScale = Cesium.Matrix4.fromUniformScale(scale)
  const rotationScale = Cesium.Matrix4.multiply(rotation, uniformScale, new Cesium.Matrix4())
  const translation = Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(tx, ty, 0))
  const localCorrection = Cesium.Matrix4.multiply(translation, rotationScale, new Cesium.Matrix4())
  const fixedFromEnu = referenceFrame
  const fixedCorrection = Cesium.Matrix4.multiply(
    Cesium.Matrix4.multiply(fixedFromEnu, localCorrection, new Cesium.Matrix4()),
    enuFromFixed,
    new Cesium.Matrix4(),
  )

  let residualSq = 0
  source.forEach((point, index) => {
    const x = a * point.x - b * point.y + tx
    const y = b * point.x + a * point.y + ty
    const dx = x - target[index].x
    const dy = y - target[index].y
    residualSq += dx * dx + dy * dy
  })

  return {
    matrix: fixedCorrection,
    rmsResidualM: Math.sqrt(residualSq / source.length),
    scaleCorrection: scale,
    headingCorrectionDeg: Cesium.Math.toDegrees(heading),
  }
}

export function addLujiazuiCalibrationMarkers(viewer: Cesium.Viewer) {
  return LUJIAZUI_CONTROL_POINTS.map((point, index) => viewer.entities.add({
    id: `lujiazui-calibration-target-${point.id}`,
    position: Cesium.Cartesian3.fromDegrees(point.lon, point.lat, 8),
    point: {
      pixelSize: 10,
      color: Cesium.Color.fromCssColorString('#ff9a3d'),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: `${index + 1} ${point.name}`,
      font: '600 13px sans-serif',
      fillColor: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -18),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  }))
}
