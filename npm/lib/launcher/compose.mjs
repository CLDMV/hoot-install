/**
 *
 *	@Project: @cldmv/rummage
 *	@Filename: /src/launcher/compose.mjs
 *	@Date: 2026-11-01T12:00:00-07:00 (1793559600)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-11-01T12:00:00-07:00 (1793559600)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/*
 * `docker run --rm <image> compose` (CLDMV/rummage#473): print a compose file matched to the image's own version,
 * from the app's install manifest (`install.json` beside the bundle's bundle.json; the installer, CLDMV/rummage#472,
 * reads the same file). Nothing in it is secret: the registry login lives in Docker's credential store, and setup
 * tokens are generated inside the container.
 *
 * install.json:
 *
 *   { "name": "hoot", "image": "ghcr.io/cldmv/hoot", "port": 4668, "volume": "hoot-data", "hostMount": "/host",
 *     "stopGracePeriod": "60s", "gpu": true, "env": { "HOOT_SETUP_TOKEN": "" }, "logging": { "maxSize": "20m", "maxFile": 5 } }
 *
 * Only `name` and `image` are required. `port` defaults to 8080, `volume` to `<name>-data`, `hostMount` (the install
 * folder mounted read-only, where the app looks for its config file) to `/host`. `env` lists variables passed through
 * from the host's environment when set (`- NAME` entries, never values).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const NAME = /^[a-z0-9][a-z0-9_.-]*$/;
const IMAGE = /^[a-z0-9][a-z0-9._/:-]*$/;
const ENVNAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Read and check install.json.
 * @param {string} bundleDir
 */
export function readInstallManifest(bundleDir) {
	let m;
	try {
		m = JSON.parse(readFileSync(join(bundleDir, "install.json"), "utf8"));
	} catch (err) {
		throw new Error(`no readable install.json in ${bundleDir} (${err.code || err.message})`);
	}
	return checkInstallManifest(m);
}

/** Validate an install manifest, filling defaults. */
export function checkInstallManifest(m) {
	if (!m || typeof m !== "object") throw new Error("install.json must be an object");
	if (!NAME.test(String(m.name || ""))) throw new Error(`install.json name ${JSON.stringify(m.name)} must be a lowercase name`);
	if (!IMAGE.test(String(m.image || "")) || /:/.test(String(m.image).split("/").pop())) throw new Error(`install.json image ${JSON.stringify(m.image)} must be an image name without a tag`);
	const port = m.port == null ? 8080 : Number(m.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`install.json port ${m.port} is not a port`);
	const env = Object.keys(m.env || {});
	for (const k of env) if (!ENVNAME.test(k)) throw new Error(`install.json env name ${JSON.stringify(k)} is not a variable name`);
	return {
		name: m.name,
		image: m.image,
		port,
		volume: NAME.test(String(m.volume || "")) ? m.volume : `${m.name}-data`,
		hostMount: typeof m.hostMount === "string" && m.hostMount.startsWith("/") ? m.hostMount : "/host",
		stopGracePeriod: /^\d+[smh]$/.test(String(m.stopGracePeriod || "")) ? m.stopGracePeriod : "60s",
		gpu: m.gpu === true,
		env,
		logging: { maxSize: /^\d+[kmg]$/.test(String(m.logging?.maxSize || "")) ? m.logging.maxSize : "20m", maxFile: Number.isInteger(m.logging?.maxFile) ? m.logging.maxFile : 5 },
		raw: m
	};
}

/**
 * The compose file, as YAML text.
 * @param {ReturnType<typeof checkInstallManifest>} manifest
 * @param {{ version: string, gpu?: boolean, hostPort?: number }} o
 */
export function composeYaml(manifest, { version, gpu = false, hostPort } = {}) {
	if (!/^[0-9A-Za-z][0-9A-Za-z._+-]*$/.test(String(version || ""))) throw new Error(`compose: a version is required (got ${JSON.stringify(version)})`);
	const m = manifest;
	const hp = hostPort ?? m.port;
	if (!Number.isInteger(hp) || hp < 1 || hp > 65535) throw new Error(`compose: host port ${hostPort} is not a port`);
	const lines = [
		`name: ${m.name}`,
		"services:",
		`  ${m.name}:`,
		`    image: ${m.image}:${version}`,
		`    container_name: ${m.name}`,
		"    restart: unless-stopped",
		`    ports: ["${hp}:${m.port}"]`,
		"    volumes:",
		`      - ${m.volume}:/data`,
		`      - ./:${m.hostMount}:ro`
	];
	if (m.env.length) {
		lines.push("    environment:");
		for (const k of m.env) lines.push(`      - ${k}`);
	}
	lines.push(`    stop_grace_period: ${m.stopGracePeriod}`, "    logging:", "      driver: json-file", `      options: { max-size: "${m.logging.maxSize}", max-file: "${m.logging.maxFile}" }`);
	if (gpu) {
		if (!m.gpu) throw new Error(`${m.name} does not support a GPU (install.json gpu is not true)`);
		lines.push("    deploy:", "      resources:", "        reservations:", "          devices:", "            - driver: nvidia", "              count: all", "              capabilities: [gpu]");
	}
	lines.push("volumes:", `  ${m.volume}:`);
	return lines.join("\n") + "\n";
}
