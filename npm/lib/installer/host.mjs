/**
 *
 *	@Project: @cldmv/rummage
 *	@Filename: /src/installer/host.mjs
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
 * What the installer needs to know about the host (CLDMV/rummage#472): running commands, the CPU architecture, free
 * disk, an HTTP proxy, a free port, the LAN address to print, and the app folder per OS. Node builtins only.
 */

import { spawn } from "node:child_process";
import { statfsSync, existsSync } from "node:fs";
// network-exempt: an inbound listen probe for a free host port (the installer on the host, never extension code)
import { createServer } from "node:net";
import { homedir, networkInterfaces, arch as osArch, platform as osPlatform } from "node:os";
import { join, resolve } from "node:path";

/**
 * Run a command without a shell; resolves `{ code, stdout, stderr }` (code -1 and `error` when it could not start).
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ input?: string, env?: Record<string,string>, cwd?: string, inherit?: boolean, timeoutMs?: number }} [o]
 */
export function run(cmd, args = [], { input, env, cwd, inherit = false, timeoutMs = 0 } = {}) {
	return new Promise((resolvePromise) => {
		let child;
		try {
			child = spawn(cmd, args, { env: env ?? process.env, cwd, shell: false, windowsHide: true, stdio: inherit ? ["inherit", "inherit", "inherit"] : ["pipe", "pipe", "pipe"] });
		} catch (err) {
			return resolvePromise({ code: -1, stdout: "", stderr: "", error: err?.code || err?.message });
		}
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (c) => (stdout += c));
		child.stderr?.on("data", (c) => (stderr += c));
		let timer = null;
		if (timeoutMs > 0) timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.on("error", (err) => {
			if (timer) clearTimeout(timer);
			resolvePromise({ code: -1, stdout, stderr, error: err?.code || err?.message });
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolvePromise({ code: code ?? -1, stdout, stderr });
		});
		if (!inherit) {
			if (input != null) child.stdin.write(input);
			child.stdin.end();
		}
	});
}

/** Node's arch as a Docker platform arch (amd64, arm64), or the raw value when it is neither. */
export function dockerArch(a = osArch()) {
	return a === "x64" ? "amd64" : a === "arm64" ? "arm64" : a;
}

/**
 * The app folder: `<PREFIX>_HOME`, else `~/.<app>` on Linux and macOS, `%LOCALAPPDATA%\<App>` on Windows.
 * @param {{ home: { posix: string, windows: string } }} manifest
 * @param {string|null} override
 * @param {{ platform?: string, env?: Record<string,string|undefined>, homedir?: string }} [o]
 */
export function appFolder(manifest, override, { platform = osPlatform(), env = process.env, homedir: home = homedir() } = {}) {
	if (override) return resolve(override);
	if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), manifest.home.windows);
	return join(home, manifest.home.posix);
}

/**
 * Free megabytes on the filesystem holding `path` (its nearest existing parent), or null when unknown.
 * @param {string} path
 */
export function freeMb(path) {
	let p = resolve(path);
	while (!existsSync(p)) {
		const up = resolve(p, "..");
		if (up === p) return null;
		p = up;
	}
	try {
		const s = statfsSync(p);
		return Math.floor((Number(s.bavail) * Number(s.bsize)) / (1024 * 1024));
	} catch {
		return null;
	}
}

/** The proxy the environment sets, if any (credentials in it are not printed). */
export function proxyFrom(env = process.env) {
	const v = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || null;
	if (!v) return null;
	try {
		const u = new URL(v);
		return `${u.protocol}//${u.host}`;
	} catch {
		return "(set)";
	}
}

/**
 * Is a TCP port free to bind on every interface?
 * @param {number} port
 * @param {string} [host]
 */
export function portFree(port, host = "0.0.0.0") {
	return new Promise((resolvePromise) => {
		const srv = createServer();
		srv.once("error", () => resolvePromise(false));
		srv.listen({ port, host, exclusive: true }, () => srv.close(() => resolvePromise(true)));
	});
}

/**
 * The port to publish on: `wanted` when free; with `strict` (the person asked for it) nothing else; otherwise the next
 * free port above it.
 * @param {number} wanted
 * @param {{ strict?: boolean, isFree?: (p: number) => Promise<boolean>, tries?: number }} [o]
 * @returns {Promise<{ port: number|null, moved: boolean }>}
 */
export async function pickPort(wanted, { strict = false, isFree = portFree, tries = 50 } = {}) {
	if (await isFree(wanted)) return { port: wanted, moved: false };
	if (strict) return { port: null, moved: false };
	for (let p = wanted + 1; p < Math.min(65536, wanted + 1 + tries); p++) if (await isFree(p)) return { port: p, moved: true };
	return { port: null, moved: false };
}

/**
 * The host's LAN IPv4 address to print in the setup URL (not a loopback, link-local, Docker or VPN bridge address).
 * @param {ReturnType<typeof networkInterfaces>} [ifaces]
 */
export function lanAddress(ifaces = networkInterfaces()) {
	const skip = /^(docker|br-|veth|virbr|cni|flannel|cali|vmnet|vboxnet|zt|tailscale|wg|tun|tap|lo)/i;
	const found = [];
	for (const [name, addrs] of Object.entries(ifaces || {})) {
		for (const a of addrs || []) {
			const v4 = a.family === "IPv4" || a.family === 4;
			if (!v4 || a.internal || a.address.startsWith("169.254.")) continue;
			found.push({ name, address: a.address, preferred: !skip.test(name) });
		}
	}
	const pick = found.find((f) => f.preferred) || found[0];
	return pick ? pick.address : "localhost";
}
