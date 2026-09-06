import * as Cesium from 'cesium'

export const CITY_LABEL_SOURCE_LABEL = 'Sparse geographic labels · WGS84 lon/lat'

type CityLabel = {
  id: string
  text: string
  lon: number
  lat: number
  kind: 'district' | 'water'
}

const FIXED_CITY_LABELS: CityLabel[] = [
  { id: 'label-jingan', text: '静安区', lon: 121.458, lat: 31.257, kind: 'district' },
  { id: 'label-huangpu', text: '黄浦区', lon: 121.482, lat: 31.213, kind: 'district' },
  { id: 'label-hongkou', text: '虹口区', lon: 121.511, lat: 31.252, kind: 'district' },
  { id: 'label-huangpu-river', text: '黄浦江', lon: 121.515, lat: 31.226, kind: 'water' },
  { id: 'label-suzhou-creek', text: '苏州河', lon: 121.492, lat: 31.254, kind: 'water' },
]

const LABEL_COLORS = {
  road: Cesium.Color.fromCssColorString('#405761').withAlpha(0.88),
  district: Cesium.Color.fromCssColorString('#687a80').withAlpha(0.60),
  water: Cesium.Color.fromCssColorString('#547b87').withAlpha(0.72),
} as const

function normalizedRoadClass(roadClass: string) {
  return roadClass.trim().toLowerCase()
}

function roadClassRank(roadClassRaw: string) {
  const roadClass = normalizedRoadClass(roadClassRaw)
  if (
    roadClass === 'motorway'
    || roadClass === 'motorway_link'
    || roadClass === 'trunk'
    || roadClass === 'trunk_link'
    || roadClass === 'elevated'
  ) return 4
  if (roadClass === 'primary' || roadClass === 'primary_link') return 3
  if (
    roadClass === 'secondary'
    || roadClass === 'secondary_link'
    || roadClass === 'tertiary'
    || roadClass === 'tertiary_link'
  ) return 2
  return 1
}

function roadLabelCandidates(roadDataSource: Cesium.GeoJsonDataSource) {
  const candidates = new Map<string, { text: string; position: Cesium.Cartesian3; roadClass: string; score: number }>()
  const now = Cesium.JulianDate.now()

  roadDataSource.entities.values.forEach((entity) => {
    if (!entity.polyline || entity.show === false) return
    const properties = entity.properties?.getValue(now)
    const text = typeof properties?.name === 'string' ? properties.name.trim() : ''
    if (!text) return
    const roadClass = typeof properties?.fclass === 'string'
      ? properties.fclass
      : typeof properties?.roadClass === 'string'
        ? properties.roadClass
        : 'unclassified'
    const rank = roadClassRank(roadClass)
    if (rank <= 1) return

    const positions = entity.polyline.positions?.getValue(now)
    if (!positions || positions.length < 2) return
    const score = rank * 100000 + positions.length
    const current = candidates.get(text)
    if (current && current.score >= score) return
    const midpoint = positions[Math.floor(positions.length / 2)]
    candidates.set(text, { text, position: midpoint, roadClass, score })
  })

  return Array.from(candidates.values())
}

function roadLabelMaxDistance(roadClass: string) {
  const rank = roadClassRank(roadClass)
  if (rank >= 4) return 48000
  if (rank === 3) return 28000
  if (rank === 2) return 12000
  return 0
}

function roadLabelFont(roadClass: string) {
  const rank = roadClassRank(roadClass)
  if (rank >= 4) return '600 12px sans-serif'
  if (rank === 3) return '600 11px sans-serif'
  return '500 10px sans-serif'
}

export async function loadCityLabelLayer(viewer: Cesium.Viewer, roadDataSource: Cesium.GeoJsonDataSource, roadSourceLabel: string) {
  const dataSource = new Cesium.CustomDataSource('Shanghai sparse labels · geographic source')

  roadLabelCandidates(roadDataSource).forEach((roadLabel) => {
    dataSource.entities.add({
      id: `road-label-${roadLabel.text}`,
      name: roadLabel.text,
      position: roadLabel.position,
      label: new Cesium.LabelGraphics({
        text: roadLabel.text,
        font: roadLabelFont(roadLabel.roadClass),
        fillColor: LABEL_COLORS.road,
        outlineColor: Cesium.Color.fromCssColorString('#f2f1ec').withAlpha(0.96),
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        scaleByDistance: new Cesium.NearFarScalar(900, 1, 30000, 0.67),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, roadLabelMaxDistance(roadLabel.roadClass)),
        disableDepthTestDistance: 1500,
        showBackground: false,
      }),
      properties: {
        entityType: 'city-label',
        labelType: 'road',
        roadClass: roadLabel.roadClass,
        source: roadSourceLabel,
        coordinateSystem: 'WGS84 lon/lat',
      },
    })
  })

  FIXED_CITY_LABELS.forEach((label) => {
    const isWater = label.kind === 'water'
    dataSource.entities.add({
      id: label.id,
      name: label.text,
      position: Cesium.Cartesian3.fromDegrees(label.lon, label.lat, 0),
      label: new Cesium.LabelGraphics({
        text: label.text,
        font: isWater ? '600 11px sans-serif' : '500 10px sans-serif',
        fillColor: LABEL_COLORS[label.kind],
        outlineColor: Cesium.Color.fromCssColorString('#f2f1ec').withAlpha(0.88),
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        scaleByDistance: new Cesium.NearFarScalar(900, 1, 18000, 0.7),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, isWater ? 20000 : 16000),
        disableDepthTestDistance: 1100,
        showBackground: false,
      }),
      properties: {
        entityType: 'city-label',
        labelType: label.kind,
        source: CITY_LABEL_SOURCE_LABEL,
        coordinateSystem: 'WGS84 lon/lat',
      },
    })
  })

  await viewer.dataSources.add(dataSource)
  return dataSource
}
