/*
 * EASU and RCAS are adapted from AMD FidelityFX FSR 1 (ffx_fsr1.h).
 * Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import type { DetailUpscaler } from "./detailUpscaler";
import { superResolutionRequested, superResolutionVariant, type SuperResolutionVariant } from "./superResolutionRequest";
import type { SuperResolutionTestDeblock, SuperResolutionTestDetailGain, SuperResolutionTestFaceMask, SuperResolutionTestGrain, SuperResolutionTestPortraitContrast, SuperResolutionTestScale } from "../../shared/model/store";
import "../../styles/super-resolution.css";

type Fit = "contain" | "cover";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  fit?: Fit;
  active?: boolean;
  enabled?: boolean;
  variant?: SuperResolutionVariant;
  /** Test-only override for the output canvas size. */
  forceScale?: SuperResolutionTestScale;
  /** Test-only gain for the FSRCNNX detail composite. */
  detailGain?: SuperResolutionTestDetailGain;
  /** Test-only mid-frequency contrast for skin and facial detail. */
  portraitContrast?: SuperResolutionTestPortraitContrast;
  /** Test-only edge-preserving deblock strength for compressed sources. */
  deblock?: SuperResolutionTestDeblock;
  /** Test-only film-grain amplitude for synthetic faces. */
  grain?: SuperResolutionTestGrain;
  /** Test-only soft skin-tone mask strength for portrait contrast. */
  faceMask?: SuperResolutionTestFaceMask;
};

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: unknown) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

/**
 * FSR 1 EASU, ported from AMD's ffx_fsr1.h.
 * The GPU path uses texelFetch instead of gather4 so it works in WebGL2.
 */
const EASU_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform vec2 uInputSize;
uniform vec2 uOutputSize;
out vec4 outColor;

float min3(float a, float b, float c) { return min(a, min(b, c)); }
float max3(float a, float b, float c) { return max(a, max(b, c)); }

vec4 fetch(ivec2 p) {
  ivec2 hi = ivec2(uInputSize) - ivec2(1);
  return texelFetch(uSource, clamp(p, ivec2(0), hi), 0);
}

float luma(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }

void tap(inout vec3 color, inout float weight, vec2 off, vec2 dir, vec2 len, float lobe, float clip, vec3 sampleColor) {
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.x * (-dir.y) + off.y * dir.x);
  v *= len;
  float d2 = min(dot(v, v), clip);
  float wB = (2.0 / 5.0) * d2 - 1.0;
  float wA = lobe * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = (25.0 / 16.0) * wB - (25.0 / 16.0 - 1.0);
  float w = wB * wA;
  color += sampleColor * w;
  weight += w;
}

void setDirection(inout vec2 dir, inout float len, float lA, float lB, float lC, float lD, float lE, float w) {
  float dc = lD - lC;
  float cb = lC - lB;
  float lenX = max(abs(dc), abs(cb));
  lenX = 1.0 / max(lenX, 1.0 / 32768.0);
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
  lenX *= lenX;
  len += lenX * w;

  float ec = lE - lC;
  float ca = lC - lA;
  float lenY = max(abs(ec), abs(ca));
  lenY = 1.0 / max(lenY, 1.0 / 32768.0);
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
  lenY *= lenY;
  len += lenY * w;
}

void main() {
  vec2 scale = uInputSize / uOutputSize;
  vec2 ip = floor(gl_FragCoord.xy);
  vec2 pp = ip * scale + 0.5 * scale - 0.5;
  vec2 fp = floor(pp);
  vec2 f = pp - fp;
  ivec2 base = ivec2(fp);

  vec4 b = fetch(base + ivec2(0, -1));
  vec4 c = fetch(base + ivec2(1, -1));
  vec4 e = fetch(base + ivec2(-1, 0));
  vec4 f0 = fetch(base + ivec2(0, 0));
  vec4 g = fetch(base + ivec2(1, 0));
  vec4 h = fetch(base + ivec2(2, 0));
  vec4 i = fetch(base + ivec2(-1, 1));
  vec4 j = fetch(base + ivec2(0, 1));
  vec4 k = fetch(base + ivec2(1, 1));
  vec4 l = fetch(base + ivec2(2, 1));
  vec4 n = fetch(base + ivec2(0, 2));
  vec4 o = fetch(base + ivec2(1, 2));

  float bL = luma(b.rgb);
  float cL = luma(c.rgb);
  float eL = luma(e.rgb);
  float fL = luma(f0.rgb);
  float gL = luma(g.rgb);
  float hL = luma(h.rgb);
  float iL = luma(i.rgb);
  float jL = luma(j.rgb);
  float kL = luma(k.rgb);
  float lL = luma(l.rgb);
  float nL = luma(n.rgb);
  float oL = luma(o.rgb);

  vec2 dir = vec2(0.0);
  float len = 0.0;
  setDirection(dir, len, bL, eL, fL, gL, jL, (1.0 - f.x) * (1.0 - f.y));
  setDirection(dir, len, cL, fL, gL, hL, kL, f.x * (1.0 - f.y));
  setDirection(dir, len, fL, iL, jL, kL, nL, (1.0 - f.x) * f.y);
  setDirection(dir, len, gL, jL, kL, lL, oL, f.x * f.y);

  float dirR = dot(dir, dir);
  if (dirR < 1.0 / 32768.0) {
    dir = vec2(1.0, 0.0);
  } else {
    dir *= 1.0 / sqrt(dirR);
  }

  len *= 0.5;
  len *= len;
  float stretch = dot(dir, dir) / max(max(abs(dir.x), abs(dir.y)), 1.0 / 32768.0);
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lobe = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
  float clip = 1.0 / max(lobe, 1.0 / 32768.0);

  vec3 min4 = min(min(f0.rgb, g.rgb), min(j.rgb, k.rgb));
  vec3 max4 = max(max(f0.rgb, g.rgb), max(j.rgb, k.rgb));
  vec3 color = vec3(0.0);
  float weight = 0.0;

  tap(color, weight, vec2(0.0, -1.0) - f, dir, len2, lobe, clip, b.rgb);
  tap(color, weight, vec2(1.0, -1.0) - f, dir, len2, lobe, clip, c.rgb);
  tap(color, weight, vec2(-1.0, 1.0) - f, dir, len2, lobe, clip, i.rgb);
  tap(color, weight, vec2(0.0, 1.0) - f, dir, len2, lobe, clip, j.rgb);
  tap(color, weight, vec2(0.0, 0.0) - f, dir, len2, lobe, clip, f0.rgb);
  tap(color, weight, vec2(-1.0, 0.0) - f, dir, len2, lobe, clip, e.rgb);
  tap(color, weight, vec2(1.0, 1.0) - f, dir, len2, lobe, clip, k.rgb);
  tap(color, weight, vec2(2.0, 1.0) - f, dir, len2, lobe, clip, l.rgb);
  tap(color, weight, vec2(2.0, 0.0) - f, dir, len2, lobe, clip, h.rgb);
  tap(color, weight, vec2(1.0, 0.0) - f, dir, len2, lobe, clip, g.rgb);
  tap(color, weight, vec2(1.0, 2.0) - f, dir, len2, lobe, clip, o.rgb);
  tap(color, weight, vec2(0.0, 2.0) - f, dir, len2, lobe, clip, n.rgb);

  color = clamp(color / max(weight, 1.0 / 32768.0), min4, max4);
  outColor = vec4(color, 1.0);
}`;

/**
 * FSR 1 RCAS, ported from AMD's ffx_fsr1.h.
 * A separate post pass sharpens the EASU result without clipping local contrast.
 */
const RCAS_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform sampler2D uNative;
uniform vec2 uOutputSize;
uniform float uSharpness;
uniform float uLimit;
uniform float uStrength;
uniform float uMode;
out vec4 outColor;

float max3(float a, float b, float c) { return max(a, max(b, c)); }

void main() {
  vec2 uv = gl_FragCoord.xy / uOutputSize;
  vec2 stepUv = 1.0 / uOutputSize;

  // CAS samples the original video instead of the EASU output. EASU rounds
  // hard square corners; sharpening that result makes the rounding obvious.
  if (uMode > 0.5) {
    vec3 nb = texture(uNative, uv + vec2(0.0, -1.0) * stepUv).rgb;
    vec3 nd = texture(uNative, uv + vec2(-1.0, 0.0) * stepUv).rgb;
    vec3 ne = texture(uNative, uv).rgb;
    vec3 nf = texture(uNative, uv + vec2(1.0, 0.0) * stepUv).rgb;
    vec3 nh = texture(uNative, uv + vec2(0.0, 1.0) * stepUv).rgb;

    float nbL = nb.b * 0.5 + (nb.r * 0.5 + nb.g);
    float ndL = nd.b * 0.5 + (nd.r * 0.5 + nd.g);
    float neL = ne.b * 0.5 + (ne.r * 0.5 + ne.g);
    float nfL = nf.b * 0.5 + (nf.r * 0.5 + nf.g);
    float nhL = nh.b * 0.5 + (nh.r * 0.5 + nh.g);

    float detail = neL - (nbL + ndL + nfL + nhL) * 0.25;
    float casMin = min(min(nbL, ndL), min(nfL, nhL));
    float casMax = max(max(nbL, ndL), max(nfL, nhL));
    float casRange = max(casMax - casMin, 1e-4);
    float casAmp = sqrt(clamp(min(casMin, 2.0 - casMax) / casRange, 0.0, 1.0));
    outColor = vec4(clamp(ne + detail * (uStrength * casAmp), 0.0, 1.0), 1.0);
    return;
  }

  vec3 b = texture(uSource, uv + vec2(0.0, -1.0) * stepUv).rgb;
  vec3 d = texture(uSource, uv + vec2(-1.0, 0.0) * stepUv).rgb;
  vec3 e = texture(uSource, uv).rgb;
  vec3 f = texture(uSource, uv + vec2(1.0, 0.0) * stepUv).rgb;
  vec3 h = texture(uSource, uv + vec2(0.0, 1.0) * stepUv).rgb;

  float bL = b.b * 0.5 + (b.r * 0.5 + b.g);
  float dL = d.b * 0.5 + (d.r * 0.5 + d.g);
  float eL = e.b * 0.5 + (e.r * 0.5 + e.g);
  float fL = f.b * 0.5 + (f.r * 0.5 + f.g);
  float hL = h.b * 0.5 + (h.r * 0.5 + h.g);

  float mn4R = min(min(b.r, d.r), min(f.r, h.r));
  float mn4G = min(min(b.g, d.g), min(f.g, h.g));
  float mn4B = min(min(b.b, d.b), min(f.b, h.b));
  float mx4R = max(max(b.r, d.r), max(f.r, h.r));
  float mx4G = max(max(b.g, d.g), max(f.g, h.g));
  float mx4B = max(max(b.b, d.b), max(f.b, h.b));

  float hitMinR = min(mn4R, e.r) / max(4.0 * mx4R, 1.0 / 32768.0);
  float hitMinG = min(mn4G, e.g) / max(4.0 * mx4G, 1.0 / 32768.0);
  float hitMinB = min(mn4B, e.b) / max(4.0 * mx4B, 1.0 / 32768.0);
  float hitMaxR = (1.0 - max(mx4R, e.r)) / max(4.0 * mn4R - 4.0, 1.0 / 32768.0);
  float hitMaxG = (1.0 - max(mx4G, e.g)) / max(4.0 * mn4G - 4.0, 1.0 / 32768.0);
  float hitMaxB = (1.0 - max(mx4B, e.b)) / max(4.0 * mn4B - 4.0, 1.0 / 32768.0);

  float lobeR = max(-hitMinR, hitMaxR);
  float lobeG = max(-hitMinG, hitMaxG);
  float lobeB = max(-hitMinB, hitMaxB);
  float lobe = max(-uLimit, min(max3(lobeR, lobeG, lobeB), 0.0)) * exp2(-uSharpness);
  float rcpL = 1.0 / (4.0 * lobe + 1.0);
  outColor = vec4(
    (lobe * (b + d + f + h) + e) * rcpL,
    1.0
  );
}`;

/** A light 3x3 bilateral prefilter for 720p compression blocks. */
const DEBLOCK_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uSource;
uniform vec2 uInputSize;
uniform vec2 uOutputSize;
uniform float uStrength;
out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uOutputSize;
  vec2 texel = 1.0 / uInputSize;
  vec3 center = texture(uSource, uv).rgb;
  vec3 sum = center;
  float weightSum = 1.0;
  for (int y = -1; y <= 1; y += 1) {
    for (int x = -1; x <= 1; x += 1) {
      if (x == 0 && y == 0) continue;
      vec3 sampleColor = texture(uSource, uv + vec2(float(x), float(y)) * texel).rgb;
      float distanceSq = dot(sampleColor - center, sampleColor - center);
      float weight = exp(-distanceSq / 0.0025);
      sum += sampleColor * weight;
      weightSum += weight;
    }
  }
  vec3 filtered = sum / weightSum;
  outColor = vec4(mix(center, filtered, uStrength), 1.0);
}`;

/**
 * Adds only the high-frequency part of the FSRCNNX luma to the EASU color.
 * Replacing or offsetting all three RGB channels in gamma space brightens the
 * midtones and washes out saturation, so Cb/Cr are kept untouched here.
 */
const DETAIL_COMPOSITE_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uColor;
uniform sampler2D uDetail;
uniform vec2 uOutputSize;
uniform float uDetailGain;
uniform float uLocalContrast;
uniform float uGrain;
uniform float uFaceMask;
uniform float uFrame;
out vec4 outColor;

uint hashUint(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

float hash21(uvec2 p) {
  uint h = hashUint(p.x + hashUint(p.y));
  return float(h) * (1.0 / 4294967295.0);
}

vec3 rgbToYcbcr(vec3 c) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return vec3(y, (c.b - y) / 1.8556, (c.r - y) / 1.5748);
}

float colorLuma(vec2 uv) {
  return rgbToYcbcr(texture(uColor, uv).rgb).x;
}

vec3 ycbcrToRgb(vec3 c) {
  float y = c.x;
  float cb = c.y;
  float cr = c.z;
  return vec3(
    y + 1.5748 * cr,
    y - 0.187324 * cb - 0.468124 * cr,
    y + 1.8556 * cb
  );
}

void main() {
  vec2 uv = gl_FragCoord.xy / uOutputSize;
  vec3 color = texture(uColor, uv).rgb;

  // Remove the local DC term so a network bias cannot shift the whole frame.
  vec2 texel = 1.0 / vec2(textureSize(uDetail, 0));
  float detail = texture(uDetail, uv).r;
  float blurred = (
    texture(uDetail, uv + vec2(texel.x, 0.0)).r +
    texture(uDetail, uv - vec2(texel.x, 0.0)).r +
    texture(uDetail, uv + vec2(0.0, texel.y)).r +
    texture(uDetail, uv - vec2(0.0, texel.y)).r
  ) * 0.25;
  float high = detail - blurred;

  // A wider residual restores mid-frequency skin texture; restrict it to midtones so
  // subtitles and hard edges do not gain white halos.
  float broad = (
    texture(uDetail, uv + vec2(texel.x * 2.0, 0.0)).r +
    texture(uDetail, uv - vec2(texel.x * 2.0, 0.0)).r +
    texture(uDetail, uv + vec2(0.0, texel.y * 2.0)).r +
    texture(uDetail, uv - vec2(0.0, texel.y * 2.0)).r
  ) * 0.25;
  float middle = detail - broad;
  float wide = (
    texture(uDetail, uv + vec2(texel.x * 6.0, 0.0)).r +
    texture(uDetail, uv - vec2(texel.x * 6.0, 0.0)).r +
    texture(uDetail, uv + vec2(0.0, texel.y * 6.0)).r +
    texture(uDetail, uv - vec2(0.0, texel.y * 6.0)).r
  ) * 0.25;
  float middleWide = broad - wide;
  vec2 colorTexel = 1.0 / uOutputSize;
  float formLuma = (
    colorLuma(uv + vec2(colorTexel.x * 12.0, 0.0)) +
    colorLuma(uv - vec2(colorTexel.x * 12.0, 0.0)) +
    colorLuma(uv + vec2(0.0, colorTexel.y * 12.0)) +
    colorLuma(uv - vec2(0.0, colorTexel.y * 12.0))
  ) * 0.25;
  float form = rgbToYcbcr(color).x - formLuma;
  float portraitBand = middle + middleWide * 0.5 + form * 0.6;

  vec3 ycc = rgbToYcbcr(color);
  float midtone = smoothstep(0.08, 0.25, ycc.x) * (1.0 - smoothstep(0.8, 0.97, ycc.x));
  float cb = ycc.y - 0.5;
  float cr = ycc.z - 0.5;
  float skin = smoothstep(-0.10, -0.03, cb) * (1.0 - smoothstep(0.02, 0.08, cb))
    * smoothstep(0.01, 0.03, cr) * (1.0 - smoothstep(0.10, 0.16, cr));
  float faceWeight = mix(1.0, skin, uFaceMask);
  uvec2 noisePos = uvec2(gl_FragCoord.xy) + uvec2(uint(uFrame) * 17u, uint(uFrame) * 29u);
  float grain = (hash21(noisePos) - 0.5) * uGrain * midtone;
  ycc.x = clamp(ycc.x + high * uDetailGain + portraitBand * uLocalContrast * midtone * faceWeight + grain, 0.0, 1.0);
  outColor = vec4(clamp(ycbcrToRgb(ycc), 0.0, 1.0), 1.0);
}`;

const DETAIL_RESAMPLE_SHADER = `#version 300 es
precision highp float;

uniform sampler2D uDetail;
uniform vec2 uDetailSize;
uniform vec2 uOutputSize;
out vec4 outColor;

void main() {
  vec2 uv = gl_FragCoord.xy / uOutputSize;
  vec2 ratio = uDetailSize / uOutputSize;
  vec2 offset = 0.5 * ratio / uDetailSize;
  // A 2x2 box filter downscales the 2x FSRCNNX luma before compositing. The
  // detail target is larger than the canvas at non-integer scales such as
  // 1.43x; sampling it directly with NEAREST produces visible vertical lines.
  vec4 center = texture(uDetail, uv);
  vec4 a = texture(uDetail, uv + vec2(-offset.x, -offset.y));
  vec4 b = texture(uDetail, uv + vec2( offset.x, -offset.y));
  vec4 c = texture(uDetail, uv + vec2(-offset.x,  offset.y));
  vec4 d = texture(uDetail, uv + vec2( offset.x,  offset.y));
  vec4 box = (a + b + c + d) * 0.25;
  // Keep hard edges (eyes, hair, subtitles) sharp without reintroducing the
  // nearest-neighbour grid on flat skin.
  float edge = smoothstep(0.012, 0.10, abs(center.r - box.r));
  outColor = mix(box, center, edge * 0.75);
}`;

const FULLSCREEN_TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3]);
// FSR 1 is cheap, but a 720p source at 3x would be a 4K output. Cap the work
// at a 2.5 MP render target so the overlay stays viable on mobile GPUs.
const MAX_OUTPUT_PIXELS = 2_500_000;
// FSRCNNX is a 2x luma network; keep its composite output small enough for
// mobile GPUs. The network itself still runs at 2x source resolution, so also
// reject oversized sources instead of allocating an 8 MP detail pipeline.
const MAX_DETAIL_OUTPUT_PIXELS = 2_500_000;
const MAX_DETAIL_SOURCE_PIXELS = 1_500_000;

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "Shader compile failed";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string) {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "Program link failed";
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

function createTexture(gl: WebGL2RenderingContext, width: number, height: number, format: "rgba8" | "rgba16f" = "rgba8") {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to create texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const filter = format === "rgba16f" ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (format === "rgba16f") {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  return texture;
}

/** Test-only 2x output is capped to a conservative mobile texture side limit. */
const MAX_FORCED_TEXTURE_SIDE = 4096;

type ScaleInfo = { scale: number; detailTooLarge: boolean };

/** Display-driven scale before the "is it worth upscaling?" cutoff is applied. */
function measureScale(video: HTMLVideoElement, fit: Fit, variant: SuperResolutionVariant): ScaleInfo | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const rect = video.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;

  const aspect = vw / vh;
  let displayW = rect.width;
  let displayH = rect.height;
  if (fit === "contain") {
    if (rect.width / rect.height > aspect) {
      displayW = rect.height * aspect;
    } else {
      displayH = rect.width / aspect;
    }
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  const pixelBudget = variant === "detail" ? MAX_DETAIL_OUTPUT_PIXELS : MAX_OUTPUT_PIXELS;
  const pixelScale = Math.sqrt(pixelBudget / (vw * vh));
  const scale = Math.min((displayW * dpr) / vw, (displayH * dpr) / vh, 3, pixelScale);
  return { scale, detailTooLarge: variant === "detail" && vw * vh > MAX_DETAIL_SOURCE_PIXELS };
}

function outputSize(video: HTMLVideoElement, fit: Fit, variant: SuperResolutionVariant, forceScale: SuperResolutionTestScale = "auto") {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const info = measureScale(video, fit, variant);
  if (!info || info.detailTooLarge) return null;

  if (forceScale === "1x") return { width: vw, height: vh, scale: 1 };
  if (forceScale === "2x") {
    const width = vw * 2;
    const height = vh * 2;
    if (width > MAX_FORCED_TEXTURE_SIDE || height > MAX_FORCED_TEXTURE_SIDE) return null;
    return { width, height, scale: 2 };
  }

  if (!Number.isFinite(info.scale) || info.scale <= 1.01) return null;
  return { width: Math.round(vw * info.scale), height: Math.round(vh * info.scale), scale: info.scale };
}

export default function SuperResolutionCanvas({ videoRef, fit = "contain", active = true, enabled: enabledProp, variant: variantProp, forceScale: forceScaleProp, detailGain: detailGainProp, portraitContrast: portraitContrastProp, deblock: deblockProp, grain: grainProp, faceMask: faceMaskProp }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const enabled = enabledProp ?? superResolutionRequested();
  const variant = variantProp ?? superResolutionVariant();
  const forceScale = forceScaleProp ?? "auto";
  const detailGain = detailGainProp ?? 1;
  const portraitContrast = portraitContrastProp ?? 0;
  const deblock = deblockProp ?? 0;
  const grain = grainProp ?? 0;
  const faceMask = faceMaskProp ?? 0;
  const paramsRef = useRef({ detailGain, portraitContrast, deblock, grain, faceMask });
  paramsRef.current = { detailGain, portraitContrast, deblock, grain, faceMask };

  useEffect(() => {
    if (!enabled || !active || failed) return;
    const video = videoRef.current as FrameVideo | null;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const reportDiagnostics = typeof window !== "undefined" && new URLSearchParams(window.location.search).has("sr");

    let gl: WebGL2RenderingContext | null = null;
    let programEasu: WebGLProgram | null = null;
    let programRcas: WebGLProgram | null = null;
    let programComposite: WebGLProgram | null = null;
    let programDeblock: WebGLProgram | null = null;
    let programDetailResample: WebGLProgram | null = null;
    let detailUpscaler: DetailUpscaler | null = null;
    let videoTexture: WebGLTexture | null = null;
    let videoTexWidth = 0;
    let videoTexHeight = 0;
    let filteredTexture: WebGLTexture | null = null;
    let intermediate: WebGLTexture | null = null;
    let detailScaledTexture: WebGLTexture | null = null;
    let framebuffer: WebGLFramebuffer | null = null;
    let filterFramebuffer: WebGLFramebuffer | null = null;
    let detailFramebuffer: WebGLFramebuffer | null = null;
    let detailScaledFormat: "rgba8" | "rgba16f" = "rgba8";
    let filterWidth = 0;
    let filterHeight = 0;
    let vertexArray: WebGLVertexArrayObject | null = null;
    let vertexBuffer: WebGLBuffer | null = null;
    let disposed = false;
    let frameHandle = 0;
    let fallbackTimer = 0;
    let width = 0;
    let height = 0;
    let frames = 0;
    let sizeDirty = true;
    let measuredSize: ReturnType<typeof outputSize> = null;
    let resizeObserver: ResizeObserver | null = null;
    let easuSourceLoc: WebGLUniformLocation | null = null;
    let easuInputLoc: WebGLUniformLocation | null = null;
    let easuOutputLoc: WebGLUniformLocation | null = null;
    let rcasSourceLoc: WebGLUniformLocation | null = null;
    let rcasNativeLoc: WebGLUniformLocation | null = null;
    let rcasOutputLoc: WebGLUniformLocation | null = null;
    let rcasSharpLoc: WebGLUniformLocation | null = null;
    let rcasLimitLoc: WebGLUniformLocation | null = null;
    let rcasStrengthLoc: WebGLUniformLocation | null = null;
    let rcasModeLoc: WebGLUniformLocation | null = null;
    let compositeColorLoc: WebGLUniformLocation | null = null;
    let compositeDetailLoc: WebGLUniformLocation | null = null;
    let compositeOutputLoc: WebGLUniformLocation | null = null;
    let compositeDetailGainLoc: WebGLUniformLocation | null = null;
    let compositeLocalContrastLoc: WebGLUniformLocation | null = null;
    let compositeGrainLoc: WebGLUniformLocation | null = null;
    let compositeFaceMaskLoc: WebGLUniformLocation | null = null;
    let compositeFrameLoc: WebGLUniformLocation | null = null;
    let deblockSourceLoc: WebGLUniformLocation | null = null;
    let deblockInputLoc: WebGLUniformLocation | null = null;
    let deblockOutputLoc: WebGLUniformLocation | null = null;
    let deblockStrengthLoc: WebGLUniformLocation | null = null;
    let resampleDetailLoc: WebGLUniformLocation | null = null;
    let resampleDetailSizeLoc: WebGLUniformLocation | null = null;
    let resampleOutputLoc: WebGLUniformLocation | null = null;

    const onContextLost = (event: Event) => {
      event.preventDefault();
      setFailed(true);
      stop();
    };

    const stop = () => {
      disposed = true;
      if (frameHandle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
      if (fallbackTimer) window.clearInterval(fallbackTimer);
      resizeObserver?.disconnect();
      if (gl) {
        if (videoTexture) gl.deleteTexture(videoTexture);
        if (filteredTexture) gl.deleteTexture(filteredTexture);
        if (intermediate) gl.deleteTexture(intermediate);
        if (detailScaledTexture) gl.deleteTexture(detailScaledTexture);
        if (framebuffer) gl.deleteFramebuffer(framebuffer);
        if (filterFramebuffer) gl.deleteFramebuffer(filterFramebuffer);
        if (detailFramebuffer) gl.deleteFramebuffer(detailFramebuffer);
        if (programEasu) gl.deleteProgram(programEasu);
        if (programRcas) gl.deleteProgram(programRcas);
        if (programComposite) gl.deleteProgram(programComposite);
        if (programDeblock) gl.deleteProgram(programDeblock);
        if (programDetailResample) gl.deleteProgram(programDetailResample);
        if (detailUpscaler) detailUpscaler.dispose();
        if (vertexArray) gl.deleteVertexArray(vertexArray);
        if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
      }
      video.removeEventListener("loadeddata", drawOnce);
      video.removeEventListener("playing", drawOnce);
      video.removeEventListener("seeked", drawOnce);
      video.removeEventListener("resize", onSizeDirty);
      window.removeEventListener("resize", onSizeDirty);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.style.display = "none";
    };

    const drawOnce = () => safeDraw(true);
    const onSizeDirty = () => {
      sizeDirty = true;
      safeDraw(true);
    };

    const resize = (nextWidth: number, nextHeight: number) => {
      if (!gl) return;
      width = nextWidth;
      height = nextHeight;
      canvas.width = width;
      canvas.height = height;
      if (intermediate) gl.deleteTexture(intermediate);
      intermediate = createTexture(gl, width, height);
      if (detailScaledTexture) gl.deleteTexture(detailScaledTexture);
      detailScaledTexture = createTexture(gl, width, height, detailScaledFormat);
      if (detailUpscaler && video.videoWidth && video.videoHeight) {
        detailUpscaler.resize(video.videoWidth, video.videoHeight, width, height);
      }
      if (!framebuffer) framebuffer = gl.createFramebuffer();
      if (!framebuffer) throw new Error("Unable to create framebuffer");
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, intermediate, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("Incomplete framebuffer");
      }
      if (variant === "detail") {
        if (!detailFramebuffer) detailFramebuffer = gl.createFramebuffer();
        if (!detailFramebuffer) throw new Error("Unable to create detail resample framebuffer");
        gl.bindFramebuffer(gl.FRAMEBUFFER, detailFramebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, detailScaledTexture, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error("Incomplete detail resample framebuffer");
        }
      }
      for (let unit = 0; unit < 2; unit += 1) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };

    const ensureFilterTarget = () => {
      if (!gl || !videoTexture) return false;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return false;
      if (filteredTexture && filterFramebuffer && filterWidth === vw && filterHeight === vh) return true;
      if (filteredTexture) gl.deleteTexture(filteredTexture);
      filteredTexture = createTexture(gl, vw, vh);
      filterWidth = vw;
      filterHeight = vh;
      if (!filterFramebuffer) filterFramebuffer = gl.createFramebuffer();
      if (!filterFramebuffer) throw new Error("Unable to create deblock framebuffer");
      gl.bindFramebuffer(gl.FRAMEBUFFER, filterFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, filteredTexture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("Incomplete deblock framebuffer");
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return true;
    };

    const draw = (force = false) => {
      if (disposed || !gl || !video) return;
      if (video.readyState < 2 || !video.videoWidth) return;
      if (force || sizeDirty || !measuredSize) {
        measuredSize = outputSize(video, fit, variant, forceScale);
        sizeDirty = false;
      }
      const size = measuredSize;
      if (!size) {
        canvas.dataset.active = "off";
        canvas.style.display = "none";
        return;
      }
      if (canvas.style.display !== "block") canvas.style.display = "block";
      if (canvas.dataset.active !== "on") canvas.dataset.active = "on";
      if (reportDiagnostics || frames === 0) canvas.dataset.scale = size.scale.toFixed(2);
      if (size.width !== width || size.height !== height) resize(size.width, size.height);
      if (!force && frames > 0 && video.paused) return;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      try {
        if (videoTexWidth === vw && videoTexHeight === vh) {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, video);
        } else {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
          videoTexWidth = vw;
          videoTexHeight = vh;
        }
      } catch {
        setFailed(true);
        stop();
        return;
      }

      if (!programEasu || !intermediate || !framebuffer || !vertexArray) return;
      const started = reportDiagnostics ? performance.now() : 0;
      const params = paramsRef.current;
      if (variant === "detail") {
        if (!detailUpscaler || !programComposite || !videoTexture) return;
        const baseTexture: WebGLTexture = videoTexture;
        let sourceTexture = baseTexture;
        if (params.deblock > 0 && programDeblock && ensureFilterTarget() && filteredTexture) {
          gl.bindFramebuffer(gl.FRAMEBUFFER, filterFramebuffer);
          gl.viewport(0, 0, vw, vh);
          gl.useProgram(programDeblock);
          gl.bindVertexArray(vertexArray);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, videoTexture);
          gl.uniform1i(deblockSourceLoc, 0);
          gl.uniform2f(deblockInputLoc, vw, vh);
          gl.uniform2f(deblockOutputLoc, vw, vh);
          gl.uniform1f(deblockStrengthLoc, params.deblock);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          sourceTexture = filteredTexture;
        }
        const detailTexture = detailUpscaler.render(sourceTexture, vertexArray);
        const detailSize = detailUpscaler.detailSize;
        if (!detailSize) return;
        let compositeDetail = detailTexture;
        if (detailSize.width > width + 1 || detailSize.height > height + 1) {
          if (!programDetailResample || !detailScaledTexture || !detailFramebuffer) return;
          gl.bindFramebuffer(gl.FRAMEBUFFER, detailFramebuffer);
          gl.viewport(0, 0, width, height);
          gl.useProgram(programDetailResample);
          gl.bindVertexArray(vertexArray);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, detailTexture);
          gl.uniform1i(resampleDetailLoc, 0);
          gl.uniform2f(resampleDetailSizeLoc, detailSize.width, detailSize.height);
          gl.uniform2f(resampleOutputLoc, width, height);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          compositeDetail = detailScaledTexture;
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.viewport(0, 0, width, height);
        gl.useProgram(programEasu);
        gl.bindVertexArray(vertexArray);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
        gl.uniform1i(easuSourceLoc, 0);
        gl.uniform2f(easuInputLoc, video.videoWidth, video.videoHeight);
        gl.uniform2f(easuOutputLoc, width, height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.useProgram(programComposite);
        gl.bindVertexArray(vertexArray);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, intermediate);
        gl.uniform1i(compositeColorLoc, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, compositeDetail);
        gl.uniform1i(compositeDetailLoc, 1);
        gl.uniform2f(compositeOutputLoc, width, height);
        gl.uniform1f(compositeDetailGainLoc, params.detailGain);
        gl.uniform1f(compositeLocalContrastLoc, params.portraitContrast);
        gl.uniform1f(compositeGrainLoc, params.grain);
        gl.uniform1f(compositeFaceMaskLoc, params.faceMask);
        gl.uniform1f(compositeFrameLoc, frames);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (reportDiagnostics || frames === 0) canvas.dataset.detailPasses = String(detailUpscaler.passCount);
      } else {
        if (!programRcas) return;
        gl.viewport(0, 0, width, height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.useProgram(programEasu);
        gl.bindVertexArray(vertexArray);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, videoTexture);
        gl.uniform1i(easuSourceLoc, 0);
        gl.uniform2f(easuInputLoc, vw, vh);
        gl.uniform2f(easuOutputLoc, width, height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.useProgram(programRcas);
        gl.bindVertexArray(vertexArray);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, intermediate);
        gl.uniform1i(rcasSourceLoc, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, videoTexture);
        gl.uniform1i(rcasNativeLoc, 1);
        gl.uniform2f(rcasOutputLoc, width, height);
        gl.uniform1f(rcasSharpLoc, 0.0);
        gl.uniform1f(rcasLimitLoc, 0.1875);
        gl.uniform1f(rcasStrengthLoc, variant === "cas" ? 0.90 : 1.0);
        gl.uniform1f(rcasModeLoc, variant === "cas" ? 1.0 : 0.0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      frames += 1;
      if (reportDiagnostics || frames === 1) {
        canvas.dataset.frames = String(frames);
        if (reportDiagnostics) canvas.dataset.cpuMs = (performance.now() - started).toFixed(2);
      }
    };

    const safeDraw = (force = false) => {
      try {
        draw(force);
      } catch (error) {
        console.error("[super-resolution] draw failed", error);
        setFailed(true);
        stop();
      }
    };

    const schedule = () => {
      if (disposed) return;
      if (video.requestVideoFrameCallback) {
        frameHandle = video.requestVideoFrameCallback(() => {
          safeDraw();
          if (!disposed) schedule();
        });
        return;
      }
      fallbackTimer = window.setInterval(() => safeDraw(), 33);
    };

    try {
      gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: "high-performance" });
      if (!gl) throw new Error("WebGL2 unavailable");
      programEasu = link(gl, VERTEX_SHADER, EASU_SHADER);
      programRcas = link(gl, VERTEX_SHADER, RCAS_SHADER);
      if (variant === "detail") {
        const canRenderHalf = Boolean(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
        detailScaledFormat = canRenderHalf ? "rgba16f" : "rgba8";
        programComposite = link(gl, VERTEX_SHADER, DETAIL_COMPOSITE_SHADER);
        programDeblock = link(gl, VERTEX_SHADER, DEBLOCK_SHADER);
        programDetailResample = link(gl, VERTEX_SHADER, DETAIL_RESAMPLE_SHADER);
        void (async () => {
          try {
            /* Keep the 26-pass runner and its weights out of the main bundle. */
            const [runner, shader] = await Promise.all([
              import("./detailUpscaler"),
              import("./shaders/FSRCNNX_x2_16_0_4_1.glsl?raw"),
            ]);
            if (disposed || !gl) return;
            detailUpscaler = new runner.DetailUpscaler(gl, VERTEX_SHADER, shader.default);
            if (video.videoWidth && video.videoHeight && width && height) {
              detailUpscaler.resize(video.videoWidth, video.videoHeight, width, height);
            }
            drawOnce();
          } catch (error) {
            console.error("[super-resolution] detail shader load failed", error);
            setFailed(true);
            stop();
          }
        })();
      }
      easuSourceLoc = gl.getUniformLocation(programEasu, "uSource");
      easuInputLoc = gl.getUniformLocation(programEasu, "uInputSize");
      easuOutputLoc = gl.getUniformLocation(programEasu, "uOutputSize");
      rcasSourceLoc = gl.getUniformLocation(programRcas, "uSource");
      rcasNativeLoc = gl.getUniformLocation(programRcas, "uNative");
      rcasOutputLoc = gl.getUniformLocation(programRcas, "uOutputSize");
      rcasSharpLoc = gl.getUniformLocation(programRcas, "uSharpness");
      rcasLimitLoc = gl.getUniformLocation(programRcas, "uLimit");
      rcasStrengthLoc = gl.getUniformLocation(programRcas, "uStrength");
      rcasModeLoc = gl.getUniformLocation(programRcas, "uMode");
      if (programComposite) {
        compositeColorLoc = gl.getUniformLocation(programComposite, "uColor");
        compositeDetailLoc = gl.getUniformLocation(programComposite, "uDetail");
        compositeOutputLoc = gl.getUniformLocation(programComposite, "uOutputSize");
        compositeDetailGainLoc = gl.getUniformLocation(programComposite, "uDetailGain");
        compositeLocalContrastLoc = gl.getUniformLocation(programComposite, "uLocalContrast");
        compositeGrainLoc = gl.getUniformLocation(programComposite, "uGrain");
        compositeFaceMaskLoc = gl.getUniformLocation(programComposite, "uFaceMask");
        compositeFrameLoc = gl.getUniformLocation(programComposite, "uFrame");
        if (programDeblock) {
          deblockSourceLoc = gl.getUniformLocation(programDeblock, "uSource");
          deblockInputLoc = gl.getUniformLocation(programDeblock, "uInputSize");
          deblockOutputLoc = gl.getUniformLocation(programDeblock, "uOutputSize");
          deblockStrengthLoc = gl.getUniformLocation(programDeblock, "uStrength");
        }
        if (programDetailResample) {
          resampleDetailLoc = gl.getUniformLocation(programDetailResample, "uDetail");
          resampleDetailSizeLoc = gl.getUniformLocation(programDetailResample, "uDetailSize");
          resampleOutputLoc = gl.getUniformLocation(programDetailResample, "uOutputSize");
        }
      }
      videoTexture = createTexture(gl, video.videoWidth || 2, video.videoHeight || 2);
      vertexArray = gl.createVertexArray();
      vertexBuffer = gl.createBuffer();
      if (!vertexArray || !vertexBuffer) throw new Error("Unable to create WebGL buffers");
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      drawOnce();
      schedule();
    } catch (error) {
      console.error("[super-resolution] init failed", error);
      setFailed(true);
      stop();
      return;
    }

    video.addEventListener("loadeddata", drawOnce);
    video.addEventListener("playing", drawOnce);
    video.addEventListener("seeked", drawOnce);
    video.addEventListener("resize", onSizeDirty);
    window.addEventListener("resize", onSizeDirty);
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(onSizeDirty);
      resizeObserver.observe(video);
    }

    return stop;
  }, [active, enabled, failed, fit, forceScale, videoRef, variant]);

  if (!enabled) return null;

  return (
    <div className="hg-super-resolution" aria-hidden="true" data-super-resolution={enabled ? "on" : "off"} data-super-resolution-mode={variant}
      data-super-resolution-force={forceScale} data-super-resolution-detail-gain={detailGain.toFixed(1)}
      data-super-resolution-detail-local={portraitContrast.toFixed(1)}
      data-super-resolution-deblock={deblock.toFixed(1)} data-super-resolution-grain={grain.toFixed(2)}
      data-super-resolution-face-mask={faceMask.toFixed(1)}>
      {!failed && <canvas
        ref={canvasRef}
        className={`hg-super-resolution-canvas sr-fit-${fit}`}
        data-super-resolution-canvas={enabled ? "on" : "off"}
      />}
    </div>
  );
}
