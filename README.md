# @neocjmix/view-stabilizer

Calibrated inverse-perspective compensation for DOM elements. The element becomes intentionally stretched and trapezoidal **on the display** so that, from the calibrated viewer position, it appears closer to its original front-facing rectangle.

This is Phase 1: it uses `DeviceOrientation`, one user calibration, and a fixed viewer assumption. It does not use the camera or track a face.

## Install

```sh
npm install @neocjmix/view-stabilizer
```

```ts
import {createViewStabilizer} from "@neocjmix/view-stabilizer";

const stabilizer = createViewStabilizer(document.querySelector(".target")!, {
  viewingDistance: 400,
  maxTilt: 65,
  smoothing: 0.12,
});

// On iOS this must run directly inside a click/touch user gesture.
await stabilizer.requestPermission();
stabilizer.start();

// Make the current device pose the new front-facing reference.
stabilizer.calibrate();
// stabilizer.recenter() is an alias.
```

The canonical API term is `calibrate()`. The `recenter()` alias is included because it is usually the clearer button label.

## What it computes

At calibration:

- the current device attitude is stored as `R0`;
- the screen center is `(0, 0, 0)`;
- the viewer is assumed to be at `(0, 0, d)`, with `d = 400 mm` by default.

For each animation frame:

1. The most recent sensor attitude is consumed outside the event callback.
2. The relative rotation is `transpose(R0) × R` (rotation matrices are orthonormal).
3. The four physical screen corners are rotated in 3D.
4. Rays from the fixed viewer through those corners are intersected with the calibrated screen plane.
5. A homography maps original screen coordinates to that apparent quadrilateral.
6. Its inverse is evaluated at the target element's original four corners.
7. A local element homography maps the DOM rectangle to those inverse-projected corners.
8. That homography is embedded in CSS `matrix3d(...)` with `transform-origin: 0 0`.

This includes foreshortening, translation, rotation, and trapezoidal perspective. It is not `rotateX/rotateY` counter-rotation and it is not `1 / cos(tilt)` scaling.

The package uses no WebGL, no 3D engine, and no runtime dependencies.

## API

```ts
type TrackingState =
  | "idle"
  | "permission-required"
  | "permission-denied"
  | "ready"
  | "tracking"
  | "unsupported";

interface ViewStabilizerOptions {
  viewingDistance?: number;       // mm, default 400
  maxTilt?: number;               // degrees, default 65
  smoothing?: number;             // slerp fraction/frame, default 0.12
  enabled?: boolean;              // default true
  physicalScreenWidth?: number;   // mm estimate, default 70
  viewerPoseProvider?: ViewerPoseProvider;
  simulation?: boolean;
  onStateChange?: (state: TrackingState) => void;
  onUpdate?: (snapshot: StabilizerSnapshot) => void;
}
```

| Method | Meaning |
| --- | --- |
| `requestPermission()` | Requests iOS motion permission or resolves the current state elsewhere. |
| `start()` | Attaches the sensor listener and starts the rAF consumer. Returns `false` if permission/support is missing. |
| `calibrate()` | Stores the current attitude as the front-facing reference. Returns `false` until a reading exists. |
| `recenter()` | Alias for `calibrate()`. |
| `stop()` | Stops tracking and applies identity. |
| `setEnabled(boolean)` | Turns compensation on/off while tracking continues. |
| `setOptions(partial)` | Updates distance, tilt, smoothing, or physical width without recreation. |
| `destroy()` | Stops, detaches, and restores the element's original inline transform styles. |

The stabilizer owns the target element's inline `transform`, `transform-origin`, and `will-change`. If the element already needs a transform, place it in a wrapper and stabilize the wrapper.

## Safety at extreme angles

`maxTilt` measures the physical screen normal's departure from the calibrated normal; pure roll does not count as tilt. Above the limit, the projective rotation is clamped and compensation fades smoothly to identity over the next 15 degrees. Invalid inputs, a near-singular homography, a projection crossing the viewer plane, non-finite values, and implausibly large output coordinates all fall back to identity. `NaN` and `Infinity` are never written to CSS.

## Smoothing and update behavior

The `DeviceOrientation` handler only normalizes and stores the latest attitude. Quaternion SLERP, projection, homography solving, and style writes happen in `requestAnimationFrame`. Layout geometry is cached. It is remeasured only on start/calibration, resize, or scroll—not on every sensor event or animation frame.

`smoothing` is the fraction moved toward the latest attitude per frame:

- `1`: no smoothing, lowest latency;
- `0.12`: default compromise;
- smaller values: steadier but more delayed.

## Browser and permission notes

- A secure context (`https:` or localhost) is required for sensor tracking.
- iOS Safari exposes `DeviceOrientationEvent.requestPermission()`. Call `requestPermission()` synchronously from a user gesture; the library reports `permission-required` rather than trying to trigger the prompt on page load.
- Screen rotation is normalized using `screen.orientation.angle`, with legacy `window.orientation` as fallback.
- Browsers without a usable orientation API report `unsupported`. The demo's Simulation mode remains available.
- Mobile browser sensor frequency and filtering differ by device and OS.

## Calibration assumptions and limitations

At calibration, the eye is modeled directly in front of the screen center at distance `d`. Afterwards, the viewer's head is assumed to stay at roughly the same position while the phone mainly rotates around its center.

Consequences:

- moving the head sideways breaks the assumed projection;
- moving the phone substantially toward/away from the face changes apparent scale;
- real rotation rarely occurs exactly around the screen center;
- CSS pixels do not expose reliable physical display size, so the default assumes a 70 mm portrait screen width; tune `physicalScreenWidth` for precision;
- large compensation can move content outside the viewport even before the safety falloff.

This is calibrated view stabilization, not true face tracking.

## Phase 2 seam

The geometry already accepts an off-axis viewer pose through a deliberately small provider interface:

```ts
interface ViewerPose { x: number; y: number; z: number }
interface ViewerPoseProvider { getPose(): ViewerPose }
```

Phase 1 uses a fixed provider returning `{x: 0, y: 0, z: viewingDistance}`. A future front-camera provider can supply measured lateral position and distance without replacing the homography solver or CSS output path.

## Desktop simulation

The demo can switch from Device sensor to Simulation and drive pitch, yaw, and roll sliders. Programmatically:

```ts
const simulated = createViewStabilizer(element, {simulation: true});
simulated.setSimulationOrientation(0, 0, 0);
simulated.start();
simulated.calibrate();
simulated.setSimulationOrientation(20, 45, 5);
```

## Development

```sh
npm install
npm run dev
npm test
npm run typecheck
npm run build
npm run pack:check
```

The pure geometry module is also exported as `@neocjmix/view-stabilizer/geometry` for tests and non-sensor integrations.

## License

MIT
