/**
 * Runs an mpv-style multi-pass GLSL shader chain on WebGL2.
 *
 * This is deliberately a narrow runner for the FSRCNNX detail preset, not a
 * full mpv shader host. Every pass is a full-screen fragment shader; saved
 * outputs are RGBA8 render targets.
 */

import { parseMpvShader, type MpvPass } from "./mpvShader";

type TextureTarget = {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
};

type PassRuntime = {
  pass: MpvPass;
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
};

function compile(gl: WebGL2RenderingContext, type: number, source: string, label: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error(`Unable to create shader: ${label}`);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? `Shader compile failed: ${label}`;
    gl.deleteShader(shader);
    throw new Error(`${label}: ${log}`);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, vertexSource: string, fragmentSource: string, label: string) {
  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource, `${label}.vert`);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label}.frag`);
  const program = gl.createProgram();
  if (!program) throw new Error(`Unable to create program: ${label}`);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? `Program link failed: ${label}`;
    gl.deleteProgram(program);
    throw new Error(`${label}: ${log}`);
  }
  return program;
}

type TextureFormat = "rgba8" | "rgba16f";

function createTexture(gl: WebGL2RenderingContext, width: number, height: number, format: TextureFormat, filter: number) {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to create detail texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  if (format === "rgba16f") {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  return texture;
}

export class DetailUpscaler {
  private readonly gl: WebGL2RenderingContext;
  private readonly passes: PassRuntime[];
  private readonly targets = new Map<string, TextureTarget>();
  private readonly textureFormat: TextureFormat;
  private readonly filter: number;
  private readonly boundUnits: (WebGLTexture | null)[] = Array(8).fill(null);
  private sourceWidth = 0;
  private sourceHeight = 0;
  private outputWidth = 0;
  private outputHeight = 0;
  private outputTexture: TextureTarget | null = null;
  private sizeKey = "";

  constructor(gl: WebGL2RenderingContext, vertexSource: string, shaderSource: string) {
    this.gl = gl;
    // FSRCNNX feature maps contain negative values; RGBA8 clamps them to zero
    // and visibly brightens/desaturates the network output. Prefer half-float
    // render targets and fall back to RGBA8 only when the device cannot render
    // to float textures.
    const canRenderFloat = Boolean(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
    const canFilterFloat = Boolean(gl.getExtension("OES_texture_float_linear") || gl.getExtension("OES_texture_half_float_linear"));
    this.textureFormat = canRenderFloat ? "rgba16f" : "rgba8";
    this.filter = canRenderFloat && !canFilterFloat ? gl.NEAREST : gl.LINEAR;
    const passes = parseMpvShader(shaderSource);
    this.passes = passes.map(pass => {
      const program = link(gl, vertexSource, pass.fragment, pass.desc);
      const uniforms = new Map<string, WebGLUniformLocation | null>();
      for (const name of pass.binds) {
        if (name === "LUMA") uniforms.set(`u${name}Size`, gl.getUniformLocation(program, "uLUMASize"));
        else uniforms.set(`u${name}Size`, gl.getUniformLocation(program, `u${name}Size`));
        uniforms.set(`u${name}`, gl.getUniformLocation(program, `u${name}`));
      }
      uniforms.set("uOutSize", gl.getUniformLocation(program, "uOutSize"));
      return { pass, program, uniforms };
    });
  }

  get passCount() {
    return this.passes.length;
  }

  get detailSize() {
    return this.outputTexture ? { width: this.outputTexture.width, height: this.outputTexture.height } : null;
  }

  resize(sourceWidth: number, sourceHeight: number, outputWidth: number, outputHeight: number) {
    const key = `${sourceWidth}x${sourceHeight}:${outputWidth}x${outputHeight}`;
    if (key === this.sizeKey) return;
    this.disposeTargets();
    this.sourceWidth = sourceWidth;
    this.sourceHeight = sourceHeight;
    this.outputWidth = outputWidth;
    this.outputHeight = outputHeight;
    this.sizeKey = key;
  }

  private createRenderTarget(width: number, height: number, label: string): TextureTarget {
    const gl = this.gl;
    const texture = createTexture(gl, width, height, this.textureFormat, this.filter);
    const framebuffer = gl.createFramebuffer();
    if (!framebuffer) {
      gl.deleteTexture(texture);
      throw new Error(`Unable to create detail framebuffer: ${label}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      throw new Error(`Incomplete detail framebuffer: ${label}`);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { texture, framebuffer, width, height };
  }

  private disposeTargets() {
    for (const target of this.targets.values()) {
      this.gl.deleteFramebuffer(target.framebuffer);
      this.gl.deleteTexture(target.texture);
    }
    this.targets.clear();
    if (this.outputTexture) {
      this.gl.deleteFramebuffer(this.outputTexture.framebuffer);
      this.gl.deleteTexture(this.outputTexture.texture);
      this.outputTexture = null;
    }
    this.boundUnits.fill(null);
  }

  private targetSize(pass: MpvPass) {
    return {
      width: Math.max(1, Math.round(this.sourceWidth * pass.widthFactor)),
      height: Math.max(1, Math.round(this.sourceHeight * pass.heightFactor)),
    };
  }

  private targetFor(name: string, width: number, height: number, label: string) {
    const existing = this.targets.get(name);
    if (existing && existing.width === width && existing.height === height) return existing;
    if (existing) {
      this.gl.deleteFramebuffer(existing.framebuffer);
      this.gl.deleteTexture(existing.texture);
    }
    const target = this.createRenderTarget(width, height, label);
    this.targets.set(name, target);
    return target;
  }

  render(videoTexture: WebGLTexture, vertexArray: WebGLVertexArrayObject): WebGLTexture {
    const gl = this.gl;
    if (!this.sourceWidth || !this.sourceHeight) throw new Error("Detail upscaler has no source size");
    gl.bindVertexArray(vertexArray);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    this.boundUnits.fill(null);

    for (const runtime of this.passes) {
      const { pass } = runtime;
      const outSize = this.targetSize(pass);
      const targetName = pass.save ?? "__detail";
      const target = targetName === "__detail"
        ? (this.outputTexture && this.outputTexture.width === outSize.width && this.outputTexture.height === outSize.height
          ? this.outputTexture
          : (() => {
              if (this.outputTexture) {
                gl.deleteFramebuffer(this.outputTexture.framebuffer);
                gl.deleteTexture(this.outputTexture.texture);
              }
              this.outputTexture = this.createRenderTarget(outSize.width, outSize.height, pass.desc);
              return this.outputTexture;
            })())
        : this.targetFor(targetName, outSize.width, outSize.height, pass.desc);

      // Unbind only sampler units that still hold the destination texture to avoid feedback loops.
      for (let u = 0; u < this.boundUnits.length; u += 1) {
        if (this.boundUnits[u] === target.texture) {
          gl.activeTexture(gl.TEXTURE0 + u);
          gl.bindTexture(gl.TEXTURE_2D, null);
          this.boundUnits[u] = null;
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, outSize.width, outSize.height);
      gl.useProgram(runtime.program);

      let unit = 0;
      for (const bind of pass.binds) {
        let tex: WebGLTexture;
        if (bind === "LUMA") {
          tex = videoTexture;
          gl.uniform2f(runtime.uniforms.get("uLUMASize") ?? null, this.sourceWidth, this.sourceHeight);
        } else {
          const input = this.targets.get(bind);
          if (!input) throw new Error(`Missing detail input "${bind}" for pass "${pass.desc}"`);
          tex = input.texture;
          gl.uniform2f(runtime.uniforms.get(`u${bind}Size`) ?? null, input.width, input.height);
        }
        if (this.boundUnits[unit] !== tex) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          this.boundUnits[unit] = tex;
        }
        gl.uniform1i(runtime.uniforms.get(`u${bind}`) ?? null, unit);
        unit += 1;
      }
      gl.uniform2f(runtime.uniforms.get("uOutSize") ?? null, outSize.width, outSize.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!this.outputTexture) throw new Error("Detail upscaler produced no output");
    return this.outputTexture.texture;
  }

  dispose() {
    const gl = this.gl;
    this.disposeTargets();
    for (const runtime of this.passes) gl.deleteProgram(runtime.program);
  }
}
