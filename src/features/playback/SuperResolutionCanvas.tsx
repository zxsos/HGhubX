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
import "../../styles/super-resolution.css";

type Fit = "contain" | "cover";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  fit?: Fit;
  active?: boolean;
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

  // Experimental CAS-like unsharp path for ?sr=cas. It sharpens luminance
  // detail after EASU without changing hue; uStrength controls the halo tradeoff.
  if (uMode > 0.5) {
    float detail = eL - (bL + dL + fL + hL) * 0.25;
    float casMin = min(min(bL, dL), min(fL, hL));
    float casMax = max(max(bL, dL), max(fL, hL));
    float casRange = max(casMax - casMin, 1e-4);
    float casAmp = sqrt(clamp(min(casMin, 2.0 - casMax) / casRange, 0.0, 1.0));
    outColor = vec4(clamp(e + detail * (uStrength * casAmp), 0.0, 1.0), 1.0);
    return;
  }

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

const FULLSCREEN_TRIANGLE = new Float32Array([-1, -1, 3, -1, -1, 3]);
// FSR 1 is cheap, but a 720p source at 3x would be a 4K output. Cap the work
// at a 2.5 MP render target so the overlay stays viable on mobile GPUs.
const MAX_OUTPUT_PIXELS = 2_500_000;

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

function createTexture(gl: WebGL2RenderingContext, width: number, height: number) {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to create texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return texture;
}

export type SuperResolutionVariant = "fsr" | "cas";

/** The hidden prototype switch: ?sr=1, ?sr=fsr, or ?sr=cas. */
export function superResolutionRequested() {
  if (typeof window === "undefined") return false;
  const value = new URLSearchParams(window.location.search).get("sr");
  return value === "1" || value === "fsr" || value === "cas";
}

export function superResolutionVariant(): SuperResolutionVariant {
  if (typeof window === "undefined") return "fsr";
  return new URLSearchParams(window.location.search).get("sr") === "cas" ? "cas" : "fsr";
}

function outputSize(video: HTMLVideoElement, fit: Fit) {
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
  const pixelScale = Math.sqrt(MAX_OUTPUT_PIXELS / (vw * vh));
  const scale = Math.min((displayW * dpr) / vw, (displayH * dpr) / vh, 3, pixelScale);
  if (!Number.isFinite(scale) || scale <= 1.01) return null;
  return { width: Math.round(vw * scale), height: Math.round(vh * scale), scale };
}

export default function SuperResolutionCanvas({ videoRef, fit = "contain", active = true }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const [enabled] = useState(superResolutionRequested);
  const [variant] = useState(superResolutionVariant);

  useEffect(() => {
    if (!enabled || !active || failed) return;
    const video = videoRef.current as FrameVideo | null;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    let gl: WebGL2RenderingContext | null = null;
    let programEasu: WebGLProgram | null = null;
    let programRcas: WebGLProgram | null = null;
    let videoTexture: WebGLTexture | null = null;
    let intermediate: WebGLTexture | null = null;
    let framebuffer: WebGLFramebuffer | null = null;
    let vertexArray: WebGLVertexArrayObject | null = null;
    let vertexBuffer: WebGLBuffer | null = null;
    let disposed = false;
    let frameHandle = 0;
    let fallbackTimer = 0;
    let width = 0;
    let height = 0;
    let frames = 0;
    let measuredAt = 0;
    let measuredSize: ReturnType<typeof outputSize> = null;
    let easuSourceLoc: WebGLUniformLocation | null = null;
    let easuInputLoc: WebGLUniformLocation | null = null;
    let easuOutputLoc: WebGLUniformLocation | null = null;
    let rcasSourceLoc: WebGLUniformLocation | null = null;
    let rcasOutputLoc: WebGLUniformLocation | null = null;
    let rcasSharpLoc: WebGLUniformLocation | null = null;
    let rcasLimitLoc: WebGLUniformLocation | null = null;
    let rcasStrengthLoc: WebGLUniformLocation | null = null;
    let rcasModeLoc: WebGLUniformLocation | null = null;

    const onContextLost = (event: Event) => {
      event.preventDefault();
      setFailed(true);
      stop();
    };

    const stop = () => {
      disposed = true;
      if (frameHandle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameHandle);
      if (fallbackTimer) window.clearInterval(fallbackTimer);
      if (gl) {
        if (videoTexture) gl.deleteTexture(videoTexture);
        if (intermediate) gl.deleteTexture(intermediate);
        if (framebuffer) gl.deleteFramebuffer(framebuffer);
        if (programEasu) gl.deleteProgram(programEasu);
        if (programRcas) gl.deleteProgram(programRcas);
        if (vertexArray) gl.deleteVertexArray(vertexArray);
        if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
      }
      video.removeEventListener("loadeddata", drawOnce);
      video.removeEventListener("playing", drawOnce);
      video.removeEventListener("seeked", drawOnce);
      video.removeEventListener("resize", drawOnce);
      window.removeEventListener("resize", drawOnce);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.style.display = "none";
      if (canvas.parentElement) canvas.parentElement.style.display = "none";
    };

    const drawOnce = () => safeDraw(true);

    const resize = (nextWidth: number, nextHeight: number) => {
      if (!gl) return;
      width = nextWidth;
      height = nextHeight;
      canvas.width = width;
      canvas.height = height;
      if (intermediate) gl.deleteTexture(intermediate);
      intermediate = createTexture(gl, width, height);
      if (!framebuffer) framebuffer = gl.createFramebuffer();
      if (!framebuffer) throw new Error("Unable to create framebuffer");
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, intermediate, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("Incomplete framebuffer");
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    };

    const draw = (force = false) => {
      if (disposed || !gl || !video || video.readyState < 2 || !video.videoWidth) return;
      const now = performance.now();
      if (force || !measuredSize || now - measuredAt > 500) {
        measuredSize = outputSize(video, fit);
        measuredAt = now;
      }
      const size = measuredSize;
      if (!size) {
        canvas.dataset.active = "off";
        canvas.style.display = "none";
        if (canvas.parentElement) canvas.parentElement.style.display = "none";
        return;
      }
      canvas.style.display = "block";
      if (canvas.parentElement) canvas.parentElement.style.display = "block";
      canvas.dataset.active = "on";
      canvas.dataset.scale = size.scale.toFixed(2);
      if (size.width !== width || size.height !== height) resize(size.width, size.height);
      if (!force && frames > 0 && video.paused) return;

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, videoTexture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch {
        setFailed(true);
        stop();
        return;
      }

      if (!programEasu || !programRcas || !intermediate || !framebuffer) return;
      const started = performance.now();
      gl.viewport(0, 0, width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.useProgram(programEasu);
      gl.bindVertexArray(vertexArray);
      gl.uniform1i(easuSourceLoc, 0);
      gl.uniform2f(easuInputLoc, video.videoWidth, video.videoHeight);
      gl.uniform2f(easuOutputLoc, width, height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      gl.useProgram(programRcas);
      gl.bindVertexArray(vertexArray);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, intermediate);
      gl.uniform1i(rcasSourceLoc, 0);
      gl.uniform2f(rcasOutputLoc, width, height);
      gl.uniform1f(rcasSharpLoc, 0.0);
      gl.uniform1f(rcasLimitLoc, 0.1875);
      gl.uniform1f(rcasStrengthLoc, variant === "cas" ? 0.45 : 1.0);
      gl.uniform1f(rcasModeLoc, variant === "cas" ? 1.0 : 0.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      frames += 1;
      canvas.dataset.frames = String(frames);
      canvas.dataset.cpuMs = (performance.now() - started).toFixed(2);
    };

    const safeDraw = (force = false) => {
      try {
        draw(force);
      } catch {
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
      gl = canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: false });
      if (!gl) throw new Error("WebGL2 unavailable");
      programEasu = link(gl, VERTEX_SHADER, EASU_SHADER);
      programRcas = link(gl, VERTEX_SHADER, RCAS_SHADER);
      easuSourceLoc = gl.getUniformLocation(programEasu, "uSource");
      easuInputLoc = gl.getUniformLocation(programEasu, "uInputSize");
      easuOutputLoc = gl.getUniformLocation(programEasu, "uOutputSize");
      rcasSourceLoc = gl.getUniformLocation(programRcas, "uSource");
      rcasOutputLoc = gl.getUniformLocation(programRcas, "uOutputSize");
      rcasSharpLoc = gl.getUniformLocation(programRcas, "uSharpness");
      rcasLimitLoc = gl.getUniformLocation(programRcas, "uLimit");
      rcasStrengthLoc = gl.getUniformLocation(programRcas, "uStrength");
      rcasModeLoc = gl.getUniformLocation(programRcas, "uMode");
      videoTexture = createTexture(gl, video.videoWidth || 2, video.videoHeight || 2);
      vertexArray = gl.createVertexArray();
      vertexBuffer = gl.createBuffer();
      if (!vertexArray || !vertexBuffer) throw new Error("Unable to create WebGL buffers");
      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE, gl.STATIC_DRAW);
      const position = gl.getAttribLocation(programEasu, "aPosition");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      drawOnce();
      schedule();
    } catch {
      setFailed(true);
      stop();
      return;
    }

    video.addEventListener("loadeddata", drawOnce);
    video.addEventListener("playing", drawOnce);
    video.addEventListener("seeked", drawOnce);
    video.addEventListener("resize", drawOnce);

    return stop;
  }, [active, enabled, failed, fit, videoRef, variant]);

  if (failed) return null;

  return (
    <div className="hg-super-resolution" aria-hidden="true" data-super-resolution={enabled ? "on" : "off"} data-super-resolution-mode={variant}>
      <canvas
        ref={canvasRef}
        className={`hg-super-resolution-canvas sr-fit-${fit}`}
        data-super-resolution-canvas={enabled ? "on" : "off"}
      />
    </div>
  );
}
