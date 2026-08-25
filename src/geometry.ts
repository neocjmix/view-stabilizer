/** Row-major 3x3 matrix. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];
export type Point2 = {x: number; y: number};
export type Quad = [Point2, Point2, Point2, Point2];

export interface RectLike {left: number; top: number; width: number; height: number}
export interface ViewportLike {width: number; height: number}
export interface ViewerPose {x: number; y: number; z: number}

export interface CompensationInput {
  viewport: ViewportLike;
  element: RectLike;
  /** Relative device rotation, row-major, in device x-right/y-up/z-out coordinates. */
  rotation: Mat3;
  viewingDistance: number;
  viewerPose?: ViewerPose;
  physicalScreenWidth?: number;
  maxTilt: number;
  falloffDegrees?: number;
}

export interface CompensationResult {
  matrix: Mat3;
  cssMatrix3d: string;
  projectedScreen: Quad;
  targetQuad: Quad;
  tilt: number;
  effectiveTilt: number;
  strength: number;
  fallback: boolean;
}

export const IDENTITY_3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const EPS = 1e-9;
const finite = (values: readonly number[]) => values.every(Number.isFinite);
const rad = (degrees: number) => degrees * Math.PI / 180;
const deg = (radians: number) => radians * 180 / Math.PI;
const clamp = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / Math.max(EPS, b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function multiplyMat3(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      for (let k = 0; k < 3; k++) out[row * 3 + col]! += a[row * 3 + k]! * b[k * 3 + col]!;
    }
  }
  return out as Mat3;
}

export function transposeMat3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function determinantMat3(m: Mat3): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

export function invertMat3(m: Mat3): Mat3 | null {
  const d = determinantMat3(m);
  if (!Number.isFinite(d) || Math.abs(d) < EPS) return null;
  const inv: Mat3 = [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ].map(value => value / d) as Mat3;
  return finite(inv) ? inv : null;
}

export function applyHomography(h: Mat3, point: Point2): Point2 | null {
  const w = h[6] * point.x + h[7] * point.y + h[8];
  if (!Number.isFinite(w) || Math.abs(w) < EPS) return null;
  const result = {x: (h[0] * point.x + h[1] * point.y + h[2]) / w, y: (h[3] * point.x + h[4] * point.y + h[5]) / w};
  return Number.isFinite(result.x) && Number.isFinite(result.y) ? result : null;
}

/** Fits the projective map source -> destination with h[8] fixed to 1. */
export function homographyFromQuads(source: Quad, destination: Quad): Mat3 | null {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = source[i]!, d = destination[i]!;
    if (!finite([s.x, s.y, d.x, d.y])) return null;
    a.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y]); b.push(d.x);
    a.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y]); b.push(d.y);
  }
  const solution = solveLinear(a, b);
  if (!solution) return null;
  const h = [...solution, 1] as Mat3;
  const det = determinantMat3(h);
  return finite(h) && Number.isFinite(det) && Math.abs(det) > 1e-8 ? h : null;
}

function solveLinear(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  const a = matrix.map((row, i) => [...row, vector[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    if (Math.abs(a[pivot]![col]!) < EPS) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];
    const divisor = a[col]![col]!;
    for (let k = col; k <= n; k++) a[col]![k]! /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row]![col]!;
      for (let k = col; k <= n; k++) a[row]![k]! -= factor * a[col]![k]!;
    }
  }
  const result = a.map(row => row[n]!);
  return finite(result) ? result : null;
}

/** CSS matrix3d embedding for a 2D homography, with transform-origin: 0 0. */
export function homographyToCssMatrix3d(h: Mat3): string {
  const scale = Math.abs(h[8]) > EPS ? h[8] : 1;
  const n = h.map(value => Math.abs(value / scale) < 1e-12 ? 0 : value / scale) as Mat3;
  const values = [
    n[0], n[3], 0, n[6],
    n[1], n[4], 0, n[7],
    0, 0, 1, 0,
    n[2], n[5], 0, 1,
  ];
  return `matrix3d(${values.map(value => Number(value.toFixed(10))).join(",")})`;
}

export function rotationFromEuler(pitchDegrees: number, yawDegrees: number, rollDegrees: number): Mat3 {
  const x = rad(pitchDegrees), y = rad(yawDegrees), z = rad(rollDegrees);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  const rx: Mat3 = [1, 0, 0, 0, cx, -sx, 0, sx, cx];
  const ry: Mat3 = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rz: Mat3 = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  return multiplyMat3(rz, multiplyMat3(ry, rx));
}

/** Returns a rotation with the same axis and an angle no larger than maxDegrees. */
export function clampRotation(rotation: Mat3, maxDegrees: number): {rotation: Mat3; angle: number; effectiveAngle: number} {
  const cosAngle = clamp((rotation[0] + rotation[4] + rotation[8] - 1) / 2, -1, 1);
  const angle = Math.acos(cosAngle);
  const limit = rad(Math.max(0, maxDegrees));
  if (angle < 1e-7 || angle <= limit) return {rotation: [...rotation] as Mat3, angle: deg(angle), effectiveAngle: deg(angle)};
  const axisScale = 1 / (2 * Math.sin(angle));
  let x = (rotation[7] - rotation[5]) * axisScale;
  let y = (rotation[2] - rotation[6]) * axisScale;
  let z = (rotation[3] - rotation[1]) * axisScale;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length < EPS) return {rotation: IDENTITY_3, angle: deg(angle), effectiveAngle: 0};
  x /= length; y /= length; z /= length;
  const c = Math.cos(limit), s = Math.sin(limit), t = 1 - c;
  return {rotation: [
    t*x*x+c, t*x*y-s*z, t*x*z+s*y,
    t*x*y+s*z, t*y*y+c, t*y*z-s*x,
    t*x*z-s*y, t*y*z+s*x, t*z*z+c,
  ], angle: deg(angle), effectiveAngle: maxDegrees};
}

function identityResult(input: CompensationInput, tilt = 0, effectiveTilt = 0, strength = 0): CompensationResult {
  const v = input.viewport;
  const projected: Quad = [{x: 0, y: 0}, {x: v.width, y: 0}, {x: v.width, y: v.height}, {x: 0, y: v.height}];
  const e = input.element;
  const target: Quad = [{x: 0, y: 0}, {x: e.width, y: 0}, {x: e.width, y: e.height}, {x: 0, y: e.height}];
  return {matrix: IDENTITY_3, cssMatrix3d: homographyToCssMatrix3d(IDENTITY_3), projectedScreen: projected, targetQuad: target, tilt, effectiveTilt, strength, fallback: true};
}

export function computeCompensation(input: CompensationInput): CompensationResult {
  const {viewport: v, element: e} = input;
  if (!finite([...input.rotation, v.width, v.height, e.left, e.top, e.width, e.height, input.viewingDistance, input.maxTilt]) ||
      v.width <= 0 || v.height <= 0 || e.width <= 0 || e.height <= 0 || input.viewingDistance <= 0 || input.maxTilt <= 0) return identityResult(input);

  // maxTilt is the angle between the screen normal and the calibrated normal.
  // Roll does not foreshorten the screen and must not trigger the safety falloff.
  const rawTilt = deg(Math.acos(clamp(input.rotation[8], -1, 1)));
  const totalAngle = clampRotation(input.rotation, 180).angle;
  const limitedRotation = rawTilt > input.maxTilt && rawTilt > EPS
    ? clampRotation(input.rotation, totalAngle * input.maxTilt / rawTilt).rotation
    : input.rotation;
  const effectiveTilt = Math.min(rawTilt, input.maxTilt);
  const falloff = Math.max(1, input.falloffDegrees ?? 15);
  const strength = 1 - smoothstep(input.maxTilt, input.maxTilt + falloff, rawTilt);
  if (strength <= 0.001) return identityResult(input, rawTilt, effectiveTilt, 0);

  const screenWidthMm = input.physicalScreenWidth ?? 70;
  const portraitCssWidth = Math.min(v.width, v.height);
  const mmPerCssPixel = screenWidthMm / portraitCssWidth;
  const cx = v.width / 2, cy = v.height / 2;
  const eye = input.viewerPose ?? {x: 0, y: 0, z: input.viewingDistance};
  const d = eye.z;
  if (!finite([eye.x, eye.y, eye.z]) || d <= 0) return identityResult(input);
  const r = limitedRotation;
  const project = (p: Point2): Point2 | null => {
    const x = (p.x - cx) * mmPerCssPixel;
    const yUp = -(p.y - cy) * mmPerCssPixel;
    const qx = r[0] * x + r[1] * yUp;
    const qy = r[3] * x + r[4] * yUp;
    const qz = r[6] * x + r[7] * yUp;
    const denominator = d - qz;
    if (!Number.isFinite(denominator) || denominator < d * 0.04) return null;
    const visualX = eye.x + (qx - eye.x) * d / denominator;
    const visualY = eye.y + (qy - eye.y) * d / denominator;
    return {x: cx + visualX / mmPerCssPixel, y: cy - visualY / mmPerCssPixel};
  };
  const screen: Quad = [{x: 0, y: 0}, {x: v.width, y: 0}, {x: v.width, y: v.height}, {x: 0, y: v.height}];
  const projectedValues = screen.map(project);
  if (projectedValues.some(point => point === null)) return identityResult(input, rawTilt, effectiveTilt, strength);
  const projected = projectedValues as Quad;
  const visualMap = homographyFromQuads(screen, projected);
  const inverseVisual = visualMap ? invertMat3(visualMap) : null;
  if (!inverseVisual) return identityResult(input, rawTilt, effectiveTilt, strength);

  const desiredViewport: Quad = [
    {x: e.left, y: e.top}, {x: e.left + e.width, y: e.top},
    {x: e.left + e.width, y: e.top + e.height}, {x: e.left, y: e.top + e.height},
  ];
  const compensatedViewport = desiredViewport.map(point => applyHomography(inverseVisual, point));
  if (compensatedViewport.some(point => point === null)) return identityResult(input, rawTilt, effectiveTilt, strength);
  const maxCoordinate = Math.max(v.width, v.height) * 8;
  if ((compensatedViewport as Point2[]).some(point => Math.abs(point.x - cx) > maxCoordinate || Math.abs(point.y - cy) > maxCoordinate)) return identityResult(input, rawTilt, effectiveTilt, strength);

  const sourceLocal: Quad = [{x: 0, y: 0}, {x: e.width, y: 0}, {x: e.width, y: e.height}, {x: 0, y: e.height}];
  const targetLocal = (compensatedViewport as Quad).map((point, index) => ({
    x: mix(sourceLocal[index]!.x, point.x - e.left, strength),
    y: mix(sourceLocal[index]!.y, point.y - e.top, strength),
  })) as Quad;
  const localMap = homographyFromQuads(sourceLocal, targetLocal);
  if (!localMap || !finite(localMap) || Math.abs(determinantMat3(localMap)) < 1e-7) return identityResult(input, rawTilt, effectiveTilt, strength);
  return {
    matrix: localMap,
    cssMatrix3d: homographyToCssMatrix3d(localMap),
    projectedScreen: projected,
    targetQuad: targetLocal,
    tilt: rawTilt,
    effectiveTilt,
    strength,
    fallback: false,
  };
}
