import fs from "node:fs";
import path from "node:path";
import { appDir, saveConfig } from "./config.js";
import builtIn from "./ring.wav" with { type: "file" };

// the ring sound. ring.wav is built into the exe, or one can be uploaded from
// the control page and it sits next to the exe as ring.mp3 / ring.wav / whatever

const types = {
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
  m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", webm: "audio/webm",
};

let cfg;

export function initRing(config) {
  cfg = config;
}

function ext(name) {
  return path.extname(name || "").slice(1).toLowerCase();
}

// the uploaded ring, if config names one and the file is still there
function uploaded() {
  if (!cfg.ringFile) return null;
  const file = path.join(appDir(), "ring." + ext(cfg.ringFile));
  if (!fs.existsSync(file)) return null;
  return { path: file, type: types[ext(cfg.ringFile)], name: cfg.ringFile };
}

export function currentRing() {
  return uploaded() || { path: builtIn, type: "audio/wav", name: null };
}

// what the control page shows. the version makes the browser fetch a new file
export function ringInfo() {
  const up = uploaded();
  let version = 0;
  if (up) try { version = Math.floor(fs.statSync(up.path).mtimeMs); } catch {}
  return { custom: up ? up.name : null, url: "/ring?v=" + version };
}

export function saveRing(name, bytes) {
  name = path.basename(name || "").slice(0, 80);
  if (!types[ext(name)]) return { error: "That isn't an audio file TipPhone can play. Try an mp3, wav or ogg" };
  if (!bytes.length) return { error: "That file is empty" };
  if (bytes.length > 8 * 1024 * 1024) return { error: "That file is over 8 MB, pick a shorter one" };
  removeUploaded();
  try {
    fs.writeFileSync(path.join(appDir(), "ring." + ext(name)), bytes);
  } catch (err) {
    return { error: "Couldn't save it next to TipPhone.exe (" + err.message + ")" };
  }
  cfg.ringFile = name;
  return remember();
}

export function resetRing() {
  removeUploaded();
  cfg.ringFile = null;
  return remember();
}

function remember() {
  try {
    saveConfig(cfg);
  } catch (err) {
    return { error: "Couldn't write config.json (" + err.message + "), so this won't survive a restart" };
  }
  return { ok: true };
}

// clears every ring.<ext> next to the exe, not just the one config names
function removeUploaded() {
  for (const e of Object.keys(types)) {
    try { fs.unlinkSync(path.join(appDir(), "ring." + e)); } catch {}
  }
}
