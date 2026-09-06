import * as Cesium from 'cesium'
import { color } from './styleDemoPalette'

/**
 * Visual-only scene preset. Nothing in this function is used by the production MVP.
 */
export function applyStyleDemoSceneLook(viewer: Cesium.Viewer, basemapLayer?: Cesium.ImageryLayer | null) {
  viewer.scene.highDynamicRange = true
  viewer.scene.logarithmicDepthBuffer = false
  viewer.camera.frustum.near = 10
  viewer.scene.postProcessStages.exposure = 1.05

  viewer.scene.backgroundColor = color('ground')
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#75858D')
  viewer.scene.globe.enableLighting = false
  viewer.scene.globe.showGroundAtmosphere = false
  viewer.scene.globe.depthTestAgainstTerrain = false

  if (viewer.scene.skyBox) viewer.scene.skyBox.show = false
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false

  viewer.scene.fog.enabled = true
  viewer.scene.fog.density = 0.000055
  viewer.scene.fog.screenSpaceErrorFactor = 1.8

  if (basemapLayer) {
    basemapLayer.alpha = 0.18
    basemapLayer.brightness = 1.08
    basemapLayer.contrast = 0.78
    basemapLayer.saturation = 0.02
    basemapLayer.gamma = 1.05
  }

  // SSAO produced geographic-depth speckling in the current browser scene.
  // Keep baked/material AO and soft cast shadows instead.
  const ao = viewer.scene.postProcessStages.ambientOcclusion
  ao.enabled = false
  if (ao.uniforms) {
    ao.uniforms.intensity = 1.3
    ao.uniforms.bias = 0.25
    ao.uniforms.lengthCap = 0.22
    ao.uniforms.stepSize = 1.1
    ao.uniforms.blurStepSize = 0.85
  }

  viewer.scene.postProcessStages.fxaa.enabled = true
  viewer.scene.postProcessStages.bloom.enabled = false
  viewer.shadowMap.softShadows = true
  viewer.shadowMap.size = 2048
  viewer.shadowMap.darkness = 0.22
  viewer.clock.currentTime = Cesium.JulianDate.fromIso8601('2026-06-01T04:00:00Z')

  const localFrame = Cesium.Transforms.eastNorthUpToFixedFrame(
    Cesium.Cartesian3.fromDegrees(121.49, 31.24),
  )
  viewer.scene.light = new Cesium.DirectionalLight({
    direction: Cesium.Cartesian3.normalize(
      Cesium.Matrix4.multiplyByPointAsVector(
        localFrame,
        new Cesium.Cartesian3(0.4, -0.6, -0.7),
        new Cesium.Cartesian3(),
      ),
      new Cesium.Cartesian3(),
    ),
    intensity: 1.15,
  })
}
