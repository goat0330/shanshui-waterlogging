import * as Cesium from 'cesium'
import { color } from './styleDemoPalette'

export function applyStyleDemoSceneLook(viewer: Cesium.Viewer, basemapLayer?: Cesium.ImageryLayer | null) {
  viewer.scene.highDynamicRange = true
  viewer.camera.frustum.near = 100
  viewer.camera.frustum.far = 50000
  viewer.scene.backgroundColor = color('ground')
  // Globe imagery is composited outside the model PBR path; compensate its
  // brighter display response without changing exposure or the MVP palette.
  viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#75858D')
  viewer.scene.globe.enableLighting = false
  viewer.scene.globe.showGroundAtmosphere = false

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

  const ao = viewer.scene.postProcessStages.ambientOcclusion
  // The real browser shows facade speckling with SSAO at geographic depth
  // ranges. Keep embedded material AO and soft cast shadows instead.
  ao.enabled = false
  if (ao.uniforms) {
    ao.uniforms.intensity = 1.3
    ao.uniforms.bias = 0.25
    ao.uniforms.lengthCap = 0.22
    ao.uniforms.stepSize = 1.1
    ao.uniforms.blurStepSize = 0.85
  }

  viewer.scene.postProcessStages.bloom.enabled = false

  const localFrame = Cesium.Transforms.eastNorthUpToFixedFrame(Cesium.Cartesian3.fromDegrees(121.49, 31.24))
  viewer.scene.light = new Cesium.DirectionalLight({
    direction: Cesium.Cartesian3.normalize(Cesium.Matrix4.multiplyByPointAsVector(localFrame,
      new Cesium.Cartesian3(0.4, -0.6, -0.7), new Cesium.Cartesian3()), new Cesium.Cartesian3()),
    intensity: 1.15,
  })
}
