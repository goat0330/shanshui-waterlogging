import * as Cesium from 'cesium'
import { LANDUSE_STYLE } from './styleDemoPalette'

export const SHANGHAI_LANDUSE_GEOJSON_URL = '/data/scene/shanghai-landuse.geojson'
export const SHANGHAI_LANDUSE_SOURCE_LABEL = 'OpenStreetMap landuse/leisure/amenity polygons · ODbL'

export type LanduseClass = 'residential' | 'commercial' | 'industrial' | 'civic' | 'green'

function normalizeClass(properties: Record<string, unknown> | undefined): LanduseClass | null {
  const explicit = typeof properties?.class === 'string' ? properties.class : ''
  if (['residential', 'commercial', 'industrial', 'civic', 'green'].includes(explicit)) return explicit as LanduseClass

  const landuse = typeof properties?.landuse === 'string' ? properties.landuse : ''
  const leisure = typeof properties?.leisure === 'string' ? properties.leisure : ''
  const amenity = typeof properties?.amenity === 'string' ? properties.amenity : ''
  const natural = typeof properties?.natural === 'string' ? properties.natural : ''

  if (['residential'].includes(landuse)) return 'residential'
  if (['commercial', 'retail'].includes(landuse)) return 'commercial'
  if (['industrial', 'construction', 'railway'].includes(landuse)) return 'industrial'
  if (['school', 'university', 'college', 'hospital', 'government', 'public'].includes(amenity)) return 'civic'
  if (['park', 'garden', 'recreation_ground', 'pitch'].includes(leisure)) return 'green'
  if (['grass', 'forest', 'meadow', 'recreation_ground', 'village_green'].includes(landuse)) return 'green'
  if (['wood', 'grassland', 'scrub'].includes(natural)) return 'green'
  return null
}

export async function loadShanghaiLanduseLayer(viewer: Cesium.Viewer) {
  const source = await Cesium.GeoJsonDataSource.load(SHANGHAI_LANDUSE_GEOJSON_URL, {
    clampToGround: true,
    stroke: Cesium.Color.TRANSPARENT,
    fill: Cesium.Color.TRANSPARENT,
    strokeWidth: 0,
  })

  const now = Cesium.JulianDate.now()
  for (const entity of source.entities.values) {
    if (!entity.polygon) continue
    const properties = entity.properties?.getValue(now) as Record<string, unknown> | undefined
    const landuseClass = normalizeClass(properties)
    if (!landuseClass) {
      entity.show = false
      continue
    }
    entity.polygon.material = new Cesium.ColorMaterialProperty(LANDUSE_STYLE[landuseClass])
    entity.polygon.outline = new Cesium.ConstantProperty(false)
    entity.polygon.classificationType = new Cesium.ConstantProperty(Cesium.ClassificationType.TERRAIN)
    entity.polygon.zIndex = new Cesium.ConstantProperty(1)
  }

  await viewer.dataSources.add(source)
  return source
}
