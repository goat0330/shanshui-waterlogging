import * as Cesium from 'cesium'

export type BuildingSurfaceV4Mode = 'osm-height-metadata' | 'neutral-fallback'

function hasEstimatedHeightMetadata(tileset: Cesium.Cesium3DTileset) {
  const properties = (tileset as unknown as { properties?: Record<string, unknown> }).properties
  return Boolean(properties && Object.prototype.hasOwnProperty.call(properties, 'cesium#estimatedHeight'))
}

function createFacadeShader() {
  return new Cesium.CustomShader({
    mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
    lightingModel: Cesium.LightingModel.PBR,
    varyings: {
      v_surfacePosition: Cesium.VaryingType.VEC3,
      v_surfaceNormal: Cesium.VaryingType.VEC3,
    },
    vertexShaderText: `
      void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
        v_surfacePosition = vsInput.attributes.positionMC;
        v_surfaceNormal = normalize(vsInput.attributes.normalMC);
      }
    `,
    fragmentShaderText: `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        vec3 p = v_surfacePosition;
        vec3 n = normalize(v_surfaceNormal);
        vec3 nEC = normalize(fsInput.attributes.normalEC);

        vec3 upWC = normalize(fsInput.attributes.positionWC);
        vec3 upEC = normalize(czm_viewRotation * upWC);
        float upness = abs(dot(nEC, upEC));
        float roofMask = smoothstep(0.72, 0.94, upness);
        float facadeMask = 1.0 - roofMask;

        // Lightweight facade rhythm. Geometry is untouched.
        vec3 upMC = normalize(mat3(czm_inverseModel) * upWC);
        vec3 eastSeed = cross(vec3(0.0, 0.0, 1.0), upWC);
        if (length(eastSeed) < 0.0001) eastSeed = vec3(1.0, 0.0, 0.0);
        vec3 eastMC = normalize(mat3(czm_inverseModel) * normalize(eastSeed));
        vec3 northMC = normalize(cross(upMC, eastMC));
        float vertical = dot(p, upMC);
        float horizontal = abs(dot(n, eastMC)) > abs(dot(n, northMC)) ? dot(p, northMC) : dot(p, eastMC);

        float bay = 3.0;
        float floorH = 3.3;
        float derivative = max(fwidth(horizontal / bay), fwidth(vertical / floorH));
        float detail = 1.0 - smoothstep(0.35, 1.45, derivative);
        float verticalGrid = smoothstep(0.90, 0.995, abs(sin(horizontal * 3.14159265 / bay)));
        float horizontalGrid = smoothstep(0.91, 0.995, abs(sin(vertical * 3.14159265 / floorH)));
        float grid = clamp(max(verticalGrid * 0.66, horizontalGrid * 0.46), 0.0, 1.0);
        // Height families are assigned on the CPU from the real
        // cesium#estimatedHeight metadata. The shader only applies the shared
        // roof/facade/base treatment, avoiding a metadata-dependent GLSL stage
        // that Cesium cannot compile for primitives without that property.
        vec3 facadeColor = material.baseColor.rgb;
        facadeColor *= mix(1.0, 0.70, grid * facadeMask * detail * 0.22);

        // Mild face-direction contrast improves mass readability without outlines.
        float faceShade = 0.94 + 0.06 * abs(nEC.x);
        facadeColor *= faceShade;

        // Ellipsoid height is a practical Shanghai-context base approximation.
        vec3 radii = vec3(6378137.0, 6378137.0, 6356752.314245);
        vec3 scaled = fsInput.attributes.positionWC / radii;
        float surfaceHeight = max((length(scaled) - 1.0) * 6371000.0, 0.0);
        float baseBandHeight = 8.0;
        float baseMask = facadeMask * (1.0 - smoothstep(baseBandHeight, baseBandHeight + 4.0, surfaceHeight));

        vec3 resultColor = mix(facadeColor, material.baseColor.rgb * 1.08, roofMask);
        resultColor = mix(resultColor, material.baseColor.rgb * 0.62, baseMask * 0.78);

        material.diffuse = resultColor;
        material.roughness = mix(0.70, 0.84, roofMask);
        material.specular = vec3(mix(0.18, 0.10, roofMask));
        material.alpha = 1.0;
      }
    `,
  })
}

const HEIGHT_FAMILY_COLORS = [
  { threshold: 120, color: Cesium.Color.fromCssColorString('#587687') },
  { threshold: 60, color: Cesium.Color.fromCssColorString('#87979e') },
  { threshold: 24, color: Cesium.Color.fromCssColorString('#c4bbb0') },
  { threshold: 12, color: Cesium.Color.fromCssColorString('#b9b0a4') },
  { threshold: Number.NEGATIVE_INFINITY, color: Cesium.Color.fromCssColorString('#a8afb1') },
]

function estimatedHeight(feature: Cesium.Cesium3DTileFeature) {
  const raw = feature.getProperty('cesium#estimatedHeight')
    ?? feature.getProperty('estimatedHeight')
    ?? feature.getProperty('height')
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

function colorForHeight(height: number) {
  return HEIGHT_FAMILY_COLORS.find((entry) => height >= entry.threshold)?.color ?? HEIGHT_FAMILY_COLORS[HEIGHT_FAMILY_COLORS.length - 1].color
}

function colorTileContent(content: Cesium.Cesium3DTileContent, seen: WeakSet<object>) {
  if (seen.has(content)) return
  seen.add(content)
  const innerContents = (content as unknown as { innerContents?: Cesium.Cesium3DTileContent[] }).innerContents
  innerContents?.forEach((inner) => colorTileContent(inner, seen))
  if (!content.featuresLength) return
  for (let index = 0; index < content.featuresLength; index += 1) {
    const feature = content.getFeature(index)
    feature.color = colorForHeight(estimatedHeight(feature))
  }
}

export function applyBuildingSurfaceV4(tileset: Cesium.Cesium3DTileset): BuildingSurfaceV4Mode {
  tileset.style = undefined
  const metadataMode = hasEstimatedHeightMetadata(tileset)
  const seen = new WeakSet<object>()
  tileset.tileVisible.addEventListener((tile) => colorTileContent(tile.content, seen))
  tileset.customShader = createFacadeShader()
  // OSM Buildings are at normal geographic scale, so receive+cast is stable and
  // provides the depth separation the visual demo needs.
  tileset.shadows = Cesium.ShadowMode.ENABLED
  return metadataMode ? 'osm-height-metadata' : 'neutral-fallback'
}
