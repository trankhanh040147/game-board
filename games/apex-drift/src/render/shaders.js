/**
 * GLSL ES 3.00 sources.
 *
 * Four small programs do all the work:
 *   mesh   — everything solid (road, scenery, cars) with hemi ambient + sun.
 *   sky    — fullscreen procedural gradient, sun disc/glow and a star field.
 *   glow   — additive camera-facing billboards (headlights, neon, nitro flame).
 *   blob   — soft ground ellipses used as cheap contact shadows.
 *
 * Everything shades in display space: palette colours are authored as final
 * values, which keeps the art direction predictable without a post pipeline.
 */

export const MESH_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec4 aColor;

uniform mat4 uViewProj;
uniform mat4 uModel;
uniform mat3 uNormalMat;

out vec3 vNormal;
out vec4 vColor;
out vec3 vWorld;

void main() {
  vec4 world = uModel * vec4(aPosition, 1.0);
  vWorld = world.xyz;
  vNormal = uNormalMat * aNormal;
  vColor = aColor;
  gl_Position = uViewProj * world;
}`;

export const MESH_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec3 vNormal;
in vec4 vColor;
in vec3 vWorld;

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbientSky;
uniform vec3 uAmbientGround;
uniform float uAmbientIntensity;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uCameraPos;
uniform vec3 uTint;
uniform float uEmissiveScale;

out vec4 outColor;

void main() {
  vec3 n = normalize(vNormal);
  vec3 base = vColor.rgb * uTint;
  float emissive = clamp(vColor.a * uEmissiveScale, 0.0, 1.0);

  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 hemi = mix(uAmbientGround, uAmbientSky, n.y * 0.5 + 0.5) * uAmbientIntensity;

  vec3 viewDir = normalize(uCameraPos - vWorld);
  vec3 halfDir = normalize(uSunDir + viewDir);
  float spec = pow(max(dot(n, halfDir), 0.0), 48.0) * 0.3 * (1.0 - emissive);

  vec3 color = base * (hemi + uSunColor * ndl) + uSunColor * spec * uTint;
  color += base * emissive * 1.4;

  float fog = smoothstep(uFogNear, uFogFar, distance(uCameraPos, vWorld));
  color = mix(color, uFogColor, fog);

  outColor = vec4(color, 1.0);
}`;

export const SKY_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPosition;
out vec2 vNdc;

void main() {
  vNdc = aPosition;
  gl_Position = vec4(aPosition, 1.0, 1.0);
}`;

export const SKY_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 vNdc;

uniform mat4 uInvViewProj;
uniform vec3 uCameraPos;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunGlow;
uniform float uSunSize;
uniform float uStars;
uniform float uTime;

out vec4 outColor;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec4 far = uInvViewProj * vec4(vNdc, 1.0, 1.0);
  vec3 world = far.xyz / far.w;
  vec3 dir = normalize(world - uCameraPos);

  float h = dir.y;
  vec3 sky = mix(uHorizon, uTop, smoothstep(0.0, 0.6, h));
  sky = mix(uBottom, sky, smoothstep(-0.32, 0.02, h));

  float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
  sky += uSunColor * (pow(sunDot, 14.0) * uSunGlow * 0.5 + pow(sunDot, 260.0) * uSunGlow * 1.2);
  float disc = smoothstep(1.0 - uSunSize, 1.0 - uSunSize * 0.35, sunDot);
  sky += uSunColor * disc * 3.0 * step(0.0005, uSunSize);

  if (uStars > 0.001 && h > 0.0) {
    vec2 starUv = vec2(atan(dir.z, dir.x), asin(clamp(h, -1.0, 1.0)));
    vec2 cell = floor(starUv * vec2(180.0, 240.0));
    float star = step(0.9965, hash21(cell));
    float twinkle = 0.65 + 0.35 * sin(uTime * 2.0 + hash21(cell) * 40.0);
    sky += vec3(star * twinkle * uStars * smoothstep(0.0, 0.25, h));
  }

  // Dither to hide gradient banding on 8-bit displays.
  float dither = (hash21(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(sky + dither, 1.0);
}`;

export const GLOW_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aCenter;
layout(location = 1) in vec2 aCorner;
layout(location = 2) in vec4 aColor;
layout(location = 3) in float aSize;

uniform mat4 uViewProj;
uniform vec3 uCamRight;
uniform vec3 uCamUp;

out vec3 vColor;
out float vIntensity;
out vec2 vUv;

void main() {
  vec3 world = aCenter + uCamRight * aCorner.x * aSize + uCamUp * aCorner.y * aSize;
  gl_Position = uViewProj * vec4(world, 1.0);
  vColor = aColor.rgb;
  vIntensity = aColor.a;
  vUv = aCorner;
}`;

export const GLOW_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec3 vColor;
in float vIntensity;
in vec2 vUv;

uniform float uIntensity;

out vec4 outColor;

void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  float falloff = pow(1.0 - d, 2.6);
  float core = smoothstep(0.45, 0.0, d);
  vec3 color = vColor * (falloff * 0.75 + core * 1.1) * vIntensity * uIntensity;
  outColor = vec4(color, 1.0);
}`;

export const BLOB_VERTEX = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aCenter;
layout(location = 1) in vec2 aCorner;
layout(location = 2) in vec4 aColor;
layout(location = 3) in float aSize;

uniform mat4 uViewProj;

out vec2 vUv;
out float vOpacity;
out vec3 vColor;

void main() {
  vec3 world = aCenter + vec3(aCorner.x * aColor.a, 0.0, aCorner.y * aSize);
  gl_Position = uViewProj * vec4(world, 1.0);
  vUv = aCorner;
  vOpacity = 1.0;
  vColor = aColor.rgb;
}`;

export const BLOB_FRAGMENT = /* glsl */ `#version 300 es
precision highp float;

in vec2 vUv;
in float vOpacity;
in vec3 vColor;

uniform float uOpacity;

out vec4 outColor;

void main() {
  float d = length(vUv);
  if (d > 1.0) discard;
  float alpha = pow(1.0 - d, 1.8) * vOpacity * uOpacity;
  outColor = vec4(vColor, alpha);
}`;
