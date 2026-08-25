import {multiplyMat3, type Mat3} from "./geometry";

export type Quaternion = [number, number, number, number];
const rad = (n: number) => n * Math.PI / 180;

/** W3C DeviceOrientation intrinsic Z-X'-Y'' rotation plus display rotation. */
export function deviceOrientationMatrix(alpha: number, beta: number, gamma: number, screenAngle: number): Mat3 {
  const a = rad(alpha), b = rad(beta), g = rad(gamma), s = rad(-screenAngle);
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  const cg = Math.cos(g), sg = Math.sin(g), cs = Math.cos(s), ss = Math.sin(s);
  const rz: Mat3 = [ca, -sa, 0, sa, ca, 0, 0, 0, 1];
  const rx: Mat3 = [1, 0, 0, 0, cb, -sb, 0, sb, cb];
  const ry: Mat3 = [cg, 0, sg, 0, 1, 0, -sg, 0, cg];
  const display: Mat3 = [cs, -ss, 0, ss, cs, 0, 0, 0, 1];
  return multiplyMat3(multiplyMat3(multiplyMat3(rz, rx), ry), display);
}

export function mat3ToQuaternion(m: Mat3): Quaternion {
  const trace = m[0] + m[4] + m[8];
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2; w = s / 4; x = (m[7] - m[5]) / s; y = (m[2] - m[6]) / s; z = (m[3] - m[1]) / s;
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2; w = (m[7] - m[5]) / s; x = s / 4; y = (m[1] + m[3]) / s; z = (m[2] + m[6]) / s;
  } else if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2; w = (m[2] - m[6]) / s; x = (m[1] + m[3]) / s; y = s / 4; z = (m[5] + m[7]) / s;
  } else {
    const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2; w = (m[3] - m[1]) / s; x = (m[2] + m[6]) / s; y = (m[5] + m[7]) / s; z = s / 4;
  }
  const length = Math.hypot(x, y, z, w) || 1;
  return [x / length, y / length, z / length, w / length];
}

export function quaternionToMat3(q: Quaternion): Mat3 {
  const [x, y, z, w] = q;
  const xx=x*x, yy=y*y, zz=z*z, xy=x*y, xz=x*z, yz=y*z, wx=w*x, wy=w*y, wz=w*z;
  return [1-2*(yy+zz), 2*(xy-wz), 2*(xz+wy), 2*(xy+wz), 1-2*(xx+zz), 2*(yz-wx), 2*(xz-wy), 2*(yz+wx), 1-2*(xx+yy)];
}

export function slerpQuaternion(a: Quaternion, b: Quaternion, amount: number): Quaternion {
  let dot = a[0]*b[0] + a[1]*b[1] + a[2]*b[2] + a[3]*b[3];
  let target = b;
  if (dot < 0) {dot = -dot; target = [-b[0], -b[1], -b[2], -b[3]];}
  if (dot > 0.9995) {
    const q: Quaternion = [a[0]+(target[0]-a[0])*amount, a[1]+(target[1]-a[1])*amount, a[2]+(target[2]-a[2])*amount, a[3]+(target[3]-a[3])*amount];
    const length = Math.hypot(...q) || 1;
    return q.map(n => n / length) as Quaternion;
  }
  const theta = Math.acos(Math.min(1, dot));
  const sin = Math.sin(theta);
  const wa = Math.sin((1-amount)*theta)/sin, wb = Math.sin(amount*theta)/sin;
  return [a[0]*wa+target[0]*wb, a[1]*wa+target[1]*wb, a[2]*wa+target[2]*wb, a[3]*wa+target[3]*wb];
}
