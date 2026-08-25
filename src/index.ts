import {
  computeCompensation, homographyToCssMatrix3d, IDENTITY_3, multiplyMat3,
  rotationFromEuler, transposeMat3, type CompensationResult, type Mat3, type RectLike, type ViewerPose,
} from "./geometry";
import {deviceOrientationMatrix, mat3ToQuaternion, quaternionToMat3, slerpQuaternion, type Quaternion} from "./orientation";

export type TrackingState = "idle" | "permission-required" | "permission-denied" | "ready" | "tracking" | "unsupported";
export interface ViewerPoseProvider {getPose(): ViewerPose}

export interface OrientationReading {
  alpha: number;
  beta: number;
  gamma: number;
  screenAngle: number;
  timestamp: number;
  source: "sensor" | "simulation";
}

export interface StabilizerSnapshot {
  state: TrackingState;
  calibrated: boolean;
  enabled: boolean;
  orientation: OrientationReading | null;
  relativeRotation: Mat3;
  compensation: CompensationResult;
}

export interface ViewStabilizerOptions {
  viewingDistance?: number;
  maxTilt?: number;
  smoothing?: number;
  enabled?: boolean;
  /** Physical width of the portrait display in mm. Default: 66.59 (iPhone 16 Pro active display). */
  physicalScreenWidth?: number;
  /** Scales measured relative rotation in axis-angle space. Default: 1. */
  orientationGain?: number;
  /** Scales inverse-projective displacement after solving. Default: 1. */
  compensationStrength?: number;
  viewerPoseProvider?: ViewerPoseProvider;
  /** Bypasses sensor support/permission and accepts setSimulationOrientation(). */
  simulation?: boolean;
  onStateChange?: (state: TrackingState) => void;
  onUpdate?: (snapshot: StabilizerSnapshot) => void;
}

export interface ViewStabilizer {
  requestPermission(): Promise<TrackingState>;
  start(): boolean;
  stop(): void;
  calibrate(): boolean;
  /** Alias for calibrate(). */
  recenter(): boolean;
  setEnabled(enabled: boolean): void;
  setOptions(options: Partial<Pick<ViewStabilizerOptions, "viewingDistance" | "maxTilt" | "smoothing" | "physicalScreenWidth" | "orientationGain" | "compensationStrength">>): void;
  setSimulationOrientation(pitch: number, yaw: number, roll: number): void;
  getState(): TrackingState;
  getSnapshot(): StabilizerSnapshot;
  destroy(): void;
}

const identityCompensation = (): CompensationResult => ({
  matrix: IDENTITY_3,
  cssMatrix3d: homographyToCssMatrix3d(IDENTITY_3),
  projectedScreen: [{x:0,y:0},{x:0,y:0},{x:0,y:0},{x:0,y:0}],
  targetQuad: [{x:0,y:0},{x:0,y:0},{x:0,y:0},{x:0,y:0}],
  tilt: 0, effectiveTilt: 0, strength: 0, fallback: false,
});

type PermissionOrientationEvent = typeof DeviceOrientationEvent & {requestPermission?: () => Promise<"granted" | "denied">};

class FixedViewerPoseProvider implements ViewerPoseProvider {
  constructor(private readonly distance: () => number) {}
  getPose(): ViewerPose {return {x: 0, y: 0, z: this.distance()};}
}

class ViewStabilizerImpl implements ViewStabilizer {
  private state: TrackingState = "idle";
  private enabled: boolean;
  private destroyed = false;
  private listening = false;
  private raf = 0;
  private measureQueued = false;
  private rect: RectLike;
  private latestMatrix: Mat3 | null = null;
  private smoothedQuaternion: Quaternion | null = null;
  private calibrationMatrix: Mat3 | null = null;
  private reading: OrientationReading | null = null;
  private compensation = identityCompensation();
  private readonly originalStyle: {transform: string; transformOrigin: string; willChange: string};
  private readonly poseProvider: ViewerPoseProvider;
  private readonly options: Required<Pick<ViewStabilizerOptions, "viewingDistance" | "maxTilt" | "smoothing" | "physicalScreenWidth" | "orientationGain" | "compensationStrength" | "simulation">> & Pick<ViewStabilizerOptions, "onStateChange" | "onUpdate">;

  constructor(private readonly element: HTMLElement, options: ViewStabilizerOptions) {
    this.options = {
      viewingDistance: options.viewingDistance ?? 400,
      maxTilt: options.maxTilt ?? 65,
      smoothing: options.smoothing ?? 0.12,
      physicalScreenWidth: options.physicalScreenWidth ?? 66.59,
      orientationGain: options.orientationGain ?? 1,
      compensationStrength: options.compensationStrength ?? 1,
      simulation: options.simulation ?? false,
      ...(options.onStateChange ? {onStateChange: options.onStateChange} : {}),
      ...(options.onUpdate ? {onUpdate: options.onUpdate} : {}),
    };
    this.enabled = options.enabled ?? true;
    this.poseProvider = options.viewerPoseProvider ?? new FixedViewerPoseProvider(() => this.options.viewingDistance);
    this.originalStyle = {transform: element.style.transform, transformOrigin: element.style.transformOrigin, willChange: element.style.willChange};
    this.rect = this.measure();
    this.setState(this.detectInitialState());
  }

  private detectInitialState(): TrackingState {
    if (this.options.simulation) return "ready";
    if (typeof window === "undefined" || !("DeviceOrientationEvent" in window) || !window.isSecureContext) return "unsupported";
    const event = window.DeviceOrientationEvent as PermissionOrientationEvent;
    return typeof event.requestPermission === "function" ? "permission-required" : "ready";
  }

  private setState(next: TrackingState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }

  async requestPermission(): Promise<TrackingState> {
    if (this.destroyed || this.state === "unsupported" || this.options.simulation) return this.state;
    const event = window.DeviceOrientationEvent as PermissionOrientationEvent;
    if (typeof event.requestPermission !== "function") {this.setState("ready"); return this.state;}
    try {
      const result = await event.requestPermission();
      this.setState(result === "granted" ? "ready" : "permission-denied");
    } catch {
      // iOS throws here when this was not called synchronously from a user gesture.
      this.setState("permission-required");
    }
    return this.state;
  }

  start(): boolean {
    if (this.destroyed || !["ready", "tracking"].includes(this.state)) return false;
    if (this.state === "tracking") return true;
    this.element.style.transformOrigin = "0 0";
    this.element.style.willChange = "transform";
    if (!this.options.simulation) {
      window.addEventListener("deviceorientation", this.onOrientation, {capture: true, passive: true});
      this.listening = true;
    }
    window.addEventListener("resize", this.queueMeasure, {passive: true});
    window.addEventListener("scroll", this.queueMeasure, {passive: true});
    this.setState("tracking");
    this.raf = requestAnimationFrame(this.tick);
    return true;
  }

  stop(): void {
    if (this.listening) window.removeEventListener("deviceorientation", this.onOrientation, true);
    this.listening = false;
    window.removeEventListener("resize", this.queueMeasure);
    window.removeEventListener("scroll", this.queueMeasure);
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.applyIdentity();
    if (this.state === "tracking") this.setState("ready");
  }

  calibrate(): boolean {
    if (!this.latestMatrix) return false;
    this.calibrationMatrix = [...this.latestMatrix] as Mat3;
    this.smoothedQuaternion = mat3ToQuaternion(this.latestMatrix);
    this.rect = this.measure();
    this.applyIdentity();
    return true;
  }

  recenter(): boolean {return this.calibrate();}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.applyIdentity();
  }

  setOptions(options: Partial<Pick<ViewStabilizerOptions, "viewingDistance" | "maxTilt" | "smoothing" | "physicalScreenWidth" | "orientationGain" | "compensationStrength">>): void {
    if (options.viewingDistance !== undefined && Number.isFinite(options.viewingDistance)) this.options.viewingDistance = Math.max(1, options.viewingDistance);
    if (options.maxTilt !== undefined && Number.isFinite(options.maxTilt)) this.options.maxTilt = Math.min(89, Math.max(1, options.maxTilt));
    if (options.smoothing !== undefined && Number.isFinite(options.smoothing)) this.options.smoothing = Math.min(1, Math.max(0.001, options.smoothing));
    if (options.physicalScreenWidth !== undefined && Number.isFinite(options.physicalScreenWidth)) this.options.physicalScreenWidth = Math.max(1, options.physicalScreenWidth);
    if (options.orientationGain !== undefined && Number.isFinite(options.orientationGain)) this.options.orientationGain = Math.min(2, Math.max(0, options.orientationGain));
    if (options.compensationStrength !== undefined && Number.isFinite(options.compensationStrength)) this.options.compensationStrength = Math.min(2, Math.max(0, options.compensationStrength));
  }

  setSimulationOrientation(pitch: number, yaw: number, roll: number): void {
    if (!this.options.simulation || this.destroyed || ![pitch,yaw,roll].every(Number.isFinite)) return;
    this.latestMatrix = rotationFromEuler(pitch, yaw, roll);
    this.reading = {alpha: roll, beta: pitch, gamma: yaw, screenAngle: 0, timestamp: performance.now(), source: "simulation"};
    if (!this.calibrationMatrix) this.calibrate();
  }

  getState(): TrackingState {return this.state;}
  getSnapshot(): StabilizerSnapshot {
    const relative = this.relativeRotation();
    return {state: this.state, calibrated: this.calibrationMatrix !== null, enabled: this.enabled, orientation: this.reading ? {...this.reading} : null, relativeRotation: relative, compensation: this.compensation};
  }

  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    this.element.style.transform = this.originalStyle.transform;
    this.element.style.transformOrigin = this.originalStyle.transformOrigin;
    this.element.style.willChange = this.originalStyle.willChange;
    this.setState("idle");
  }

  private readonly onOrientation = (event: DeviceOrientationEvent): void => {
    if (typeof event.beta !== "number" || typeof event.gamma !== "number") return;
    const alpha = typeof event.alpha === "number" ? event.alpha : 0;
    const screenAngle = ((screen.orientation?.angle ?? Number((window as Window & {orientation?: number}).orientation) ?? 0) + 360) % 360;
    this.latestMatrix = deviceOrientationMatrix(alpha, event.beta, event.gamma, screenAngle);
    this.reading = {alpha, beta: event.beta, gamma: event.gamma, screenAngle, timestamp: performance.now(), source: "sensor"};
    if (!this.calibrationMatrix) this.calibrate();
  };

  private readonly tick = (): void => {
    if (this.destroyed || this.state !== "tracking") return;
    if (this.latestMatrix && this.calibrationMatrix) {
      const target = mat3ToQuaternion(this.latestMatrix);
      this.smoothedQuaternion = this.smoothedQuaternion ? slerpQuaternion(this.smoothedQuaternion, target, this.options.smoothing) : target;
      const relative = multiplyMat3(transposeMat3(this.calibrationMatrix), quaternionToMat3(this.smoothedQuaternion));
      const viewport = {width: window.innerWidth, height: window.innerHeight};
      this.compensation = computeCompensation({
        viewport, element: this.rect, rotation: relative,
        viewingDistance: this.options.viewingDistance,
        viewerPose: this.poseProvider.getPose(),
        maxTilt: this.options.maxTilt,
        physicalScreenWidth: this.options.physicalScreenWidth,
        orientationGain: this.options.orientationGain,
        compensationStrength: this.options.compensationStrength,
      });
      this.element.style.transform = this.enabled ? this.compensation.cssMatrix3d : homographyToCssMatrix3d(IDENTITY_3);
      this.options.onUpdate?.(this.getSnapshot());
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private relativeRotation(): Mat3 {
    if (!this.calibrationMatrix || !this.smoothedQuaternion) return IDENTITY_3;
    return multiplyMat3(transposeMat3(this.calibrationMatrix), quaternionToMat3(this.smoothedQuaternion));
  }

  private readonly queueMeasure = (): void => {
    if (this.measureQueued) return;
    this.measureQueued = true;
    requestAnimationFrame(() => {this.measureQueued = false; this.rect = this.measure();});
  };

  private measure(): RectLike {
    const transform = this.element.style.transform;
    this.element.style.transform = "none";
    const rect = this.element.getBoundingClientRect();
    this.element.style.transform = transform;
    return {left: rect.left, top: rect.top, width: rect.width, height: rect.height};
  }

  private applyIdentity(): void {
    this.compensation = identityCompensation();
    this.element.style.transform = homographyToCssMatrix3d(IDENTITY_3);
  }
}

export function createViewStabilizer(element: HTMLElement, options: ViewStabilizerOptions = {}): ViewStabilizer {
  if (!(element instanceof HTMLElement)) throw new TypeError("createViewStabilizer requires an HTMLElement.");
  return new ViewStabilizerImpl(element, options);
}

export {computeCompensation, homographyFromQuads, homographyToCssMatrix3d, rotationFromEuler} from "./geometry";
export type {CompensationInput, CompensationResult, Mat3, Point2, Quad, ViewerPose} from "./geometry";
