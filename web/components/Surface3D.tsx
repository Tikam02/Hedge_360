'use client';
// Strike × expiry view of the option chain in three.js: open interest as paired bars (calls blue, puts orange) or the
// IV smile per expiry as a surface. Drag to turn it. The 2D chart and the chain table on the same page show the same
// numbers, so nothing here is the only place to read a value. Renders on demand (no animation loop).
import { useEffect, useRef, useState } from 'react';
import type * as T from 'three';
import { contracts, expShort, type SurfaceResp } from '@/lib/derivs';
import { fmt } from '@/lib/util';
import { CALL, PUT } from './charts';

export type SurfaceMode = 'oi' | 'iv';
// Sequential single hue for IV height: light (low) to dark (high).
const IV_LO = '#d3e4f8', IV_HI = '#1b4f9c';
const D = 5, H = 3.4;

type Tip = { x: number; y: number; title: string; lines: string[] } | null;

export default function Surface3D({ data, mode, range, height = 380 }: {
  data: SurfaceResp; mode: SurfaceMode; range: [number, number]; height?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [tip, setTip] = useState<Tip>(null);
  const [lo, hi] = range;

  const cols = data.strikes.map((k, i) => [k, i] as const).filter(([k]) => k >= lo && k <= hi);
  const ivs = data.iv.flatMap((row) => cols.map(([, i]) => row[i])).filter((v): v is number => v != null);
  const ivMin = ivs.length ? Math.min(...ivs) : 0, ivMax = ivs.length ? Math.max(...ivs) : 1;

  useEffect(() => {
    let dead = false;
    let cleanup = () => {};
    (async () => {
      const THREE = await import('three');
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
      const { CSS2DRenderer, CSS2DObject } = await import('three/examples/jsm/renderers/CSS2DRenderer.js');
      const el = host.current;
      if (dead || !el || !cols.length) return;
      let renderer: T.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      } catch {
        setFailed(true);
        return;
      }
      setFailed(false);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      el.appendChild(renderer.domElement);
      const labels = new CSS2DRenderer();
      labels.domElement.className = 's3-labels';
      el.appendChild(labels.domElement);

      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 1.9));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(4, 10, 7);
      scene.add(sun);
      const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
      // Starting aim; size() re-centres it so the scene and its labels fit the canvas.
      const target = new THREE.Vector3(0, 0.8, 0);

      // Floor width follows the card's shape, so a wide card isn't mostly empty and a phone still fits the labels.
      const W = Math.min(16, Math.max(9, (el.clientWidth / Math.max(1, el.clientHeight)) * 3.6));
      const nk = cols.length, E = data.expiries;
      const narrow = el.clientWidth < 520;
      const xAt = (i: number) => -W / 2 + ((i + 0.5) * W) / nk;
      const dtes = E.map((e) => e.dte), dMin = Math.min(...dtes), dMax = Math.max(...dtes);
      // Nearest expiry at the front, spaced by days to expiry so the term structure keeps its real proportions.
      const zAt = (j: number) => (E.length > 1 ? D / 2 - ((dtes[j] - dMin) / (dMax - dMin || 1)) * D : 0);
      const label = (text: string, x: number, y: number, z: number, cls = '') => {
        // CSS2DRenderer centres the outer element on the point; the inner span carries any offset.
        const div = document.createElement('div');
        div.className = `s3-lab ${cls}`;
        const span = document.createElement('span');
        span.textContent = text;
        div.appendChild(span);
        const o = new CSS2DObject(div);
        o.position.set(x, y, z);
        scene.add(o);
        return o;
      };
      const line = (pts: number[][], color: string, opacity = 1, dashed = false) => {
        const g = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
        const mat = dashed
          ? new THREE.LineDashedMaterial({ color, dashSize: 0.18, gapSize: 0.12, transparent: opacity < 1, opacity })
          : new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity });
        const l = new THREE.Line(g, mat);
        if (dashed) l.computeLineDistances();
        scene.add(l);
        return l;
      };

      // Floor: one hairline per expiry, the outline, and the spot price.
      const front = D / 2 + 0.35, back = -D / 2 - 0.35;
      line([[-W / 2, 0, front], [W / 2, 0, front], [W / 2, 0, back], [-W / 2, 0, back], [-W / 2, 0, front]], '#C8D3E0');
      E.forEach((e, j) => {
        line([[-W / 2, 0, zAt(j)], [W / 2, 0, zAt(j)]], '#DCE3EC');
        label(narrow ? expShort(e.expiry) : `${expShort(e.expiry)} · ${e.dte}d`, W / 2 + 0.25, 0, zAt(j), 's3-exp');
      });
      const spotI = cols.findIndex(([k], i) => i < nk - 1 && k <= data.spot && cols[i + 1][0] > data.spot);
      if (spotI >= 0) {
        const xs = xAt(spotI) + ((data.spot - cols[spotI][0]) / (cols[spotI + 1][0] - cols[spotI][0])) * (W / nk);
        line([[xs, 0.01, front], [xs, 0.01, back]], '#172536', 0.85, true);
        label(`Spot ${fmt(data.spot)}`, xs, 0, back - 0.15, 's3-spot');
      }
      const every = Math.max(1, Math.ceil(nk / (narrow ? 4 : 8)));
      const atm = cols.reduce((b, [k], i) => (Math.abs(k - data.spot) < Math.abs(cols[b][0] - data.spot) ? i : b), 0);
      cols.forEach(([k], i) => { if ((i - atm) % every === 0) label(fmt(k, 0), xAt(i), 0, front + 0.05, 's3-k'); });
      // Value axis on the back-right corner, where both views are lowest, so its labels don't sit over the data.
      line([[W / 2, 0, back], [W / 2, H, back]], '#C8D3E0');

      const hit: T.Object3D[] = [];
      let pick: (o: T.Intersection) => Tip = () => null;
      let restore = () => {};

      if (mode === 'oi') {
        const val = (grid: Array<Array<number | null>>, j: number, i: number) => grid[j][cols[i][1]] ?? 0;
        const max = Math.max(1, ...E.flatMap((_, j) => cols.flatMap((_, i) => [val(data.callOi, j, i), val(data.putOi, j, i)])));
        const bw = (W / nk) * 0.36, bd = Math.min(0.42, (D / Math.max(1, E.length)) * 0.4);
        const geo = new THREE.BoxGeometry(bw, 1, bd).translate(0, 0.5, 0);
        const m4 = new THREE.Matrix4();
        ([['CE', data.callOi, CALL, -0.55], ['PE', data.putOi, PUT, 0.55]] as const).map(([side, grid, color, off]) => {
          // White material: the per-instance colour carries the hue (instance colour multiplies the material colour).
          const mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color: 0xffffff }), E.length * nk);
          E.forEach((_, j) => cols.forEach((_, i) => {
            const v = val(grid, j, i);
            m4.makeScale(1, Math.max(0.002, (v / max) * H), 1).setPosition(xAt(i) + off * bw, 0, zAt(j));
            mesh.setMatrixAt(j * nk + i, m4);
            mesh.setColorAt(j * nk + i, new THREE.Color(color));
          }));
          mesh.userData = { side, grid, color };
          scene.add(mesh);
          hit.push(mesh);
        });
        [0.5, 1].forEach((f) => label(contracts(max * f), W / 2 + 0.15, H * f, back, 's3-y'));
        label('OI, contracts', W / 2, H + 0.45, back, 's3-y s3-title');
        pick = (o) => {
          const mesh = o.object as T.InstancedMesh;
          const id = o.instanceId ?? -1;
          if (id < 0) return null;
          const j = Math.floor(id / nk), i = id % nk;
          const { side, grid, color } = mesh.userData as { side: string; grid: Array<Array<number | null>>; color: string };
          mesh.setColorAt(id, new THREE.Color(color).multiplyScalar(0.62));
          mesh.instanceColor!.needsUpdate = true;
          restore = () => { mesh.setColorAt(id, new THREE.Color(color)); mesh.instanceColor!.needsUpdate = true; };
          return { x: 0, y: 0, title: `${fmt(cols[i][0], 0)} ${side} · ${expShort(E[j].expiry)}`, lines: [`OI ${fmt(val(grid, j, i), 0)} contracts`] };
        };
      } else {
        const lo3 = new THREE.Color(IV_LO), hi3 = new THREE.Color(IV_HI);
        const yOf = (v: number) => 0.15 + ((v - ivMin) / (ivMax - ivMin || 1)) * H * 0.92;
        const pos: number[] = [], color: number[] = [], index: number[] = [];
        const at = (j: number, i: number) => data.iv[j][cols[i][1]];
        E.forEach((_, j) => cols.forEach((_, i) => {
          const v = at(j, i) ?? ivMin;
          pos.push(xAt(i), yOf(v), zAt(j));
          const c = lo3.clone().lerp(hi3, (v - ivMin) / (ivMax - ivMin || 1));
          color.push(c.r, c.g, c.b);
        }));
        for (let j = 0; j < E.length - 1; j++) for (let i = 0; i < nk - 1; i++) {
          if ([at(j, i), at(j, i + 1), at(j + 1, i), at(j + 1, i + 1)].some((v) => v == null)) continue;
          const a = j * nk + i, b = a + 1, c = a + nk, d = c + 1;
          index.push(a, c, b, b, c, d);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
        geo.setIndex(index);
        geo.computeVertexNormals();
        const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.94 }));
        scene.add(mesh);
        hit.push(mesh);
        // A ridge line per expiry makes each smile readable on its own.
        E.forEach((_, j) => line(cols.map((_, i) => [xAt(i), yOf(at(j, i) ?? ivMin) + 0.01, zAt(j)]), '#172536', 0.55));
        [ivMin, (ivMin + ivMax) / 2, ivMax].forEach((v) => label(`${fmt(v, 1)}%`, W / 2 + 0.15, yOf(v), back, 's3-y'));
        label('IV %', W / 2, H + 0.45, back, 's3-y s3-title');
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), new THREE.MeshBasicMaterial({ color: '#172536' }));
        dot.visible = false;
        scene.add(dot);
        pick = (o) => {
          const i = Math.min(nk - 1, Math.max(0, Math.round(((o.point.x + W / 2) * nk) / W - 0.5)));
          const j = E.reduce((b, _, jj) => (Math.abs(zAt(jj) - o.point.z) < Math.abs(zAt(b) - o.point.z) ? jj : b), 0);
          const v = at(j, i);
          if (v == null) return null;
          dot.position.set(xAt(i), yOf(v), zAt(j));
          dot.visible = true;
          restore = () => { dot.visible = false; };
          return { x: 0, y: 0, title: `${fmt(cols[i][0], 0)} · ${expShort(E[j].expiry)}`, lines: [`IV ${fmt(v, 2)}% (${cols[i][0] < data.spot ? 'put' : 'call'} side)`] };
        };
      }

      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.copy(target);
      controls.enableZoom = false;
      controls.enablePan = false;
      controls.minPolarAngle = 0.35;
      controls.maxPolarAngle = 1.38;
      // Let vertical swipes scroll the page on touch screens; horizontal drags still turn the view.
      renderer.domElement.style.touchAction = 'pan-y';

      const render = () => { renderer.render(scene, camera); labels.render(scene, camera); };
      // Phones start more from above and in front, which makes the wide floor taller on a narrow canvas.
      const dir = (narrow ? new THREE.Vector3(0.22, 0.9, 1) : new THREE.Vector3(0.42, 0.62, 1)).normalize();
      camera.position.copy(target).add(dir.clone().multiplyScalar(14));
      const box = [-W / 2, W / 2].flatMap((x) => [0, H].flatMap((y) => [front, back].map((z) => new THREE.Vector3(x, y, z))));
      const size = () => {
        const w = el.clientWidth, h = el.clientHeight;
        // A zero-size pass (hidden or mid-layout) would give an infinite camera distance that never recovers.
        if (!w || !h) return;
        renderer.setSize(w, h);
        labels.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        // Fit the floor-and-bars box inside the canvas, less room for the labels that hang off it: project its
        // corners, then re-centre and rescale a few times (perspective makes one pass inexact).
        const m = { l: 14, r: Math.min(118, w * 0.3), t: 34, b: 30 };
        const L = -1 + (2 * m.l) / w, R = 1 - (2 * m.r) / w, B = -1 + (2 * m.b) / h, Tp = 1 - (2 * m.t) / h;
        const cur = camera.position.clone().sub(controls.target);
        const d0 = Number.isFinite(cur.lengthSq()) && cur.lengthSq() > 0 ? cur.normalize() : dir.clone();
        const aim = target.clone();
        let dist = 16;
        for (let k = 0; k < 4; k++) {
          camera.position.copy(aim).addScaledVector(d0, dist);
          camera.lookAt(aim);
          camera.updateMatrixWorld();
          let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
          for (const p of box) {
            const v = p.clone().project(camera);
            x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
          }
          const halfH = Math.tan((camera.fov * Math.PI) / 360) * dist, halfW = halfH * camera.aspect;
          aim.addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), ((x0 + x1 - (L + R)) / 2) * halfW)
            .addScaledVector(new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1), ((y0 + y1 - (B + Tp)) / 2) * halfH);
          dist *= Math.max((x1 - x0) / (R - L), (y1 - y0) / (Tp - B));
        }
        camera.position.copy(aim).addScaledVector(d0, dist);
        controls.target.copy(aim);
        controls.update();
        render();
      };
      controls.addEventListener('change', render);
      const ro = new ResizeObserver(size);
      ro.observe(el);
      size();

      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      const move = (e: PointerEvent) => {
        const r = renderer.domElement.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
        const [o] = ray.intersectObjects(hit, false);
        restore();
        restore = () => {};
        const t = o ? pick(o) : null;
        setTip(t && { ...t, x: e.clientX - r.left, y: e.clientY - r.top });
        render();
      };
      const leave = () => { restore(); restore = () => {}; setTip(null); render(); };
      renderer.domElement.addEventListener('pointermove', move);
      renderer.domElement.addEventListener('pointerleave', leave);

      cleanup = () => {
        ro.disconnect();
        renderer.domElement.removeEventListener('pointermove', move);
        renderer.domElement.removeEventListener('pointerleave', leave);
        controls.dispose();
        scene.traverse((o) => {
          const m = o as T.Mesh;
          m.geometry?.dispose();
          (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []).forEach((x) => x.dispose());
        });
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
        labels.domElement.remove();
      };
    })();
    return () => { dead = true; cleanup(); };
    // cols/ivMin/ivMax derive from data and range, which are the real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, mode, lo, hi]);

  if (failed) {
    return <div className="s3-fail" style={{ height }}>The 3D view needs WebGL, which is turned off in this browser. The chart above and the table below show the same numbers.</div>;
  }
  return (
    <div className="s3" style={{ height }}>
      <div className="s3-host" ref={host} />
      <div className="s3-key" aria-hidden="true">
        {mode === 'oi'
          ? <><span><i style={{ background: CALL }} />Calls</span><span><i style={{ background: PUT }} />Puts</span></>
          : <span className="s3-ramp"><em>{fmt(ivMin, 1)}%</em><i style={{ background: `linear-gradient(90deg, ${IV_LO}, ${IV_HI})` }} /><em>{fmt(ivMax, 1)}%</em></span>}
      </div>
      {tip && (
        <div className={`ch-tip${tip.y < 70 ? ' below' : ''}`} style={{ left: tip.x, top: tip.y - 12 }}>
          <b>{tip.title}</b>{tip.lines.map((l) => <span key={l}>{l}</span>)}
        </div>
      )}
    </div>
  );
}
