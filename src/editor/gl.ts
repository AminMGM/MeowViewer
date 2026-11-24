/** WebGL adjustment pass: every slider in one fragment shader, so previews are instant and the
 *  full-resolution export runs on the GPU too. */

export interface Adjust {
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  temperature: number
  tint: number
  vibrance: number
  saturation: number
  sharpen: number
  clarity: number
  vignette: number
  grain: number
  fade: number
}

export const ZERO: Adjust = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temperature: 0, tint: 0,
  vibrance: 0, saturation: 0, sharpen: 0, clarity: 0, vignette: 0, grain: 0, fade: 0,
}

export interface Look {
  gray?: number
  sepia?: number
  adj?: Partial<Adjust>
}

const VS = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

const FS = `
precision highp float;
uniform sampler2D u_img;
uniform vec2 u_px;
uniform float u_exp, u_con, u_hi, u_sh, u_wh, u_bl, u_temp, u_tint, u_vib, u_sat;
uniform float u_sharp, u_clar, u_vig, u_grain, u_fade, u_gray, u_sepia, u_seed;
varying vec2 v_uv;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 tex(vec2 o) { return texture2D(u_img, v_uv + o).rgb; }
void main() {
  vec3 c = tex(vec2(0.0));
  if (u_sharp > 0.0) {
    vec3 n = tex(vec2(0.0, u_px.y)) + tex(vec2(0.0, -u_px.y)) + tex(vec2(u_px.x, 0.0)) + tex(vec2(-u_px.x, 0.0));
    c += u_sharp * (c - n * 0.25) * 2.0;
  }
  if (u_clar != 0.0) {
    vec2 r = u_px * 8.0;
    vec3 b = (tex(vec2(0.0, r.y)) + tex(vec2(0.0, -r.y)) + tex(vec2(r.x, 0.0)) + tex(vec2(-r.x, 0.0)) +
              tex(r) + tex(-r) + tex(vec2(r.x, -r.y)) + tex(vec2(-r.x, r.y))) * 0.125;
    float m = 1.0 - abs(luma(c) * 2.0 - 1.0);
    c += u_clar * (c - b) * m;
  }
  c *= pow(2.0, u_exp);
  c.r *= 1.0 + u_temp * 0.18;
  c.b *= 1.0 - u_temp * 0.18;
  c.g *= 1.0 - u_tint * 0.12;
  float l = luma(c);
  c += u_sh * 0.45 * (1.0 - smoothstep(0.0, 0.55, l)) * (0.15 + c);
  c += u_hi * 0.35 * smoothstep(0.45, 1.0, l);
  c += u_wh * 0.22 * smoothstep(0.65, 1.0, l);
  c += u_bl * 0.14 * (1.0 - smoothstep(0.0, 0.35, l));
  c = (c - 0.5) * (1.0 + u_con) + 0.5;
  l = luma(c);
  c = mix(vec3(l), c, 1.0 + u_sat);
  float s = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  c = mix(vec3(l), c, 1.0 + u_vib * (1.0 - clamp(s, 0.0, 1.0)));
  c = mix(c, vec3(luma(c)), u_gray);
  vec3 sep = vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));
  c = mix(c, sep, u_sepia);
  c = c * (1.0 - u_fade * 0.22) + u_fade * 0.1;
  vec2 d = v_uv - 0.5;
  c *= mix(1.0, smoothstep(0.85, 0.25, length(d) * 1.15), u_vig);
  float g = fract(sin(dot(v_uv * (1.0 + u_seed), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  c += g * u_grain * 0.16;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`

export class GlPass {
  canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext
  private prog: WebGLProgram
  private tex: WebGLTexture
  private loc: Record<string, WebGLUniformLocation | null> = {}
  readonly maxSize: number

  constructor() {
    this.canvas = document.createElement('canvas')
    const gl = this.canvas.getContext('webgl', { preserveDrawingBuffer: true, premultipliedAlpha: false })
    if (!gl) throw new Error('WebGL unavailable')
    this.gl = gl
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader')
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS))
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FS))
    gl.linkProgram(p)
    gl.useProgram(p)
    this.prog = p
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    const a = gl.getAttribLocation(p, 'a_pos')
    gl.enableVertexAttribArray(a)
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0)
    this.tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    for (const n of ['u_px', 'u_exp', 'u_con', 'u_hi', 'u_sh', 'u_wh', 'u_bl', 'u_temp', 'u_tint', 'u_vib', 'u_sat', 'u_sharp', 'u_clar', 'u_vig', 'u_grain', 'u_fade', 'u_gray', 'u_sepia', 'u_seed'])
      this.loc[n] = gl.getUniformLocation(p, n)
  }

  /** Uploads `src` (a canvas) as the input texture. */
  upload(src: HTMLCanvasElement) {
    const gl = this.gl
    this.canvas.width = src.width
    this.canvas.height = src.height
    gl.viewport(0, 0, src.width, src.height)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src)
  }

  draw(adj: Adjust, look: Look) {
    const gl = this.gl
    const a = { ...ZERO }
    for (const k of Object.keys(ZERO) as (keyof Adjust)[]) a[k] = adj[k] + (look.adj?.[k] ?? 0)
    const u = (n: string, v: number) => gl.uniform1f(this.loc[n], v)
    gl.useProgram(this.prog)
    gl.uniform2f(this.loc.u_px, 1 / this.canvas.width, 1 / this.canvas.height)
    u('u_exp', (a.exposure / 100) * 2)
    u('u_con', (a.contrast / 100) * 0.6)
    u('u_hi', a.highlights / 100)
    u('u_sh', a.shadows / 100)
    u('u_wh', a.whites / 100)
    u('u_bl', a.blacks / 100)
    u('u_temp', a.temperature / 100)
    u('u_tint', a.tint / 100)
    u('u_vib', a.vibrance / 100)
    u('u_sat', a.saturation / 100)
    u('u_sharp', (a.sharpen / 100) * 1.5)
    u('u_clar', (a.clarity / 100) * 1.5)
    u('u_vig', a.vignette / 100)
    u('u_grain', a.grain / 100)
    u('u_fade', a.fade / 100)
    u('u_gray', look.gray ?? 0)
    u('u_sepia', look.sepia ?? 0)
    u('u_seed', 1.37)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  dispose() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
