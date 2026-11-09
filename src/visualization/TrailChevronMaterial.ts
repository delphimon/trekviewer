import type { Material } from 'three';

/**
 * How wide the ribbon is drawn. The geometry is built at `builtHalfWidth` (local metres); the
 * vertex shader narrows each station toward the centre line so the trail keeps roughly the
 * same apparent width (`angularHalfWidth`, radians from the viewer) at any zoom or in 1:1,
 * never wider than built and never thinner than `minHalfWidth` local metres.
 */
export interface TrailWidthOptions {
  builtHalfWidth: number;
  angularHalfWidth: number;
  minHalfWidth: number;
}

/** About 0.25° across: a clear line on Quest 3 and desktop that no longer hides the terrain. */
export const TRAIL_ANGULAR_HALF_WIDTH = 0.0022;

/** Pure version of the shader's width rule, for tests and CPU-side estimates. */
export function trailWidthFraction(options: TrailWidthOptions, viewDistance: number, modelScale: number): number {
  const want = Math.max(options.angularHalfWidth * viewDistance / Math.max(modelScale, 1e-6), options.minHalfWidth);
  return Math.min(1, Math.max(0, want / options.builtHalfWidth));
}

/** Paint arrows into the existing ribbon draw call using distance in GPX order, and size the ribbon by view distance. */
export function addTrailChevrons(material: Material, width: TrailWidthOptions, spacingM: number): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.trailChevronSpacing = { value: spacingM };
    shader.uniforms.trailChevronLength = { value: width.builtHalfWidth * 1.3 };
    shader.uniforms.trailChevronStroke = { value: width.builtHalfWidth * 0.18 };
    shader.uniforms.trailBuiltHalfWidth = { value: width.builtHalfWidth };
    shader.uniforms.trailAngularHalfWidth = { value: width.angularHalfWidth };
    shader.uniforms.trailMinHalfWidth = { value: width.minHalfWidth };
    shader.vertexShader = `attribute vec2 trailCoord;
attribute vec3 trailPartner;
uniform float trailBuiltHalfWidth;
uniform float trailAngularHalfWidth;
uniform float trailMinHalfWidth;
varying vec2 vTrailCoord;
varying float vTrailWidthFrac;
${shader.vertexShader}`.replace('#include <begin_vertex>', `#include <begin_vertex>
vTrailCoord = trailCoord;
// Narrow toward the centre line (the midpoint of this vertex and its opposite edge, which also
// interpolates the draped elevation) so the apparent width stays constant with distance.
vec3 trailMid = 0.5 * (position + trailPartner);
vec4 trailMidView = modelViewMatrix * vec4(trailMid, 1.0);
float trailModelScale = max(length(vec3(modelViewMatrix[0])), 1e-6);
float trailWantHalf = max(trailAngularHalfWidth * length(trailMidView.xyz) / trailModelScale, trailMinHalfWidth);
vTrailWidthFrac = clamp(trailWantHalf / trailBuiltHalfWidth, 0.0, 1.0);
transformed = mix(trailMid, transformed, vTrailWidthFrac);`);
    shader.fragmentShader = `varying vec2 vTrailCoord;
varying float vTrailWidthFrac;
uniform float trailChevronSpacing;
uniform float trailChevronLength;
uniform float trailChevronStroke;
${shader.fragmentShader}`.replace('#include <color_fragment>', `#include <color_fragment>
float trailFrac = clamp(vTrailWidthFrac, 1.0 / 64.0, 1.0);
// Power-of-two spacing levels: a finer level contains every arrow of the coarser one, so
// zooming adds arrows between the existing ones instead of sliding them along the trail.
float chevronSpacing = trailChevronSpacing * exp2(floor(log2(trailFrac) + 0.001));
float chevronLength = trailChevronLength * trailFrac;
float chevronStroke = trailChevronStroke * trailFrac;
// The tip is farther along the route than the wings, so it points forward.
float chevronPath = vTrailCoord.y + abs(vTrailCoord.x) * chevronLength;
float chevronPhase = mod(chevronPath + chevronSpacing * 0.5,
  chevronSpacing) - chevronSpacing * 0.5;
// Derive antialiasing before wrapping; the repeat seam must not draw a ghost arrow.
float chevronAA = max(fwidth(chevronPath), 0.0001);
float chevronEdgeAA = max(fwidth(vTrailCoord.x), 0.0001);
float chevronExtent = 1.0 - smoothstep(0.78 - chevronEdgeAA, 0.78 + chevronEdgeAA, abs(vTrailCoord.x));
float chevronOutline = (1.0 - smoothstep(chevronStroke * 1.8 - chevronAA,
  chevronStroke * 1.8 + chevronAA, abs(chevronPhase))) * chevronExtent;
float chevronWhite = (1.0 - smoothstep(chevronStroke - chevronAA,
  chevronStroke + chevronAA, abs(chevronPhase))) * chevronExtent;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.045, 0.065), chevronOutline);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), chevronWhite);
`);
  };
  material.customProgramCacheKey = () => 'trail-direction-chevrons-v2';
}
