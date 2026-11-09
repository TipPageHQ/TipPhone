import fs from "node:fs";
import path from "node:path";

const defaults = {
  clientId: "",
  port: 4455,
  browser: "default",
  answerDelayMs: 1000,
  ringTimeoutSec: 0,
  missedRetrySec: 60,
  betweenCallsMs: 3000,
  waitForAudioSec: 60,
  hangUpBeforeAudio: "release",
  hangUpDuringAudio: "finish",
  includeReplays: false,
  // don't ring while the alert box is showing a sub / raid / cheer, and hold the
  // voice if one is on screen when the handset comes up - for up to this long
  waitForAlerts: true,
  waitForAlertsSec: 120,
  // original name of an uploaded ring sound (saved next to the exe as ring.<ext>), null = built-in
  ringFile: null,
  // "" = the main alert box's voice (rate and pitch too), else a standard voice id
  voice: { voice: "", rate: 1, pitch: 1, readNames: true, readAmounts: true, readMessages: true },
  overlay: {
    ringing: "{name} is calling.",
    onCall: "{name} is on the phone.",
    showAmount: true,
    showMessage: true,
    endedHoldMs: 4000,
    // the card's colour, #rrggbb. tippage green unless the picker on the control page says otherwise
    color: "#4ade80",
  },
};

// next to the exe when built, the project folder when run with bun
export function appDir() {
  if (process.env.TIP_PHONE_DIR) return process.env.TIP_PHONE_DIR;
  const exe = path.basename(process.execPath).toLowerCase();
  if (exe.startsWith("bun") || exe.startsWith("node")) return path.resolve(import.meta.dir, "..");
  return path.dirname(process.execPath);
}

const file = () => path.join(appDir(), "config.json");

export function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.log(`config.json is broken (${err.message}), using defaults`);
  }
  const cfg = { ...defaults, ...saved, voice: { ...defaults.voice, ...saved.voice }, overlay: { ...defaults.overlay, ...saved.overlay } };
  if (!fs.existsSync(file())) saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  fs.writeFileSync(file(), JSON.stringify(cfg, null, 2) + "\n");
}
