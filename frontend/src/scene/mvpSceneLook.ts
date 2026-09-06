import * as Cesium from 'cesium'

/**
 * Restore the production MVP scene look exactly to the pre-style-demo baseline.
 * This module intentionally touches only properties that the original MVP set.
 */
export function applyMvpSceneLook(
  viewer: Cesium.Viewer,
  basemapLayer: Cesium.ImageryLayer,
  worldTerrainEnabled: boolean,
) {
  viewer.scene.backgroundColor = Cesium.Color.fromCssColorString('#0a1118')
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0d1921')

  basemapLayer.alpha = 0.72
  basemapLayer.brightness = 0.48
  basemapLayer.contrast = 1.14
  basemapLayer.saturation = 0.18

  viewer.scene.globe.enableLighting = false
  viewer.scene.globe.showGroundAtmosphere = false
  viewer.scene.globe.depthTestAgainstTerrain = worldTerrainEnabled

  viewer.scene.fog.enabled = true
  viewer.scene.fog.density = 0.00008
  viewer.scene.fog.screenSpaceErrorFactor = 2
}
