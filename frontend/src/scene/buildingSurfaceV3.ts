import * as Cesium from 'cesium'

// Context material families are intentionally visual approximations. They do not
// assert the real facade material of an individual OSM building.
export function createBuildingSurfaceV3Shader() {
  return new Cesium.CustomShader({
    mode: Cesium.CustomShaderMode.MODIFY_MATERIAL,
    lightingModel: Cesium.LightingModel.PBR,
    varyings: {
      v_surfacePosition: Cesium.VaryingType.VEC3,
      v_surfaceNormal: Cesium.VaryingType.VEC3,
      v_seed: Cesium.VaryingType.FLOAT,
    },
    vertexShaderText: `
      void vertexMain(VertexInput vsInput, inout czm_modelVertexOutput vsOutput) {
        v_surfacePosition = vsInput.attributes.positionMC;
        v_surfaceNormal = normalize(vsInput.attributes.normalMC);
        v_seed = float(vsInput.featureIds.featureId_0);
      }
    `,
    fragmentShaderText: `
      float hash11(float p) {
        p = fract(p * 0.1031);
        p *= p + 33.33;
        p *= p + p;
        return fract(p);
      }

      vec3 srgbToLinearApprox(vec3 c) {
        return pow(c, vec3(2.2));
      }

      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
        vec3 p = v_surfacePosition;
        vec3 n = normalize(v_surfaceNormal);

        // OSM building tiles generally use an up axis consistent within each glTF.
        // This is a visual heuristic, not semantic geometry classification.
        vec3 upWC = normalize(fsInput.attributes.positionWC);
        vec3 upEC = normalize(czm_viewRotation * upWC);
        float upness = abs(dot(normalize(fsInput.attributes.normalEC), upEC));
        float roofMask = smoothstep(0.72, 0.94, upness);
        float facadeMask = 1.0 - roofMask;

        // Float varyings interpolate with small error; quantize the integer ID
        // before hashing so a facade cannot flicker between material families.
        float featureSeed = hash11(floor(v_seed + 0.5) + 1.0);

        vec3 glassBlue = srgbToLinearApprox(vec3(0.345, 0.463, 0.529));
        vec3 glassSilver = srgbToLinearApprox(vec3(0.529, 0.592, 0.620));
        vec3 residential = srgbToLinearApprox(vec3(0.769, 0.733, 0.690));
        vec3 stone = srgbToLinearApprox(vec3(0.725, 0.690, 0.643));
        vec3 concrete = srgbToLinearApprox(vec3(0.659, 0.686, 0.694));
        vec3 roof = srgbToLinearApprox(vec3(0.63, 0.68, 0.70));
        vec3 base = srgbToLinearApprox(vec3(0.412, 0.467, 0.486));

        vec3 facadeColor = concrete;
        float facadeRoughness = 0.84;
        float facadeSpecular = 0.12;

        if (featureSeed < 0.24) {
          facadeColor = glassBlue;
          facadeRoughness = 0.27;
          facadeSpecular = 0.42;
        } else if (featureSeed < 0.43) {
          facadeColor = glassSilver;
          facadeRoughness = 0.34;
          facadeSpecular = 0.36;
        } else if (featureSeed < 0.70) {
          facadeColor = residential;
          facadeRoughness = 0.73;
          facadeSpecular = 0.12;
        } else if (featureSeed < 0.82) {
          facadeColor = stone;
          facadeRoughness = 0.77;
          facadeSpecular = 0.10;
        }

        // Lightweight facade rhythm. This does not alter geometry.
        // Derive a tangent frame from geodetic up: OSM tiles need not be Z-up.
        vec3 upMC = normalize(mat3(czm_inverseModel) * upWC);
        vec3 eastMC = normalize(mat3(czm_inverseModel) * normalize(cross(vec3(0.0, 0.0, 1.0), upWC)));
        vec3 northMC = normalize(cross(upMC, eastMC));
        float vertical = dot(p, upMC);
        float horizontal = abs(dot(n, eastMC)) > abs(dot(n, northMC)) ? dot(p, northMC) : dot(p, eastMC);
        float detail = 1.0 - smoothstep(0.3, 1.6, max(fwidth(horizontal / 3.2), fwidth(vertical / 3.3)));
        float verticalGrid = smoothstep(0.90, 0.99, abs(sin(horizontal * 0.98)));
        float horizontalGrid = smoothstep(0.92, 0.99, abs(sin(vertical * 0.95)));
        float grid = clamp(max(verticalGrid * 0.55, horizontalGrid * 0.34), 0.0, 1.0);
        facadeColor *= mix(1.0, 0.72, grid * facadeMask * detail);

        // Darker base band to anchor the building mass. Model-space z is only a
        // local heuristic; keep the band restrained so it remains visually stable.
        // Ellipsoid height, not repeating model-space bands masquerading as bases.
        vec3 radii = vec3(6378137.0, 6378137.0, 6356752.314245);
        vec3 scaled = fsInput.attributes.positionWC / radii;
        float height = (length(scaled) - 1.0) * 6371000.0;
        float baseMask = facadeMask * (1.0 - smoothstep(10.0, 16.0, height));

        vec3 resultColor = mix(facadeColor, roof, roofMask);
        resultColor = mix(resultColor, vec3(dot(resultColor, vec3(0.2126, 0.7152, 0.0722))), 0.20);
        resultColor = mix(resultColor, base, baseMask * 0.72);

        material.diffuse = resultColor;
        material.roughness = mix(facadeRoughness, 0.82, roofMask);
        material.specular = vec3(mix(facadeSpecular, 0.10, roofMask));
        material.alpha = 1.0;
      }
    `,
  })
}

export function applyBuildingSurfaceV3(tileset: Cesium.Cesium3DTileset) {
  tileset.style = undefined
  tileset.customShader = createBuildingSurfaceV3Shader()
  tileset.shadows = Cesium.ShadowMode.CAST_ONLY
  return tileset.customShader
}
