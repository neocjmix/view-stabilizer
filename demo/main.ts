import "./style.css";
import {createViewStabilizer, type StabilizerSnapshot, type ViewStabilizer} from "../src/index";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const target = $("stabilized");
const overlay = $("debug-overlay") as unknown as SVGElement;
const projectedQuad = $("projected-quad") as unknown as SVGPolygonElement;
const targetQuad = $("target-quad") as unknown as SVGPolygonElement;
let stabilizer: ViewStabilizer;
let simulation = false;
let lastTelemetryPaint = 0;
let baseRect = target.getBoundingClientRect();

const values = () => ({
  viewingDistance: Number(($<HTMLInputElement>("distance")).value),
  maxTilt: Number(($<HTMLInputElement>("max-tilt")).value),
  smoothing: Number(($<HTMLInputElement>("smoothing")).value),
});

function create(mode: "sensor" | "simulation") {
  stabilizer?.destroy();
  baseRect = target.getBoundingClientRect();
  simulation = mode === "simulation";
  stabilizer = createViewStabilizer(target, {
    ...values(), simulation,
    onStateChange: paintState,
    onUpdate: paintTelemetry,
  });
  $("simulation-controls").hidden = !simulation;
  $("permission").toggleAttribute("disabled", simulation);
  $("mode-sensor").classList.toggle("active", !simulation);
  $("mode-simulation").classList.toggle("active", simulation);
  paintState(stabilizer.getState());
  if (simulation) {
    stabilizer.setSimulationOrientation(0, 0, 0);
    stabilizer.start();
  }
}

function paintState(state: string) {
  $("state").textContent = state;
  $("notice").textContent = state === "permission-required" ? "iOS requires Allow motion to be tapped directly." :
    state === "permission-denied" ? "Motion access was denied. Enable it in Safari settings or use Simulation." :
    state === "unsupported" ? "No sensor API or secure context. Use Simulation to verify the geometry." :
    simulation ? "Simulation uses the exact same compensation core as the sensor path." : "Recenter defines the current phone pose as front-facing.";
}

function matrixText(matrix: readonly number[]) {
  return [0,3,6].map(start => matrix.slice(start,start+3).map(n => n.toFixed(4).padStart(8)).join(" ")).join("\n");
}

function points(values: readonly {x:number;y:number}[]) {return values.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");}

function paintTelemetry(snapshot: StabilizerSnapshot) {
  const now = performance.now();
  if (now - lastTelemetryPaint < 80) return;
  lastTelemetryPaint = now;
  $("calibrated").textContent = snapshot.calibrated ? "set" : "waiting";
  $("input-source").textContent = snapshot.orientation?.source ?? "none";
  $("tilt-value").textContent = `${snapshot.compensation.tilt.toFixed(1)}°`;
  const o = snapshot.orientation;
  $("orientation").textContent = o ? `alpha  ${o.alpha.toFixed(2)}\nbeta   ${o.beta.toFixed(2)}\ngamma  ${o.gamma.toFixed(2)}\nscreen ${o.screenAngle}°` : "alpha  —\nbeta   —\ngamma  —\nscreen —";
  $("rotation").textContent = matrixText(snapshot.relativeRotation);
  $("matrix").textContent = snapshot.compensation.cssMatrix3d;
  $("strength").textContent = snapshot.compensation.strength.toFixed(3);
  $("fallback").textContent = String(snapshot.compensation.fallback);
  projectedQuad.setAttribute("points", points(snapshot.compensation.projectedScreen));
  targetQuad.setAttribute("points", points(snapshot.compensation.targetQuad.map(p => ({x:p.x+baseRect.left,y:p.y+baseRect.top}))));
}

$("permission").addEventListener("click", async () => {await stabilizer.requestPermission(); paintState(stabilizer.getState());});
$("start").addEventListener("click", () => {if (!stabilizer.start()) paintState(stabilizer.getState());});
$("stop").addEventListener("click", () => stabilizer.stop());
$("recenter").addEventListener("click", () => {const ok=stabilizer.recenter(); $("calibrated").textContent=ok?"set":"no input";});
$("enabled").addEventListener("change", event => stabilizer.setEnabled((event.target as HTMLInputElement).checked));
$("debug").addEventListener("change", event => overlay.classList.toggle("visible", (event.target as HTMLInputElement).checked));
$("mode-sensor").addEventListener("click", () => create("sensor"));
$("mode-simulation").addEventListener("click", () => create("simulation"));

for (const [id, output, suffix] of [["distance","distance-value"," mm"],["max-tilt","max-tilt-value","°"],["smoothing","smoothing-value",""]] as const) {
  $(id).addEventListener("input", event => {
    const value = (event.target as HTMLInputElement).value;
    $(output).textContent = value + suffix;
    stabilizer.setOptions(values());
  });
}
function updateSimulation() {
  const pitch=Number(($<HTMLInputElement>("pitch")).value), yaw=Number(($<HTMLInputElement>("yaw")).value), roll=Number(($<HTMLInputElement>("roll")).value);
  $("pitch-value").textContent=`${pitch}°`; $("yaw-value").textContent=`${yaw}°`; $("roll-value").textContent=`${roll}°`;
  stabilizer.setSimulationOrientation(pitch,yaw,roll);
}
for (const id of ["pitch","yaw","roll"]) $(id).addEventListener("input", updateSimulation);

create("sensor");
