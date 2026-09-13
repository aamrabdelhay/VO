"use client";

import { useEffect, useRef } from "react";

export function GarvexOrb({ size = 220 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      depth: true,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
    });
    if (!gl) return;

    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Garvex orb shader allocation failed");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) || "Garvex orb shader compilation failed";
        gl.deleteShader(shader);
        throw new Error(log);
      }
      return shader;
    };

    const vs = compile(gl.VERTEX_SHADER, `#version 300 es
      precision highp float;
      layout(location=0) in vec3 aPosition;
      layout(location=1) in vec3 aNormal;
      uniform mat4 uModel;
      uniform mat4 uViewProj;
      out vec3 vNormal;
      out vec3 vWorld;
      void main(){
        vec4 world=uModel*vec4(aPosition,1.0);
        vWorld=world.xyz;
        vNormal=mat3(uModel)*aNormal;
        gl_Position=uViewProj*world;
      }
    `);

    const fs = compile(gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      in vec3 vNormal;
      in vec3 vWorld;
      out vec4 outColor;
      uniform float uTime;
      void main(){
        vec3 n=normalize(vNormal);
        vec3 viewDir=normalize(vec3(0.0,0.0,2.8)-vWorld);
        vec3 key=normalize(vec3(-0.55,0.85,1.25));
        vec3 fill=normalize(vec3(0.75,-0.3,0.45));
        float ndl=max(dot(n,key),0.0);
        float fillLight=max(dot(n,fill),0.0);
        float rim=pow(1.0-max(dot(n,viewDir),0.0),2.4);
        float latitude=abs(n.y);
        float longitude=atan(n.z,n.x);
        float sweep=0.5+0.5*cos(longitude*7.0-uTime*1.6+latitude*8.0);
        float bands=smoothstep(0.72,0.98,sweep)*0.18;
        vec3 base=vec3(0.025,0.12,0.34);
        vec3 electric=vec3(0.11,0.5,1.0);
        vec3 highlight=vec3(0.68,0.88,1.0);
        vec3 c=base*(0.35+1.05*ndl)+electric*(0.24*fillLight+0.82*rim+bands)+highlight*pow(max(ndl,0.0),9.0)*0.38;
        float edge=pow(max(dot(n,viewDir),0.0),0.2);
        float alpha=smoothstep(0.0,0.12,edge)+0.05;
        outColor=vec4(c,alpha);
      }
    `);

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return;
    }
    gl.useProgram(program);

    const latSegments = 40;
    const lonSegments = 64;
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    for (let y = 0; y <= latSegments; y += 1) {
      const v = y / latSegments;
      const theta = v * Math.PI;
      const sy = Math.cos(theta);
      const sr = Math.sin(theta);
      for (let x = 0; x <= lonSegments; x += 1) {
        const u = x / lonSegments;
        const phi = u * Math.PI * 2;
        const px = sr * Math.cos(phi);
        const pz = sr * Math.sin(phi);
        positions.push(px, sy, pz);
        normals.push(px, sy, pz);
      }
    }
    for (let y = 0; y < latSegments; y += 1) {
      for (let x = 0; x < lonSegments; x += 1) {
        const a = y * (lonSegments + 1) + x;
        const b = a + lonSegments + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }

    const vao = gl.createVertexArray();
    const pos = gl.createBuffer();
    const nor = gl.createBuffer();
    const idx = gl.createBuffer();
    if (!vao || !pos || !nor || !idx) return;

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, pos);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, nor);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(normals), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);

    const modelLoc = gl.getUniformLocation(program, "uModel");
    const vpLoc = gl.getUniformLocation(program, "uViewProj");
    const timeLoc = gl.getUniformLocation(program, "uTime");
    const projection = (fov: number, aspect: number, near: number, far: number) => {
      const f = 1 / Math.tan(fov / 2);
      return new Float32Array([
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) / (near - far), -1,
        0, 0, (2 * far * near) / (near - far), 0,
      ]);
    };
    const multiply = (a: Float32Array, b: Float32Array) => {
      const out = new Float32Array(16);
      for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      return out;
    };
    const rotateY = (angle: number) => {
      const c = Math.cos(angle), s = Math.sin(angle);
      return new Float32Array([c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]);
    };
    const rotateX = (angle: number) => {
      const c = Math.cos(angle), s = Math.sin(angle);
      return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);
    };
    const translate = (z: number) => new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,z,1]);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);
    let raf = 0;
    let alive = true;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(96, Math.floor(size * dpr));
      if (canvas.width !== w || canvas.height !== w) {
        canvas.width = w;
        canvas.height = w;
        gl.viewport(0, 0, w, w);
      }
    };
    const draw = (now: number) => {
      if (!alive) return;
      resize();
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const t = now / 1000;
      const model = multiply(rotateY(t * 0.55), rotateX(Math.sin(t * 0.35) * 0.16));
      const vp = multiply(projection(Math.PI / 3.1, 1, 0.1, 10), translate(-2.65));
      gl.uniformMatrix4fv(modelLoc, false, model);
      gl.uniformMatrix4fv(vpLoc, false, vp);
      gl.uniform1f(timeLoc, t);
      gl.bindVertexArray(vao);
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_INT, 0);
      raf = requestAnimationFrame(draw);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    raf = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.deleteBuffer(pos);
      gl.deleteBuffer(nor);
      gl.deleteBuffer(idx);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, [size]);

  return <canvas ref={canvasRef} width={size * 2} height={size * 2} style={{ width: size, height: size, display: "block", imageRendering: "auto" }} aria-hidden />;
}
