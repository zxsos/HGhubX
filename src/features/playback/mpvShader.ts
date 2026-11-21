/**
 * Minimal parser for the mpv user-shader syntax used by FSRCNNX.
 *
 * This only implements the directives needed by the single preset we ship:
 * HOOK, BIND, SAVE, WIDTH, HEIGHT, COMPONENTS and DESC. It intentionally does
 * not pretend to be a general mpv shader host.
 */

export type MpvPass = {
  desc: string;
  hook: string;
  binds: string[];
  save: string | null;
  widthFactor: number;
  heightFactor: number;
  components: 1 | 4;
  fragment: string;
};

const LUMA_WEIGHTS = "vec3(0.2126, 0.7152, 0.0722)";

function parseSizeFactor(line: string): number {
  // The shipped shader only uses "LUMA.w 2 *" / "LUMA.h 2 *" and no scaling
  // for all other passes.
  const match = /(?:LUMA|MAIN)\.(?:w|h)\s+(\d+(?:\.\d+)?)\s+\*/i.exec(line);
  return match ? Number(match[1]) : 1;
}

function buildFragment(pass: Omit<MpvPass, "fragment">): string {
  const uniforms = pass.binds
    .map(name => name === "LUMA"
      ? `uniform sampler2D u${name};`
      : `uniform sampler2D u${name};\nuniform vec2 u${name}Size;`)
    .join("\n");
  const defines = pass.binds
    .map(name => {
      if (name === "LUMA") {
        return [
          `#define LUMA_size uLUMASize`,
          `#define LUMA_pt (1.0 / uLUMASize)`,
          `#define LUMA_pos (gl_FragCoord.xy / uOutSize)`,
          `#define LUMA_tex(uv) dot(texture(uLUMA, uv).rgb, ${LUMA_WEIGHTS})`,
          `#define LUMA_texOff(off) LUMA_tex(LUMA_pos + vec2(off) * LUMA_pt)`,
        ].join("\n");
      }
      return [
        `#define ${name}_size u${name}Size`,
        `#define ${name}_pt (1.0 / u${name}Size)`,
        `#define ${name}_pos (gl_FragCoord.xy / uOutSize)`,
        `#define ${name}_tex(uv) texture(u${name}, uv)`,
        `#define ${name}_texOff(off) ${name}_tex(${name}_pos + vec2(off) * ${name}_pt)`,
      ].join("\n");
    })
    .join("\n");

  const body = pass.hook;
  const result = pass.components === 1
    ? "outColor = vec4(hook(), 0.0, 0.0, 1.0);"
    : "outColor = hook();";

  return `#version 300 es
precision highp float;
precision highp int;
${uniforms}
uniform vec2 uOutSize;
${pass.binds.includes("LUMA") ? "uniform vec2 uLUMASize;" : ""}
out vec4 outColor;

${defines}

${body}

void main() {
  ${result}
}`;
}

export function parseMpvShader(source: string): MpvPass[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const passes: MpvPass[] = [];
  let current: Omit<MpvPass, "fragment"> | null = null;
  let body: string[] = [];
  let inDirectives = false;

  const flush = () => {
    if (!current) return;
    const hook = body.join("\n");
    if (!/vec4\s+hook\s*\(\s*\)/.test(hook)) {
      throw new Error(`mpv pass "${current.desc}" has no vec4 hook()`);
    }
    passes.push({ ...current, hook, fragment: buildFragment({ ...current, hook: prepareMpvBodyForWebGL(hook) }) });
  };

  for (const line of lines) {
    if (line.startsWith("//!HOOK ")) {
      flush();
      const hook = line.slice("//!HOOK ".length).trim();
      current = { desc: hook, hook, binds: [], save: null, widthFactor: 1, heightFactor: 1, components: 4 };
      body = [];
      inDirectives = true;
      continue;
    }
    if (!current) continue;
    if (inDirectives && line.startsWith("//!")) {
      const directive = line.slice(3).trim();
      const [name, ...rest] = directive.split(/\s+/);
      const value = rest.join(" ").trim();
      if (name === "DESC") current.desc = value;
      else if (name === "BIND") current.binds.push(value);
      else if (name === "SAVE") current.save = value;
      else if (name === "WIDTH") current.widthFactor = parseSizeFactor(line);
      else if (name === "HEIGHT") current.heightFactor = parseSizeFactor(line);
      else if (name === "COMPONENTS") current.components = Number(value) === 1 ? 1 : 4;
      continue;
    }
    if (line.trim() === "") {
      if (inDirectives) continue;
    }
    if (inDirectives) {
      inDirectives = false;
    }
    body.push(line);
  }
  flush();
  if (!passes.length) throw new Error("No mpv passes found");
  return passes;
}

export function prepareMpvBodyForWebGL(body: string): string {
  // mpv accepts HLSL-style aliases; WebGL/GLSL ES uses mat4.
  return body
    .replace(/\bmat4x4\b/g, "mat4")
    .replace(/\btexOff\(0\)/g, "texOff(vec2(0.0, 0.0))");
}
