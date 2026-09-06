import * as Cesium from 'cesium'

export const STYLE_DEMO_COLORS = {
  ground: '#CDD2D2',
  residential: '#D1CEC6',
  commercial: '#C4CDD0',
  industrial: '#B9C0C1',
  civic: '#D3D3CD',
  green: '#748575',
  water: '#365568',
  expressway: '#465761',
  primaryRoad: '#586A74',
  secondaryRoad: '#72818A',
  localRoad: '#939DA1',
  glassBlue: '#587687',
  glassSilver: '#87979E',
  stone: '#B9B0A4',
  residentialFacade: '#C4BBB0',
  concrete: '#A8AFB1',
  roof: '#CDD2D1',
  base: '#69777C',
} as const

export function color(css: keyof typeof STYLE_DEMO_COLORS, alpha = 1) {
  return Cesium.Color.fromCssColorString(STYLE_DEMO_COLORS[css]).withAlpha(alpha)
}

export const LANDUSE_STYLE = {
  residential: color('residential', 0.82).darken(0.22, new Cesium.Color()),
  commercial: color('commercial', 0.84).darken(0.22, new Cesium.Color()),
  industrial: color('industrial', 0.84).darken(0.22, new Cesium.Color()),
  civic: color('civic', 0.84).darken(0.22, new Cesium.Color()),
  green: color('green', 0.78).darken(0.16, new Cesium.Color()),
} as const
