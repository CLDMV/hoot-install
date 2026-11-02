/**
 *
 *	@Project: @cldmv/rummage
 *	@Filename: /src/installer/manifest.mjs
 *	@Date: 2026-11-01T22:00:00-08:00 (1793599200)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T22:00:00-08:00 (1793599200)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/*
 * The app's install manifest, as the installer reads it (CLDMV/rummage#472). It is the same `install.json` the
 * container launcher prints the compose file from (CLDMV/rummage#473): the launcher reads the container keys (name,
 * image, port, volume, hostMount, gpu, env, …), the installer adds the host keys below. Unknown keys are kept, so one
 * file serves both.
 *
 *   {
 *     "name": "hoot", "title": "Hoot", "image": "ghcr.io/cldmv/hoot", "port": 4668, "volume": "hoot-data", "gpu": true,
 *     "env": { "HOOT_SETUP_TOKEN": "", "HOOT_REGISTRY_TOKEN": "" },
 *     "registry": { "private": true, "scope": "read:packages" },
 *     "home": { "posix": ".hoot", "windows": "Hoot" },
 *     "envPrefix": "HOOT", "arch": ["amd64"], "minDiskMb": 8192, "setupPath": "/",
 *     "kit": { "url": "https://cldmv.github.io/hoot-install", "package": "@cldmv/hoot-install" }
 *   }
 *
 * Nothing in it is secret, and nothing secret may be put in it: the manifest is published in the app's public install
 * repo. Node builtins only (the installer runs from a published kit, before any npm install).
 */

import { checkInstallManifest } from "../launcher/compose.mjs";

const PREFIX = /^[A-Z][A-Z0-9_]*$/;
const FOLDER = /^[A-Za-z0-9._ -]+$/;
const ARCHES = new Set(["amd64", "arm64"]);
const SCOPE = /^[a-z:_]+$/;
const PACKAGE = /^(@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/;
/** Keys that hold credentials somewhere else; a manifest that carries one is refused, so a token never ships in it. */
const SECRETISH = /token|secret|password|passwd|credential|private.?key|api.?key|access.?key|^auth$/i;
/** A URL carrying a credential: a token-like query parameter, or a user:password@ part. */
const URL_CREDENTIAL = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/\s@:]+:[^/\s@]*@|[^\s]*[?&#](access_token|token|auth|api[_-]?key|apikey|key|secret|password|sig|signature|x-amz-signature)=[^&\s]+)/i;

/**
 * Validate an install manifest for the installer, filling defaults.
 * @param {object} m — the parsed install.json
 * @returns {object} the checked manifest (`raw` keeps the original)
 * @throws {Error} naming the first problem
 */
export function checkManifest(m) {
	// The container keys are the launcher's (one validation for both readers of install.json).
	const base = checkInstallManifest(m);
	const image = base.image;
	if (!image.includes("/")) throw new Error(`install.json image ${JSON.stringify(m.image)} must be <registry>/<owner>/<name> without a tag`);
	const registryHost = image.split("/")[0];
	if (!/\./.test(registryHost) && !/^localhost(:\d+)?$/.test(registryHost)) throw new Error(`install.json image ${JSON.stringify(image)} must name its registry host (e.g. ghcr.io/owner/name)`);
	const { port, env } = base;
	for (const [k, v] of Object.entries(m.env || {})) if (v !== "" && v != null) throw new Error(`install.json env ${k} carries a value; env lists names to pass through, never values`);
	refuseSecrets(m, "install.json");

	const title = typeof m.title === "string" && m.title.trim() ? m.title.trim() : m.name.charAt(0).toUpperCase() + m.name.slice(1);
	const envPrefix = m.envPrefix == null ? m.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_") : String(m.envPrefix);
	if (!PREFIX.test(envPrefix)) throw new Error(`install.json envPrefix ${JSON.stringify(m.envPrefix)} must be upper case (e.g. HOOT)`);
	const home = { posix: `.${m.name}`, windows: title, ...(m.home || {}) };
	for (const k of ["posix", "windows"]) if (!FOLDER.test(String(home[k])) || home[k] === "." || home[k] === "..") throw new Error(`install.json home.${k} ${JSON.stringify(home[k])} must be one folder name`);
	const arch = m.arch == null ? ["amd64"] : m.arch;
	if (!Array.isArray(arch) || !arch.length || !arch.every((a) => ARCHES.has(a))) throw new Error(`install.json arch must list amd64 and/or arm64`);
	const registry = { private: m.registry?.private === true, scope: m.registry?.scope ?? "read:packages", host: registryHost };
	if (!SCOPE.test(registry.scope)) throw new Error(`install.json registry.scope ${JSON.stringify(registry.scope)} is not a token scope`);
	const minDiskMb = m.minDiskMb == null ? 2048 : Number(m.minDiskMb);
	if (!Number.isFinite(minDiskMb) || minDiskMb < 0) throw new Error(`install.json minDiskMb ${m.minDiskMb} is not a size`);
	const setupPath = m.setupPath == null ? "/" : String(m.setupPath);
	if (!/^\/[^\s?#]*$/.test(setupPath)) throw new Error(`install.json setupPath ${JSON.stringify(m.setupPath)} must be a path`);
	const kit = m.kit ? { url: m.kit.url == null ? null : String(m.kit.url).replace(/\/+$/, ""), package: m.kit.package ?? null } : { url: null, package: null };
	if (kit.url != null && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(kit.url)) throw new Error(`install.json kit.url must be an https URL (the scripts are served over HTTPS)`);
	if (kit.package != null && !PACKAGE.test(kit.package)) throw new Error(`install.json kit.package ${JSON.stringify(kit.package)} is not an npm package name`);
	const volume = base.volume;
	return { name: m.name, title, image, port, volume, gpu: m.gpu === true, env, envPrefix, home, arch, registry, minDiskMb, setupPath, kit, raw: m };
}

/**
 * Refuse a manifest that carries something that looks like a credential: a key named like one with a string value
 * (the `env` map's empty pass-through entries and `registry.scope` are fine).
 * @param {any} v
 * @param {string} where
 */
function refuseSecrets(v, where) {
	if (!v || typeof v !== "object") return;
	for (const [k, x] of Object.entries(v)) {
		const at = `${where}.${k}`;
		if (where === "install.json" && k === "env") continue;
		if (typeof x === "string" && x !== "" && SECRETISH.test(k)) throw new Error(`${at} looks like a credential; an install manifest is public and never carries one`);
		if (typeof x === "string" && URL_CREDENTIAL.test(x)) throw new Error(`${at} is a URL that carries a credential; an install manifest is public and never carries one`);
		if (typeof x === "string" && /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(x)) throw new Error(`${at} holds a GitHub token; an install manifest is public and never carries one`);
		if (typeof x === "string" && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(x)) throw new Error(`${at} holds a private key; an install manifest is public and never carries one`);
		if (x && typeof x === "object") refuseSecrets(x, at);
	}
}

/**
 * The installer's options for this manifest, from the environment: `<PREFIX>_HOME`, `_PORT`, `_VERSION`,
 * `_SETUP_TOKEN`, `_GPU`, `_REGISTRY_TOKEN`, `_YES`.
 * @param {ReturnType<typeof checkManifest>} manifest
 * @param {Record<string, string|undefined>} env
 */
export function readOptions(manifest, env) {
	const p = manifest.envPrefix;
	const get = (k) => {
		const v = env[`${p}_${k}`];
		return v == null || v === "" ? null : String(v);
	};
	const port = get("PORT");
	if (port != null && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) throw new Error(`${p}_PORT=${port} is not a port`);
	const version = get("VERSION");
	if (version != null && !/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(version)) throw new Error(`${p}_VERSION=${version} is not a version`);
	const gpu = get("GPU");
	if (gpu != null && gpu !== "0" && gpu !== "1") throw new Error(`${p}_GPU must be 0 or 1`);
	return {
		home: get("HOME"),
		port: port == null ? null : Number(port),
		version: version ?? "latest",
		setupToken: get("SETUP_TOKEN"),
		gpu: gpu == null ? null : gpu === "1",
		registryToken: get("REGISTRY_TOKEN"),
		yes: /^(1|true|yes)$/i.test(get("YES") || "")
	};
}
