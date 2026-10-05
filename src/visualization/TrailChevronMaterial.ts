import type { Material } from 'three';

/** Paint arrows into the existing ribbon draw call using distance in GPX order. */
export function addTrailChevrons(material: Material, halfWidth: number, spacingM: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.trailChevronSpacing = { value: spacingM };
    shader.uniforms.trailChevronLength = { value: halfWidth * 1.3 };
    shader.uniforms.trailChevronStroke = { value: halfWidth * 0.18 };
    shader.vertexShader = `attribute vec2 trailCoord;
varying vec2 vTrailCoord;
${shader.vertexShader}`.replace('#include <begin_vertex>',
      '#include <begin_vertex>\nvTrailCoord = trailCoord;');
    shader.fragmentShader = `varying vec2 vTrailCoord;
uniform float trailChevronSpacing;
uniform float trailChevronLength;
uniform float trailChevronStroke;
${shader.fragmentShader}`.replace('#include <color_fragment>', `#include <color_fragment>
// The tip is farther along the route than the wings, so it points forward.
float chevronPath = vTrailCoord.y + abs(vTrailCoord.x) * trailChevronLength;
float chevronPhase = mod(chevronPath + trailChevronSpacing * 0.5,
  trailChevronSpacing) - trailChevronSpacing * 0.5;
// Derive antialiasing before wrapping; the repeat seam must not draw a ghost arrow.
float chevronAA = max(fwidth(chevronPath), 0.0001);
float chevronEdgeAA = max(fwidth(vTrailCoord.x), 0.0001);
float chevronExtent = 1.0 - smoothstep(0.78 - chevronEdgeAA, 0.78 + chevronEdgeAA, abs(vTrailCoord.x));
float chevronOutline = (1.0 - smoothstep(trailChevronStroke * 1.8 - chevronAA,
  trailChevronStroke * 1.8 + chevronAA, abs(chevronPhase))) * chevronExtent;
float chevronWhite = (1.0 - smoothstep(trailChevronStroke - chevronAA,
  trailChevronStroke + chevronAA, abs(chevronPhase))) * chevronExtent;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.045, 0.065), chevronOutline);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), chevronWhite);
`);
  };
  material.customProgramCacheKey = () => 'trail-direction-chevrons-v1';
}
