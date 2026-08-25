import {describe, expect, it} from "vitest";
import {
  applyHomography, computeCompensation, homographyFromQuads, homographyToCssMatrix3d,
  IDENTITY_3, rotationFromEuler, type CompensationInput, type Mat3, type Point2,
} from "../src/geometry";

const base = (rotation: Mat3, overrides: Partial<CompensationInput> = {}): CompensationInput => ({
  viewport: {width: 390, height: 844},
  element: {left: 75, top: 322, width: 240, height: 160},
  rotation,
  viewingDistance: 400,
  physicalScreenWidth: 70,
  maxTilt: 65,
  ...overrides,
});

const horizontalSpan = (matrix: Mat3, width = 240, height = 160) => {
  const a = applyHomography(matrix, {x: 0, y: height / 2})!;
  const b = applyHomography(matrix, {x: width, y: height / 2})!;
  return Math.hypot(b.x - a.x, b.y - a.y);
};
const verticalSpan = (matrix: Mat3, width = 240, height = 160) => {
  const a = applyHomography(matrix, {x: width / 2, y: 0})!;
  const b = applyHomography(matrix, {x: width / 2, y: height})!;
  return Math.hypot(b.x - a.x, b.y - a.y);
};

describe("projective compensation", () => {
  it("is identity for identity relative rotation", () => {
    const result = computeCompensation(base(IDENTITY_3));
    expect(result.fallback).toBe(false);
    result.matrix.forEach((value, index) => expect(value).toBeCloseTo(IDENTITY_3[index]!, 8));
  });

  it("increases horizontal compensation for Y rotation", () => {
    const result = computeCompensation(base(rotationFromEuler(0, 30, 0)));
    expect(result.fallback).toBe(false);
    expect(horizontalSpan(result.matrix)).toBeGreaterThan(240 * 1.1);
    // Perspective, not scale-only: the two vertical edges do not remain equal.
    const q = result.targetQuad;
    expect(Math.abs((q[3].y-q[0].y) - (q[2].y-q[1].y))).toBeGreaterThan(0.2);
  });

  it("requires much more X expansion at 60° than 30°", () => {
    const at30 = computeCompensation(base(rotationFromEuler(0, 30, 0)));
    const at60 = computeCompensation(base(rotationFromEuler(0, 60, 0)));
    expect(horizontalSpan(at60.matrix)).toBeGreaterThan(horizontalSpan(at30.matrix) * 1.45);
  });

  it("compensates vertical foreshortening for X rotation", () => {
    const result = computeCompensation(base(rotationFromEuler(35, 0, 0)));
    expect(result.fallback).toBe(false);
    expect(verticalSpan(result.matrix)).toBeGreaterThan(160 * 1.15);
  });

  it("keeps compound X/Y rotation finite", () => {
    const result = computeCompensation(base(rotationFromEuler(37, -41, 12)));
    expect(result.fallback).toBe(false);
    expect(result.matrix.every(Number.isFinite)).toBe(true);
    expect(result.cssMatrix3d).not.toMatch(/NaN|Infinity/);
  });

  it("scales measured rotation independently from output strength", () => {
    const yaw20 = computeCompensation(base(rotationFromEuler(0, 20, 0)));
    const yaw40HalfAngle = computeCompensation(base(rotationFromEuler(0, 40, 0), {orientationGain: .5}));
    expect(horizontalSpan(yaw40HalfAngle.matrix)).toBeCloseTo(horizontalSpan(yaw20.matrix), 5);

    const full = computeCompensation(base(rotationFromEuler(0, 40, 0)));
    const halfOutput = computeCompensation(base(rotationFromEuler(0, 40, 0), {compensationStrength: .5}));
    expect(horizontalSpan(halfOutput.matrix)).toBeGreaterThan(240);
    expect(horizontalSpan(halfOutput.matrix)).toBeLessThan(horizontalSpan(full.matrix));
  });

  it("clamps and then fades beyond maxTilt", () => {
    const near = computeCompensation(base(rotationFromEuler(0, 70, 0)));
    const extreme = computeCompensation(base(rotationFromEuler(0, 82, 0)));
    expect(near.effectiveTilt).toBeCloseTo(65, 5);
    expect(near.strength).toBeGreaterThan(0);
    expect(near.strength).toBeLessThan(1);
    expect(extreme.strength).toBe(0);
    expect(extreme.matrix).toEqual(IDENTITY_3);
  });

  it("falls back safely for NaN and singular inputs", () => {
    const bad = [...IDENTITY_3] as Mat3; bad[0] = Number.NaN;
    const nan = computeCompensation(base(bad));
    const singular = homographyFromQuads(
      [{x:0,y:0},{x:1,y:0},{x:2,y:0},{x:3,y:0}],
      [{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}],
    );
    expect(nan.fallback).toBe(true);
    expect(nan.cssMatrix3d).not.toMatch(/NaN|Infinity/);
    expect(singular).toBeNull();
  });
});

describe("CSS matrix3d convention", () => {
  it("embeds a known homography in CSS column-major argument order", () => {
    const h: Mat3 = [2, .25, 10, -.5, 3, 20, .001, -.002, 1];
    const css = homographyToCssMatrix3d(h);
    const values = css.slice(9, -1).split(",").map(Number);
    const cssApply = (p: Point2) => {
      const w = values[3]! * p.x + values[7]! * p.y + values[15]!;
      return {x: (values[0]! * p.x + values[4]! * p.y + values[12]!) / w, y: (values[1]! * p.x + values[5]! * p.y + values[13]!) / w};
    };
    const point = {x: 42, y: 17};
    expect(cssApply(point).x).toBeCloseTo(applyHomography(h, point)!.x, 8);
    expect(cssApply(point).y).toBeCloseTo(applyHomography(h, point)!.y, 8);
  });
});
