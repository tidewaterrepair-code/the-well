// One full-screen shader does the whole look: the sphere frame, the fake-3D
// parallax (the subject is a sphere, so its depth is plain maths, no depth map),
// flickering windows, the shaft's glow, stars, grain and vignette.
import type { View } from './types';

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;

const FRAG = `
precision highp float;
uniform sampler2D uA, uB;
uniform float uMix, uR, uAspect, uT, uLife, uShaft, uNight, uDim, uFlick;
uniform vec2 uRes, uC, uPtr;
uniform vec3 uS;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
}

void main(){
  vec2 px = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 q = (px - uC) / uR;                       // sphere space: |q| < 1 is on the sphere
  float d = length(q);
  float bulge = sqrt(max(0., 1. - d * d));       // how far this point sticks out toward the viewer
  vec2 qs = q - uPtr * (0.012 + 0.05 * bulge);   // nearer points slide more = depth
  vec2 fuv = uS.xy + qs * uS.z * vec2(1. / uAspect, 1.);

  vec3 col = vec3(0.);
  if (fuv.x > 0. && fuv.x < 1. && fuv.y > 0. && fuv.y < 1.) {
    col = mix(texture2D(uA, fuv).rgb, texture2D(uB, fuv).rgb, uMix);
    col *= 1. - smoothstep(1.04, 1.31, d);     // melt the frame's edges into space: no visible rectangle
  }
  float lum = dot(col, vec3(.299, .587, .114));
  float inside = smoothstep(1.1, .96, d);

  // Windows and lanterns: warm bright pixels. Each small patch flickers on its own clock.
  float warm = smoothstep(.05, .26, col.r - col.b) * smoothstep(.2, .55, lum) * inside;
  float cell = noise(fuv * vec2(46., 34.));
  float fl = 1. + uFlick * (.18 * sin(uT * (2. + cell * 6.) + cell * 40.)
                            - .3 * smoothstep(.97, 1., sin(uT * .5 + cell * 60.)));
  vec3 dead = mix(vec3(lum) * vec3(.5, .56, .68), col, .2) * .3;   // a window with the light gone out
  col = mix(col, mix(dead, col * fl * 1.2, smoothstep(0., 1., uLife)), warm);

  // The shaft: bright neutral pixels. uShaft rises during a drop countdown.
  float cool = smoothstep(.42, .8, lum) * (1. - smoothstep(.02, .14, abs(col.r - col.b))) * inside;
  col += col * cool * uShaft * (.45 + .55 * noise(vec2(fuv.x * 34., fuv.y * 9. + uT * .9)));

  // Stars in the empty space around the frame.
  vec2 sp = (px + uPtr * 5.) / uRes.y * 110.;
  float sh = hash(floor(sp));
  float star = step(.9925, sh) * smoothstep(.28, 0., length(fract(sp) - .5)) * (.55 + .45 * sin(uT * (.4 + sh * 2.) + sh * 50.));
  col += vec3(.75, .82, 1.) * star * .5 * (1. - inside) * (1. - smoothstep(0., .12, lum));

  vec2 vg = (px / uRes - .5) * vec2(1.05, 1.);
  col *= 1. - .62 * pow(length(vg) * 1.25, 2.4);
  col *= mix(vec3(1.), vec3(.66, .7, .82), uNight);
  col *= 1. - uDim;
  col += (hash(px + fract(uT) * 91.7) - .5) * .03;
  gl_FragColor = vec4(col, 1.);
}`;

export interface Renderer {
  resize(w: number, h: number, dpr: number): void;
  setFrames(a: TexImageSource, b: TexImageSource, ia: number, ib: number): void;
  draw(v: View, mix: number, sphere: { cx: number; cy: number; r: number }, aspect: number): void;
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader error');
    return s;
  };
  let prog: WebGLProgram;
  try {
    const hi = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    const frag = hi && hi.precision > 0 ? FRAG : FRAG.replace('precision highp float', 'precision mediump float');
    prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link error');
  } catch (err) {
    console.warn('WebGL shader failed, using the still fallback.', err);
    return null;
  }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const U: Record<string, WebGLUniformLocation | null> = {};
  for (const n of ['uA', 'uB', 'uMix', 'uR', 'uAspect', 'uT', 'uLife', 'uShaft', 'uNight', 'uDim', 'uFlick', 'uRes', 'uC', 'uPtr', 'uS']) U[n] = gl.getUniformLocation(prog, n);

  const tex = [0, 1].map((unit) => {
    const t = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]));
    return t;
  });
  gl.uniform1i(U.uA, 0);
  gl.uniform1i(U.uB, 1);
  const held = [-1, -1];
  let dpr = 1;
  let swap = false;

  const upload = (unit: number, src: TexImageSource, id: number) => {
    if (held[unit] === id) return;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex[unit]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
    held[unit] = id;
  };

  return {
    resize(w, h, d) {
      dpr = d;
      canvas.width = Math.round(w * d);
      canvas.height = Math.round(h * d);
      gl.viewport(0, 0, canvas.width, canvas.height);
    },
    setFrames(a, b, ia, ib) {
      // Rolling by one frame? Keep the texture a unit already holds and upload only the new one.
      // "swap" means unit 0 holds B and unit 1 holds A, so the mix is flipped when drawing.
      if (held[1] === ia && ia !== ib) { upload(0, b, ib); swap = true; return; }
      if (held[0] === ib && ia !== ib) { upload(1, a, ia); swap = true; return; }
      swap = false;
      upload(0, a, ia);
      upload(1, b, ib);
    },
    draw(v, mix, sphere, aspect) {
      gl.uniform1f(U.uMix, swap ? 1 - mix : mix);
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform2f(U.uC, v.cx * dpr, v.cy * dpr);
      gl.uniform1f(U.uR, v.R * dpr);
      gl.uniform3f(U.uS, sphere.cx, sphere.cy, sphere.r);
      gl.uniform1f(U.uAspect, aspect);
      gl.uniform2f(U.uPtr, v.px, v.py);
      gl.uniform1f(U.uT, v.t % 3600);
      gl.uniform1f(U.uLife, v.life);
      gl.uniform1f(U.uShaft, v.shaft);
      gl.uniform1f(U.uNight, v.night);
      gl.uniform1f(U.uDim, v.dim);
      gl.uniform1f(U.uFlick, v.flick);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  };
}
