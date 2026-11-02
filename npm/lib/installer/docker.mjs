/**
 *
 *	@Project: @cldmv/rummage
 *	@Filename: /src/installer/docker.mjs
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
 * Docker on the host (CLDMV/rummage#472): the engine, the compose plugin, permission to use them, which daemon answers
 * (rootless or rootful), and the NVIDIA runtime. Probing and installing go through rummage's system-deps service
 * (src/api/services/deps), so the commands it may run are pinned to each package manager's own install of package
 * names, an elevated one is confirmed in the terminal first, and `sudo` asks for its password itself. What cannot be
 * automated (Docker Desktop on macOS, WSL2 on Windows, the docker group, the NVIDIA toolkit's repository) is explained
 * step by step instead.
 *
 * Node builtins only (the deps service is too).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** The specs the installer hands the deps service. Distribution packages only; no vendor install scripts. */
export const DOCKER_SPECS = [
	{
		name: "docker",
		displayName: "Docker Engine",
		description: "The container engine the app runs in.",
		helpUrl: "https://docs.docker.com/engine/install/",
		probeArgs: ["--version"],
		parseVersion: (stdout) => (stdout.match(/Docker version ([\d.]+)/) || [])[1] || null,
		installCommands: {
			apt: { exe: "apt-get", args: ["install", "-y", "docker.io", "docker-compose-v2"] },
			dnf: { exe: "dnf", args: ["install", "-y", "moby-engine", "docker-compose"] },
			pacman: { exe: "pacman", args: ["-S", "--noconfirm", "docker", "docker-compose"] },
			zypper: { exe: "zypper", args: ["--non-interactive", "install", "docker", "docker-compose"] },
			apk: { exe: "apk", args: ["add", "docker", "docker-cli-compose"] },
			winget: { exe: "winget", args: ["install", "-e", "--id", "Docker.DockerDesktop", "--accept-source-agreements", "--accept-package-agreements"] }
		}
	},
	{
		name: "docker-compose",
		displayName: "Docker Compose plugin",
		description: "`docker compose`, which starts the app from its compose file.",
		helpUrl: "https://docs.docker.com/compose/install/linux/",
		probeName: "docker",
		probeArgs: ["compose", "version"],
		parseVersion: (stdout) => (stdout.match(/v?(\d+\.\d+\.\d+)/) || [])[1] || null,
		installCommands: {
			apt: { exe: "apt-get", args: ["install", "-y", "docker-compose-v2"] },
			dnf: { exe: "dnf", args: ["install", "-y", "docker-compose"] },
			pacman: { exe: "pacman", args: ["-S", "--noconfirm", "docker-compose"] },
			zypper: { exe: "zypper", args: ["--non-interactive", "install", "docker-compose"] },
			apk: { exe: "apk", args: ["add", "docker-cli-compose"] }
		}
	}
];

/**
 * What `docker version` says about the daemon: reachable, refused (permission), not running, or no docker at all.
 * @param {(args: string[], o?: object) => Promise<{ code: number, stdout: string, stderr: string, error?: string }>} docker
 * @returns {Promise<{ state: "ok"|"permission"|"stopped"|"missing"|"error", version?: string, detail?: string }>}
 */
export async function engineState(docker) {
	const r = await docker(["version", "--format", "{{.Server.Version}}"]);
	if (r.code === 0 && r.stdout.trim()) return { state: "ok", version: r.stdout.trim() };
	if (r.error === "ENOENT") return { state: "missing" };
	const err = `${r.stderr}\n${r.stdout}`;
	if (/permission denied/i.test(err)) return { state: "permission", detail: err.trim().split("\n").pop() };
	if (/cannot connect|is the docker daemon running|error during connect|pipe.*docker_engine|no such file or directory/i.test(err)) return { state: "stopped", detail: err.trim().split("\n").pop() };
	return { state: "error", detail: err.trim().split("\n").slice(-2).join(" ") };
}

/**
 * The compose plugin's version, or null.
 * @param {(args: string[]) => Promise<{ code: number, stdout: string }>} docker
 */
export async function composeVersion(docker) {
	const r = await docker(["compose", "version", "--short"]);
	return r.code === 0 && r.stdout.trim() ? r.stdout.trim().replace(/^v/, "") : null;
}

/**
 * Which daemon `docker` talks to, and whether both a rootless and a rootful one exist (the installer then says which
 * one it uses and how to pick the other).
 * @param {(args: string[]) => Promise<{ code: number, stdout: string }>} docker
 * @param {{ env?: Record<string,string|undefined>, platform?: string, exists?: (p: string) => boolean }} [o]
 */
export async function daemonInfo(docker, { env = process.env, platform = process.platform, exists = existsSync } = {}) {
	const ctx = await docker(["context", "show"]);
	const info = await docker(["info", "--format", "{{json .SecurityOptions}}|{{.DockerRootDir}}|{{json .Runtimes}}"]);
	let rootless = false;
	let rootDir = null;
	let runtimes = {};
	if (info.code === 0) {
		const [sec, dir, rt] = info.stdout.trim().split("|");
		rootless = /rootless/.test(sec || "");
		rootDir = dir || null;
		try {
			runtimes = JSON.parse(rt || "{}") || {};
		} catch {
			runtimes = {};
		}
	}
	let both = false;
	if (platform === "linux") {
		const userSock = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "docker.sock") : null;
		both = !!userSock && exists(userSock) && exists("/var/run/docker.sock");
	}
	return { context: ctx.code === 0 ? ctx.stdout.trim() || null : null, rootless, rootDir, nvidia: Object.prototype.hasOwnProperty.call(runtimes, "nvidia"), both };
}

/**
 * Step-by-step instructions for what the installer cannot do itself.
 * @param {"missing"|"permission"|"stopped"|"compose"|"nvidia"|"both"} what
 * @param {{ platform?: string, user?: string, rootless?: boolean }} [o]
 * @returns {string[]}
 */
export function instructions(what, { platform = process.platform, user = process.env.USER || "$USER", rootless = false } = {}) {
	if (what === "missing" && platform === "darwin")
		return [
			"Install Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/",
			"Open it once and accept its licence (Docker Desktop is free for personal use and small businesses; larger organizations need a paid plan).",
			"Wait until it says the engine is running, then run this installer again."
		];
	if (what === "missing" && platform === "win32")
		return [
			"Docker Desktop needs WSL2. In an administrator PowerShell: wsl --install (then reboot if asked).",
			"Install Docker Desktop: https://docs.docker.com/desktop/setup/install/windows-install/ (or let this installer do it with winget).",
			"Open it once and accept its licence (free for personal use and small businesses; larger organizations need a paid plan).",
			"Wait until it says the engine is running, then run this installer again."
		];
	if (what === "missing")
		return [
			"Install Docker Engine for your distribution: https://docs.docker.com/engine/install/",
			"Then make sure the daemon runs: sudo systemctl enable --now docker",
			"Then run this installer again."
		];
	if (what === "permission")
		return [
			`Your account cannot use the Docker daemon. Either add it to the docker group: sudo usermod -aG docker ${user}`,
			"then log out and back in (or run: newgrp docker) and run this installer again;",
			"or run the installer with sudo. Being in the docker group is equivalent to root on this machine."
		];
	if (what === "stopped" && platform === "linux")
		return rootless
			? ["The rootless Docker daemon is not running: systemctl --user enable --now docker", "Then run this installer again."]
			: ["The Docker daemon is not running: sudo systemctl enable --now docker", "Then run this installer again."];
	if (what === "stopped") return ["Docker Desktop is not running. Start it, wait until the engine is running, and run this installer again."];
	if (what === "compose")
		return ["The Docker Compose plugin is missing: https://docs.docker.com/compose/install/linux/", "(Docker Desktop includes it.) Then run this installer again."];
	if (what === "nvidia")
		return [
			"This host has an NVIDIA GPU but Docker cannot use it yet. Install the NVIDIA Container Toolkit:",
			"https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html",
			"then: sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker",
			"and run this installer again to use the GPU (it continues on the CPU now)."
		];
	if (what === "both")
		return [
			"Both a rootless and a rootful Docker daemon exist on this host. The installer uses the one `docker` talks to now (shown above).",
			"To use the other: docker context use rootless (or default), or set DOCKER_HOST, then run this installer again."
		];
	return [];
}

/**
 * Probe and, after a prompt, install a missing tool through the deps service.
 * @param {{ deps: object, name: string, io: object }} o — `deps`: the system-deps service module
 * @returns {Promise<{ installed: boolean, reason?: string }>}
 */
export async function installThroughDeps({ deps, name, io }) {
	const options = deps.installOptions(name, { allowElevated: true });
	if (!options.length) return { installed: false, reason: "no package manager on this host can install it" };
	const pick = options[0];
	const command = `${pick.exe} ${pick.args.join(" ")}`;
	if (!(await io.confirm(`Install ${name} with ${pick.pm} (${command}${pick.elevated ? ", as administrator" : ""})?`, { action: "install" }))) return { installed: false, reason: "declined" };
	// The deps service asks again before an elevated command (naming it), then sudo asks for the password itself.
	deps.setElevatedConfirmer(async (req) => io.confirm(`Run as administrator: ${req.command}?`, { action: "install" }));
	try {
		const started = await deps.installTool(name, { pm: pick.pm, allowElevated: true, terminal: true });
		const result = await started.done;
		if (!result.ok) return { installed: false, reason: result.error || `${pick.pm} exited ${result.code}` };
		return { installed: true };
	} catch (err) {
		return { installed: false, reason: err?.message || String(err) };
	} finally {
		deps.setElevatedConfirmer(null);
	}
}
