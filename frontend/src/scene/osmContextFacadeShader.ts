import * as Cesium from 'cesium'

export const OSM_CONTEXT_FACADE_VERSION = 'procedural-facade-v2'

/**
 * Lightweight visual-only facade treatment for Cesium OSM Buildings.
 *
 * Important: material families are deterministic visual context, not assertions
 * about real-world facade materials. Geometry / footprint / height / WGS84 stay
 * untouched.
 */
export function createOsmContextFacadeShader() {
  return new Cesium.CustomShader({
    mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
    lightingModel: Cesium.LightingModel.PBR,
    varyings: {
      v_contextPositionMC: Cesium.VaryingType.VEC3,
      v_contextNormalMC: Cesium.VaryingType.VEC3,
      v_contextSeed: Cesium.VaryingType.FLOAT,
      v_contextFamily: Cesium.VaryingType.FLOAT,
    },
    vertexShaderText: `
      void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput)
      {
        v_contextPositionMC = vsInput.attributes.positionMC;
        v_contextNormalMC = vsInput.attributes.normalMC;
        float featureId = float(vsInput.featureIds.featureId_0);
        v_contextSeed = fract(sin((featureId + 1.0) * 12.9898 + 78.233) * 43758.5453);
        v_contextFamily = fract(sin((featureId * 0.754877666 + 11.0) * 12.9898 + 78.233) * 43758.5453);
      }
    `,
    fragmentShaderText: `
      vec2 contextFacadeUv(vec3 positionMC, vec3 normalMC)
      {
        vec3 n = abs(normalize(normalMC));
        if (n.x >= n.y && n.x >= n.z) return positionMC.zy;
        if (n.y >= n.z) return positionMC.xz;
        return positionMC.xy;
      }

      float contextWindowMask(vec2 uv, float seed)
      {
        // A shared 3.25 m modular grid gives context buildings a readable facade
        // rhythm without generating any window geometry.
        vec2 cell = fract((uv + vec2(seed * 1.7, seed * 2.3)) / 3.25);
        float paneX = smoothstep(0.10, 0.18, cell.x) * (1.0 - smoothstep(0.82, 0.90, cell.x));
        float paneY = smoothstep(0.13, 0.21, cell.y) * (1.0 - smoothstep(0.79, 0.87, cell.y));
        return paneX * paneY;
      }

      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
      {
        float seed = v_contextSeed;
        float family = v_contextFamily;
        vec2 facadeUv = contextFacadeUv(v_contextPositionMC, v_contextNormalMC);
        float windowMask = contextWindowMask(facadeUv, seed);

        // Earth radial direction is a stable local-up approximation in Shanghai.
        // It lets the shader keep roofs quiet while applying facade rhythm to walls.
        vec3 upWC = normalize(fsInput.attributes.positionWC);
        vec3 upEC = normalize(czm_viewRotation * upWC);
        float upFacing = abs(dot(normalize(fsInput.attributes.normalEC), upEC));
        float wallFactor = 1.0 - smoothstep(0.55, 0.88, upFacing);
        float roofFactor = smoothstep(0.78, 0.95, upFacing);

        vec3 baseColor;
        vec3 paneColor;
        float roughness;
        float specularLevel;

        if (family < 0.30) {
          // Muted blue glass office tower.
          baseColor = vec3(0.31, 0.40, 0.44);
          paneColor = vec3(0.20, 0.29, 0.33);
          roughness = 0.26;
          specularLevel = 0.46;
        } else if (family < 0.50) {
          // Silver / neutral glass.
          baseColor = vec3(0.43, 0.47, 0.48);
          paneColor = vec3(0.28, 0.34, 0.36);
          roughness = 0.34;
          specularLevel = 0.38;
        } else if (family < 0.77) {
          // Warm residential / masonry context.
          baseColor = vec3(0.49, 0.47, 0.43);
          paneColor = vec3(0.23, 0.29, 0.31);
          roughness = 0.70;
          specularLevel = 0.18;
        } else {
          // Concrete / generic low-detail context.
          baseColor = vec3(0.45, 0.47, 0.46);
          paneColor = vec3(0.31, 0.34, 0.34);
          roughness = 0.82;
          specularLevel = 0.12;
        }

        // Small deterministic value shift stops large neighborhoods from reading as
        // one continuous monochrome mass while keeping the palette disciplined.
        float valueShift = (seed - 0.5) * 0.08;
        baseColor += vec3(valueShift);
        paneColor += vec3(valueShift * 0.5);

        float facadePane = windowMask * wallFactor;
        vec3 facadeColor = mix(baseColor, paneColor, facadePane * 0.72);
        vec3 roofColor = mix(baseColor, vec3(0.38, 0.40, 0.39), 0.34);
        vec3 finalColor = mix(facadeColor, roofColor, roofFactor);

        material.diffuse = finalColor;
        material.specular = vec3(specularLevel);
        material.roughness = mix(roughness, max(roughness, 0.72), roofFactor);
        material.occlusion = 1.0;
        material.emissive = vec3(0.0);
        material.alpha = 1.0;
      }
    `,
  })
}

/** Height-based safe fallback when procedural facade shading is disabled. */
export function createOsmContextFallbackStyle() {
  return new Cesium.Cesium3DTileStyle({
    color: {
      conditions: [
        ["${feature['cesium#estimatedHeight']} >= 150", "color('#9fb3bd', 1.0)"],
        ["${feature['cesium#estimatedHeight']} >= 50", "color('#aeb8bb', 1.0)"],
        ['true', "color('#929b9a', 1.0)"],
      ],
    },
  })
}

export function applyOsmContextVisuals(tileset: Cesium.Cesium3DTileset) {
  const params = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search)
  const facadeEnabled = params?.get('osmFacade') !== '0'

  if (!facadeEnabled) {
    tileset.customShader = undefined
    tileset.style = createOsmContextFallbackStyle()
    return 'height-style' as const
  }

  // Cesium documents undefined behavior when a Cesium3DTileStyle and CustomShader
  // are both used to modify model material. Clear the style before attaching the
  // facade shader.
  tileset.style = undefined
  tileset.customShader = createOsmContextFacadeShader()
  return OSM_CONTEXT_FACADE_VERSION
}
