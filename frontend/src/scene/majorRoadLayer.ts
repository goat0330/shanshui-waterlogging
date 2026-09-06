import * as Cesium from 'cesium'

export const MAJOR_ROADS_GEOJSON_URL = '/data/scene/shanghai-major-roads.geojson'
export const MAJOR_ROADS_FALLBACK_GEOJSON_URL = '/demo/roads/shanghai-major-roads.geojson'
export const MAJOR_ROADS_SOURCE_LABEL = '© OpenStreetMap contributors · Geofabrik Shanghai · 2026-08-24 · WGS84'
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

// Screen-space hierarchy is intentional: at the current 5–15 km business view,
// the old 1–2 px lines disappeared into the basemap. Main roads now remain legible
// while local streets fade out with distance.
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

function normalizeRoadClass(value: string) {
  return value.trim().toLowerCase()
}

function classifyRoad(roadClassRaw: string): RoadTier {
  const roadClass = normalizeRoadClass(roadClassRaw)
  if (
    roadClass === 'motorway'
    || roadClass === 'motorway_link'
    || roadClass === 'trunk'
    || roadClass === 'trunk_link'
    || roadClass === 'elevated'
  ) return 'expressway'
  if (roadClass === 'primary' || roadClass === 'primary_link') return 'primary'
  if (
    roadClass === 'secondary'
    || roadClass === 'secondary_link'
    || roadClass === 'tertiary'
    || roadClass === 'tertiary_link'
  ) return 'secondary'
  return 'local'
}

function truthyFlag(value: unknown) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return normalized === 't' || normalized === 'true' || normalized === '1' || normalized === 'yes'
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

async function loadRoadDataSource(url: string, visualDemo = false) {
  let data = url as string | object
  if (visualDemo) {
    const geojson = await Cesium.Resource.fetchJson({url})
    // The demo covers the supplied landuse AOI, not the entire Shanghai road
    // extract. Avoid allocating thousands of off-screen ground polylines.
    geojson.features = geojson.features.filter((feature: {geometry: {type: string, coordinates: number[][] | number[][][]}}) => {
      const points = feature.geometry.type === 'MultiLineString' ? (feature.geometry.coordinates as number[][][]).flat() : feature.geometry.coordinates as number[][]
      const lons = points.map(p => p[0]), lats = points.map(p => p[1])
      return Math.max(...lons) >= 121.40 && Math.min(...lons) <= 121.60 && Math.max(...lats) >= 31.17 && Math.min(...lats) <= 31.31
    })
    data = geojson
  }
  return Cesium.GeoJsonDataSource.load(data, {
    clampToGround: true,
    stroke: ROAD_STYLE.primary.color,
    strokeWidth: ROAD_STYLE.primary.width,
  })
}

export async function loadMajorRoadLayer(viewer: Cesium.Viewer, visualDemo = false): Promise<MajorRoadLayerResult> {
  let dataSource: Cesium.GeoJsonDataSource
  let sourceUrl = MAJOR_ROADS_GEOJSON_URL
  let sourceLabel = MAJOR_ROADS_SOURCE_LABEL
  let fallback = false

  try {
    dataSource = await loadRoadDataSource(MAJOR_ROADS_GEOJSON_URL, visualDemo)
  } catch {
    dataSource = await loadRoadDataSource(MAJOR_ROADS_FALLBACK_GEOJSON_URL, visualDemo)
    sourceUrl = MAJOR_ROADS_FALLBACK_GEOJSON_URL
    sourceLabel = MAJOR_ROADS_FALLBACK_SOURCE_LABEL
    fallback = true
  }

  dataSource.name = fallback ? 'Shanghai roads · synthetic fallback' : 'Shanghai roads · OSM Geofabrik hierarchy'

  dataSource.entities.values.forEach((entity) => {
    if (!entity.polyline) return

    const properties = getRoadProps(entity)
    const tier = classifyRoad(properties.fclass)
    const style = visualDemo ? {
      ...ROAD_STYLE[tier],
      color: Cesium.Color.fromCssColorString({expressway: '#465761', primary: '#586A74', secondary: '#72818A', local: '#939DA1'}[tier]).withAlpha({expressway: 0.98, primary: 0.96, secondary: 0.90, local: 0.68}[tier]),
      outline: Cesium.Color.fromCssColorString(tier === 'expressway' ? '#9CA8AC' : '#B3BCBE'),
    } : ROAD_STYLE[tier]

    // Underground segments should not be painted on the surface.
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
    entity.polyline.distanceDisplayCondition = new Cesium.ConstantProperty(
      new Cesium.DistanceDisplayCondition(0, style.maxDistance),
    )
    entity.polyline.zIndex = new Cesium.ConstantProperty(style.zIndex)
  })

  await viewer.dataSources.add(dataSource)
  return { dataSource, sourceUrl, sourceLabel, fallback }
}
