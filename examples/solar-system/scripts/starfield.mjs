import { DEFAULT_DENSITY } from './constants.mjs';

let program;
let uniforms;

export async function setup({ readProjectFile }) {
  const bytes = await readProjectFile('assets/palette.json');
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function render({ gl, width, height, timeSeconds, params, state }) {
  if (!gl) throw new Error('WebGL2 is required');
  if (!program) {
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, `#version 300 es
      precision highp float;
      void main() {
        vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`);
    const fragment = compile(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      uniform vec2 uSize;
      uniform float uTime;
      uniform float uDensity;
      uniform float uBlue;
      out vec4 color;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main() {
        vec2 uv = gl_FragCoord.xy / uSize;
        vec2 cell = floor(uv * vec2(170.0, 96.0));
        float h = hash(cell);
        float star = step(1.0 - uDensity * 0.052, h);
        vec2 local = fract(uv * vec2(170.0, 96.0)) - 0.5;
        float glow = star * pow(max(0.0, 1.0 - length(local) * 2.0), 9.0);
        float twinkle = 0.72 + 0.28 * sin(uTime * 1.4 + h * 32.0);
        vec3 bg = mix(vec3(0.024, 0.045, 0.095), vec3(0.035, 0.075, 0.16), uv.y);
        vec3 tint = mix(vec3(1.0, 0.8, 0.62), vec3(0.65, 0.8, 1.0), uBlue);
        color = vec4(bg + glow * twinkle * tint, 1.0);
      }`);
    program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    uniforms = {
      size: gl.getUniformLocation(program, 'uSize'), time: gl.getUniformLocation(program, 'uTime'),
      density: gl.getUniformLocation(program, 'uDensity'), blue: gl.getUniformLocation(program, 'uBlue'),
    };
  }
  gl.useProgram(program);
  gl.uniform2f(uniforms.size, width, height);
  gl.uniform1f(uniforms.time, timeSeconds);
  gl.uniform1f(uniforms.density, Number(params.density ?? DEFAULT_DENSITY));
  gl.uniform1f(uniforms.blue, Number(params.blue ?? state.starTint[2]));
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}
