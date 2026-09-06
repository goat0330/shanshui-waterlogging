import * as Cesium from 'cesium'

export const MAJOR_ROADS_GEOJSON_URL = '/data/scene/shanghai-major-roads.geojson'
export const STYLE_DEMO_ROADS_GEOJSON_URL = '/data/scene/shanghai-demo-roads.geojson'
export const MAJOR_ROADS_FALLBACK_GEOJSON_URL = '/demo/roads/shanghai-major-roads.geojson'
export const MAJOR_ROADS_SOURCE_LABEL = '© OpenStreetMap contributors · Geofabrik Shanghai · 2026-08-24 · WGS84'
export const STYLE_DEMO_ROADS_SOURCE_LABEL = '© OpenStreetMap contributors · Overpass · visual-demo AOI · WGS84'
export const MAJOR_ROADS_FALLBACK_SOURCE_LABEL = 'SYNTHETIC DEMO · approximate WGS84 lon/lat centerlines'

export interface MajorRoadLayerResult {
  dataSource: Cesium.GeoJsonDataSource
  sourceUrl: string
  sourceLabel: string
  fallback: boolean
}

type RoadTier = 'expressway' | 'primary' | 'secondary' | 'local'
type RoadProps = {
  fclass?: string
  roadClass?: string
  bridge?: string | boolean
  tunnel?: string | boolean
}

type RoadVisual = {
  color: Cesium.Color
  outline: Cesium.Color
  width: number
  outlineWidth: number
  maxDistance: number
  zIndex: number
}

const ROAD_STYLE: Record<RoadTier, RoadVisual> = {
  expressway: {
    color: Cesium.Color.fromCssColorString('#365662').withAlpha(0.98),
    outline: Cesium.Color.fromCssColorString('#d9dfdc').withAlpha(0.84),
    width: 7.2,
    outlineWidth: 1.7,
    maxDistance: 60000,
    zIndex: 12,
  },
  primary: {
    color: Cesium.Color.fromCssColorString('#526d76').withAlpha(0.94),
    outline: Cesium.Color.fromCssColorString('#e3e5df').withAlpha(0.70),
    width: 5.0,
    outlineWidth: 1.25,
    maxDistance: 38000,
    zIndex: 11,
  },
  secondary: {
    color: Cesium.Color.fromCssColorString('#74878c').withAlpha(0.78),
    outline: Cesium.Color.fromCssColorString('#e8e8e2').withAlpha(0.45),
    width: 3.0,
    outlineWidth: 0.8,
    maxDistance: 19000,
    zIndex: 10,
  },
  local: {
    color: Cesium.Color.fromCssColorString('#8f9b9c').withAlpha(0.46),
    outline: Cesium.Color.fromCssColorString('#eeeeea').withAlpha(0.22),
    width: 1.35,
    outlineWidth: 0.35,
    maxDistance: 8500,
    zIndex: 9,
  },
}

const DEMO_COLORS: Record<RoadTier, string> = {
  expressway: '#465761',
  primary: '#586A74',
  secondary: '#72818A',
  local: '#939DA1',
}
const DEMO_ALPHA: Record<RoadTier, number> = { expressway: 0.98, primary: 0.96, secondary: 0.90, local: 0.68 }

function normalizeRoadClass(value: string) {
  return value.trim().toLowerCase()
}

function classifyRoad(roadClassRaw: string): RoadTier {
  const roadClass = normalizeRoadClass(roadClassRaw)
  if (['motorway', 'motorway_link', 'trunk', 'trunk_link', 'elevated'].includes(roadClass)) return 'expressway'
  if (['primary', 'primary_link'].includes(roadClass)) return 'primary'
  if (['secondary', 'secondary_link', 'tertiary', 'tertiary_link'].includes(roadClass)) return 'secondary'
  return 'local'
}

function truthyFlag(value: unknown) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return ['t', 'true', '1', 'yes'].includes(normalized)
}

function getRoadProps(entity: Cesium.Entity): Required<Pick<RoadProps, 'fclass'>> & RoadProps {
  const properties = (entity.properties?.getValue(Cesium.JulianDate.now()) ?? {}) as RoadProps
  const fclass = typeof properties.fclass === 'string'
    ? properties.fclass
    : typeof properties.roadClass === 'string'
      ? properties.roadClass
      : 'unclassified'
  return { ...properties, fclass }
}

function intersectsDemoAoi(feature: { geometry: { type: string; coordinates: number[][] | number[][][] } }) {
  const points = feature.geometry.type === 'MultiLineString'
    ? (feature.geometry.coordinates as number[][][]).flat()
    : feature.geometry.coordinates as number[][]
  if (!points.length) return false
  const lons = points.map((p) => p[0])
  const lats = points.map((p) => p[1])
  return Math.max(...lons) >= 121.40 && Math.min(...lons) <= 121.60 && Math.max(...lats) >= 31.17 && Math.min(...lats) <= 31.31
}

async function loadRoadDataSource(url: string, cropToDemoAoi = false) {
  let data: string | object = url
  if (cropToDemoAoi) {
    const geojson = await Cesium.Resource.fetchJson({ url }) as { features: Array<{ geometry: { type: string; coordinates: number[][] | number[][][] } }> }
    geojson.features = geojson.features.filter(intersectsDemoAoi)
    data = geojson
  }
  return Cesium.GeoJsonDataSource.load(data, {
    clampToGround: true,
    stroke: ROAD_STYLE.primary.color,
    strokeWidth: ROAD_STYLE.primary.width,
  })
}

async function chooseRoadSource(visualDemo: boolean) {
  if (visualDemo) {
    try {
      return {
        dataSource: await loadRoadDataSource(STYLE_DEMO_ROADS_GEOJSON_URL),
        sourceUrl: STYLE_DEMO_ROADS_GEOJSON_URL,
        sourceLabel: STYLE_DEMO_ROADS_SOURCE_LABEL,
        fallback: false,
      }
    } catch {
      // Use the existing real major-road dataset if the optional detailed AOI file
      // has not yet been generated. Never synthesize missing local streets.
      try {
        return {
          dataSource: await loadRoadDataSource(MAJOR_ROADS_GEOJSON_URL, true),
          sourceUrl: MAJOR_ROADS_GEOJSON_URL,
          sourceLabel: MAJOR_ROADS_SOURCE_LABEL,
          fallback: false,
        }
      } catch {
        // fall through to the explicit synthetic demo fallback
      }
    }
  } else {
    try {
      return {
        dataSource: await loadRoadDataSource(MAJOR_ROADS_GEOJSON_URL),
        sourceUrl: MAJOR_ROADS_GEOJSON_URL,
        sourceLabel: MAJOR_ROADS_SOURCE_LABEL,
        fallback: false,
      }
    } catch {
      // fall through
    }
  }

  return {
    dataSource: await loadRoadDataSource(MAJOR_ROADS_FALLBACK_GEOJSON_URL, visualDemo),
    sourceUrl: MAJOR_ROADS_FALLBACK_GEOJSON_URL,
    sourceLabel: MAJOR_ROADS_FALLBACK_SOURCE_LABEL,
    fallback: true,
  }
}

export async function loadMajorRoadLayer(viewer: Cesium.Viewer, visualDemo = false): Promise<MajorRoadLayerResult> {
  const result = await chooseRoadSource(visualDemo)
  const { dataSource } = result
  dataSource.name = result.fallback ? 'Shanghai roads · synthetic fallback' : 'Shanghai roads · OSM hierarchy'

  dataSource.entities.values.forEach((entity) => {
    if (!entity.polyline) return
    const properties = getRoadProps(entity)
    const tier = classifyRoad(properties.fclass)
    const base = ROAD_STYLE[tier]
    const style = visualDemo
      ? {
          ...base,
          color: Cesium.Color.fromCssColorString(DEMO_COLORS[tier]).withAlpha(DEMO_ALPHA[tier]),
          outline: Cesium.Color.fromCssColorString(tier === 'expressway' ? '#9CA8AC' : '#B3BCBE').withAlpha(tier === 'local' ? 0.25 : 0.65),
        }
      : base

    if (truthyFlag(properties.tunnel)) {
      entity.show = false
      return
    }

    const bridgeBoost = truthyFlag(properties.bridge) ? 0.55 : 0
    entity.polyline.material = new Cesium.PolylineOutlineMaterialProperty({
      color: style.color,
      outlineColor: style.outline,
      outlineWidth: style.outlineWidth,
    })
    entity.polyline.width = new Cesium.ConstantProperty(style.width + bridgeBoost)
    entity.polyline.clampToGround = new Cesium.ConstantProperty(true)
    if (visualDemo) entity.polyline.classificationType = new Cesium.ConstantProperty(Cesium.ClassificationType.TERRAIN)
    entity.polyline.arcType = new Cesium.ConstantProperty(Cesium.ArcType.GEODESIC)
    entity.polyline.distanceDisplayCondition = new Cesium.ConstantProperty(new Cesium.DistanceDisplayCondition(0, style.maxDistance))
    entity.polyline.zIndex = new Cesium.ConstantProperty(style.zIndex)
  })

  await viewer.dataSources.add(dataSource)
  return result
}
