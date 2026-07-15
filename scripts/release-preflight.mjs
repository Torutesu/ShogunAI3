#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
const mode = (modeArg?.split("=")[1] || process.env.SHOGUN_RELEASE_MODE || "beta").trim();
const isPublic = mode === "public";

const errors = [];
const warnings = [];

function rel(...parts) {
  return path.join(root, ...parts);
}

function exists(file) {
  return fs.existsSync(rel(file));
}

function read(file) {
  return fs.readFileSync(rel(file), "utf8");
}

function readJson(file) {
  return JSON.parse(read(file));
}

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function requireFile(file, label = file) {
  if (!exists(file)) fail(`${label} is missing (${file})`);
}

function hasResource(tauri, resourcePath) {
  return (tauri.bundle?.resources || []).includes(resourcePath);
}

function envAny(names) {
  return names.some((name) => Boolean(process.env[name]));
}

const pkg = readJson("package.json");
const tauri = readJson("src-tauri/tauri.conf.json");
const updaterConfig = exists("src-tauri/tauri.updater.json")
  ? readJson("src-tauri/tauri.updater.json")
  : null;
const cargo = read("src-tauri/Cargo.toml");
const infoPlist = read("src-tauri/Info.plist");
const readme = read("README.md");

const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const cargoDescription = cargo.match(/^description\s*=\s*"([^"]+)"/m)?.[1] || "";
const cargoAuthors = cargo.match(/^authors\s*=\s*\[([^\]]*)\]/m)?.[1] || "";

console.log(`Shogun release preflight (${mode})`);

if (!["beta", "public"].includes(mode)) {
  fail(`Unknown release mode "${mode}". Use --mode=beta or --mode=public.`);
}

if (!pkg.name) fail("package.json name is missing.");
if (!pkg.private) warn("package.json is not private; confirm this package is intended for npm publication.");
if (!["UNLICENSED", "SEE LICENSE IN LICENSE"].includes(pkg.license)) {
  warn(`package.json license is "${pkg.license}", expected UNLICENSED or SEE LICENSE IN LICENSE for proprietary distribution.`);
}

if (!pkg.version || !tauri.version || !cargoVersion) {
  fail("Version is missing in package.json, tauri.conf.json, or Cargo.toml.");
} else if (pkg.version !== tauri.version || pkg.version !== cargoVersion) {
  fail(`Version mismatch: package=${pkg.version}, tauri=${tauri.version}, cargo=${cargoVersion}.`);
}

if (!tauri.productName) fail("tauri.conf.json productName is missing.");
if (!tauri.identifier || tauri.identifier === "com.tauri.dev") {
  fail("tauri.conf.json identifier must be a stable reverse-DNS app id.");
}
if (tauri.build?.frontendDist !== "../web-dist") {
  warn(`tauri build.frontendDist is "${tauri.build?.frontendDist}", expected "../web-dist".`);
}
if (!tauri.bundle?.active) fail("Tauri bundle.active must be true for release builds.");
if (tauri.bundle?.createUpdaterArtifacts) {
  fail("Default tauri.conf.json must keep bundle.createUpdaterArtifacts false so unsigned beta builds do not require TAURI_SIGNING_PRIVATE_KEY.");
}
if (!updaterConfig?.bundle?.createUpdaterArtifacts) {
  fail("src-tauri/tauri.updater.json must enable bundle.createUpdaterArtifacts for signed updater releases.");
}
if (!tauri.bundle?.macOS?.hardenedRuntime) fail("macOS hardenedRuntime must be enabled.");
if (!tauri.bundle?.macOS?.entitlements) fail("macOS entitlements plist is not configured.");
if (!tauri.bundle?.macOS?.infoPlist) fail("macOS Info.plist is not configured.");
if (tauri.bundle?.updater) fail("Tauri updater config must live under plugins.updater, not bundle.updater.");
if (!tauri.plugins?.updater?.pubkey) fail("Tauri updater pubkey is missing.");
if (!Array.isArray(tauri.plugins?.updater?.endpoints) || tauri.plugins.updater.endpoints.length === 0) {
  fail("Tauri updater endpoint is missing.");
}

for (const icon of ["icons/icon.icns", "icons/32x32.png", "icons/128x128.png"]) {
  if (!(tauri.bundle?.icon || []).includes(icon)) fail(`Tauri bundle icon is missing from config: ${icon}`);
}

for (const resource of [
  "../docs/TERMS_OF_SERVICE.md",
  "../docs/TERMS_OF_SERVICE_EN.md",
  "../docs/PRIVACY.ja.md",
  "../PRIVACY.md",
]) {
  if (!hasResource(tauri, resource)) fail(`Required legal resource is not bundled: ${resource}`);
}

if (!cargoDescription || cargoDescription === "A Tauri App") {
  fail("Cargo package description is still a placeholder.");
}
if (!cargoAuthors || cargoAuthors.includes('"you"')) {
  fail('Cargo package authors still contains the placeholder "you".');
}
if (!cargo.includes('license-file = "../LICENSE"')) {
  fail("Cargo package must point at ../LICENSE.");
}

requireFile("LICENSE", "Proprietary license");
requireFile("PRIVACY.md", "English privacy policy");
requireFile("docs/PRIVACY.ja.md", "Japanese privacy policy");
requireFile("docs/TERMS_OF_SERVICE.md", "Japanese terms");
requireFile("docs/TERMS_OF_SERVICE_EN.md", "English terms");
requireFile("docs/END_USER_SETUP.md", "End-user setup guide");
requireFile("docs/macos-release.md", "macOS release guide");
requireFile("src-tauri/tauri.updater.json", "Updater release config");
requireFile(".github/workflows/ci.yml", "CI workflow");
requireFile(".github/workflows/release-macos.yml", "macOS release workflow");

for (const key of [
  "NSAppleEventsUsageDescription",
  "NSMicrophoneUsageDescription",
  "NSFaceIDUsageDescription",
]) {
  if (!infoPlist.includes(key)) fail(`Info.plist is missing ${key}.`);
}

if (!readme.includes("docs/END_USER_SETUP.md")) warn("README does not link the end-user setup guide.");
if (!readme.includes("docs/macos-release.md")) warn("README does not link the macOS release guide.");

if (isPublic) {
  if (readme.includes("未署名 DMG") || readme.includes("Apple Developer 未登録")) {
    fail("README still describes the main download as an unsigned beta. Update it before public paid release.");
  }
  if (!envAny(["APPLE_CERTIFICATE", "SHOGUN_ASSUME_APPLE_SIGNING_CONFIGURED"])) {
    fail("Public release requires APPLE_CERTIFICATE or SHOGUN_ASSUME_APPLE_SIGNING_CONFIGURED=1.");
  }
  if (!envAny(["APPLE_CERTIFICATE_PASSWORD", "SHOGUN_ASSUME_APPLE_SIGNING_CONFIGURED"])) {
    fail("Public release requires APPLE_CERTIFICATE_PASSWORD or SHOGUN_ASSUME_APPLE_SIGNING_CONFIGURED=1.");
  }
  if (!envAny(["TAURI_SIGNING_PRIVATE_KEY", "SHOGUN_ASSUME_UPDATER_SIGNING_CONFIGURED"])) {
    fail("Public release requires TAURI_SIGNING_PRIVATE_KEY or SHOGUN_ASSUME_UPDATER_SIGNING_CONFIGURED=1.");
  }
  if (
    !process.env.SHOGUN_ASSUME_NOTARIZATION_CONFIGURED
    && (!process.env.APPLE_API_KEY_P8_BASE64 || !process.env.APPLE_API_KEY_ID || !process.env.APPLE_API_ISSUER)
  ) {
    fail("Public release requires APPLE_API_KEY_P8_BASE64, APPLE_API_KEY_ID, and APPLE_API_ISSUER or SHOGUN_ASSUME_NOTARIZATION_CONFIGURED=1.");
  }
  if (!read("docs/macos-release.md").includes("notarization")) {
    fail("macOS release guide must document notarization.");
  }
} else if (readme.includes("未署名 DMG")) {
  warn("README currently points users at an unsigned beta DMG. This is acceptable for beta, not for public paid distribution.");
}

for (const message of warnings) console.warn(`WARN  ${message}`);
for (const message of errors) console.error(`ERROR ${message}`);

if (errors.length > 0) {
  console.error(`Release preflight failed: ${errors.length} error(s), ${warnings.length} warning(s).`);
  process.exit(1);
}

console.log(`Release preflight passed: 0 errors, ${warnings.length} warning(s).`);
