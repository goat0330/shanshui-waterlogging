import * as Cesium from 'cesium'

export const SHANGHAI_WATER_POLYGONS_GEOJSON_URL = '/demo/water/shanghai-water-polygons.geojson'
export const SHANGHAI_WATERWAYS_GEOJSON_URL = '/demo/water/shanghai-waterways.geojson'
export const SHANGHAI_WATER_SOURCE_LABEL = '© OpenStreetMap contributors · Shanghai extract · 2026-08-25 · WGS84'

const WATER_FILL = Cesium.Color.fromCssColorString('#12394b').withAlpha(0.58)
const WATER_STROKE = Cesium.Color.fromCssColorString('#4b93a7').withAlpha(0.78)
const STREAM_STROKE = Cesium.Color.fromCssColorString('#397f90').withAlpha(0.62)

export async function loadShanghaiHydroSystemLayer(viewer: Cesium.Viewer) {
  const [waterDataSource, waterwaysDataSource] = await Promise.all([
    Cesium.GeoJsonDataSource.load(SHANGHAI_WATER_POLYGONS_GEOJSON_URL, {
      clampToGround: true,
      fill: WATER_FILL,
      stroke: WATER_STROKE,
      strokeWidth: 2,
    }),
    Cesium.GeoJsonDataSource.load(SHANGHAI_WATERWAYS_GEOJSON_URL, {
      clampToGround: true,
      stroke: WATER_STROKE,
      strokeWidth: 2,
    }),
  ])

  waterDataSource.name = 'Shanghai water polygons · OpenStreetMap'
  waterwaysDataSource.name = 'Shanghai waterways · OpenStreetMap'

  waterDataSource.entities.values.forEach((entity) => {
    if (!entity.polygon) return
    entity.polygon.material = new Cesium.ColorMaterialProperty(WATER_FILL)
    entity.polygon.heightReference = new Cesium.ConstantProperty(Cesium.HeightReference.CLAMP_TO_GROUND)
    entity.polygon.classificationType = new Cesium.ConstantProperty(Cesium.ClassificationType.TERRAIN)
    entity.polygon.outline = new Cesium.ConstantProperty(true)
    entity.polygon.outlineColor = new Cesium.ConstantProperty(WATER_STROKE)
    entity.polygon.zIndex = new Cesium.ConstantProperty(1)
  })

  waterwaysDataSource.entities.values.forEach((entity) => {
    if (!entity.polyline) return
    const props = entity.properties?.getValue(Cesium.JulianDate.now()) as { waterway?: string } | undefined
    const isStream = props?.waterway === 'stream'
    entity.polyline.material = new Cesium.ColorMaterialProperty(isStream ? STREAM_STROKE : WATER_STROKE)
    entity.polyline.width = new Cesium.ConstantProperty(isStream ? 1.25 : 2)
  })

  await viewer.dataSources.add(waterDataSource)
  await viewer.dataSources.add(waterwaysDataSource)
  return [waterDataSource, waterwaysDataSource]
}
