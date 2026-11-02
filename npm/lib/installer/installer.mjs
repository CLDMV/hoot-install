/**
 *
 *	@Project: @cldmv/rummage
 *	@Filename: /src/installer/installer.mjs
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
 * @cldmv/rummage/installer — one command from nothing to a running app container (CLDMV/rummage#472;
 * docs/self-hosting.md "Installer"). One Node implementation behind three entry points: `npx <app>-install`, and the
 * `install.sh` / `install.ps1` bootstraps `rummage installer pack` generates, which only make sure a Node exists
 * (a pinned, checksum-verified portable one when it does not) and then run this.
 *
 * Before the pull: Docker (engine, compose plugin, permission; installed through the deps service after a prompt, or
 * explained), the registry token for a private image (asked on the terminal, its account derived from GitHub, its
 * access to the image checked, `docker login`), the host (architecture, disk, proxy). After the pull: an existing
 * install is never overwritten (reported, or repaired), the port, the GPU (Docker's NVIDIA runtime, not just
 * nvidia-smi), the compose file the image prints for its own version (`docker run --rm <image> compose`, the
 * launcher's, CLDMV/rummage#473), `docker compose up -d`, then a wait until the app answers and the setup address.
 *
 * Node builtins only, so the kit runs before any npm install.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { arch as osArch, platform as osPlatform } from "node:os";
import { fileURLToPath } from "node:url";
import { checkManifest, readOptions } from "./manifest.mjs";
import { createIo } from "./prompt.mjs";
import { run, dockerArch, appFolder, freeMb, proxyFrom, pickPort, lanAddress } from "./host.mjs";
import { githubAccount, scopeCovers, canPull, dockerLogin, credentialStore } from "./registry.mjs";
import { DOCKER_SPECS, engineState, composeVersion, daemonInfo, instructions, installThroughDeps } from "./docker.mjs";

export { checkManifest, readOptions } from "./manifest.mjs";

/** Exit codes: 0 installed (or an existing install reported), 1 failed, 2 stopped with instructions to follow first. */
export const EXIT = { ok: 0, failed: 1, instructions: 2 };

class Stop extends Error {
	constructor(message, code = EXIT.failed, lines = []) {
		super(message);
		this.exitCode = code;
		this.lines = lines;
	}
}

/**
 * Run the installer.
 *
 * @param {object} o
 * @param {object} o.manifest — the parsed install.json
 * @param {Record<string,string|undefined>} [o.env=process.env]
 * @param {object} [o.io] — a terminal io (createIo)
 * @param {(args: string[], opts?: object) => Promise<{ code: number, stdout: string, stderr: string, error?: string }>} [o.docker]
 * @param {typeof fetch} [o.fetch]
 * @param {object} [o.deps] — the system-deps service module (loaded on demand)
 * @param {string} [o.platform]
 * @param {string} [o.arch] — Node's arch name
 * @param {number} [o.waitMs=1200000] — how long to wait for the app to answer
 * @param {number} [o.pollMs=2000]
 * @param {(p: number) => Promise<boolean>} [o.isFree] — port check
 * @param {object} [o.ifaces] — network interfaces (for the LAN address)
 * @returns {Promise<{ code: number, home?: string, url?: string, port?: number, setupToken?: string|null, existing?: boolean }>}
 */
export async function runInstaller(o) {
	const env = o.env ?? process.env;
	const manifest = checkManifest(o.manifest);
	const opts = readOptions(manifest, env);
	const io = o.io ?? createIo({ yes: opts.yes });
	const platform = o.platform ?? osPlatform();
	const fetchImpl = o.fetch ?? globalThis.fetch;
	const docker = o.docker ?? ((args, x = {}) => run("docker", args, x));
	const home = appFolder(manifest, opts.home, { platform, env });
	const secrets = [opts.registryToken].filter(Boolean);
	const logFile = join(home, "install.log");
	const log = (s) => {
		try {
			mkdirSync(home, { recursive: true });
			let line = String(s);
			for (const t of secrets) line = line.split(t).join("***");
			appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
		} catch {
			/* the log is a convenience */
		}
	};
	const say = (s) => {
		io.say(s);
		log(s);
	};
	const warn = (s) => {
		io.warn(s);
		log(`! ${s}`);
	};
	const step = (s) => {
		io.step(s);
		log(`== ${s}`);
	};

	try {
		say(`${manifest.title} installer`);
		say(`Folder: ${home}`);

		// ── The host, part 1: architecture (before anything is installed) ───────────────────────────────────
		const arch = dockerArch(o.arch ?? osArch());
		if (!manifest.arch.includes(arch)) throw new Stop(`${manifest.title} runs on ${manifest.arch.join(" or ")} hosts; this one is ${arch}.`);

		// ── 1. Docker ───────────────────────────────────────────────────────────────────────────────────────
		step("Docker");
		let engine = await engineState(docker);
		if (engine.state === "missing") {
			if (platform === "darwin") throw new Stop("Docker is not installed.", EXIT.instructions, instructions("missing", { platform }));
			const deps = o.deps ?? (await import("../api/services/deps/deps.mjs"));
			deps.seedRegistry(DOCKER_SPECS);
			await deps.probeAll();
			if (platform === "win32") for (const l of instructions("missing", { platform }).slice(0, 1)) say(l);
			const r = await installThroughDeps({ deps, name: "docker", io });
			if (!r.installed) throw new Stop(`Docker is not installed (${r.reason}).`, EXIT.instructions, instructions("missing", { platform }));
			if (platform === "win32") throw new Stop("Docker Desktop was installed.", EXIT.instructions, instructions("missing", { platform }).slice(2));
			engine = await engineState(docker);
		}
		if (engine.state === "permission") throw new Stop("Docker is installed, but this account may not use it.", EXIT.instructions, instructions("permission", { platform, user: env.USER }));
		if (engine.state === "stopped") {
			const d = await daemonInfo(docker, { env, platform });
			throw new Stop("Docker is installed, but its daemon is not running.", EXIT.instructions, instructions("stopped", { platform, rootless: !!env.XDG_RUNTIME_DIR && d.both }));
		}
		if (engine.state !== "ok") throw new Stop(`Docker did not answer: ${engine.detail || engine.state}`);
		say(`Docker Engine ${engine.version}`);
		let compose = await composeVersion(docker);
		if (!compose && platform === "linux") {
			const deps = o.deps ?? (await import("../api/services/deps/deps.mjs"));
			deps.seedRegistry(DOCKER_SPECS);
			await deps.probeAll();
			const r = await installThroughDeps({ deps, name: "docker-compose", io });
			if (r.installed) compose = await composeVersion(docker);
		}
		if (!compose) throw new Stop("The Docker Compose plugin is missing.", EXIT.instructions, instructions("compose", { platform }));
		say(`Docker Compose ${compose}`);
		const daemon = await daemonInfo(docker, { env, platform });
		say(`Daemon: ${daemon.rootless ? "rootless" : "rootful"}${daemon.context ? ` (context ${daemon.context})` : ""}`);
		if (daemon.both) for (const l of instructions("both")) say(`  ${l}`);

		// ── 3. The host, part 2: disk and proxy ─────────────────────────────────────────────────────────────
		step("Host");
		say(`Architecture: ${arch}`);
		const free = freeMb(daemon.rootDir && existsSync(daemon.rootDir) ? daemon.rootDir : home);
		if (free != null) {
			say(`Free disk: ${(free / 1024).toFixed(1)} GB${daemon.rootDir ? ` (${daemon.rootDir})` : ""}`);
			if (free < manifest.minDiskMb) throw new Stop(`${manifest.title} needs at least ${(manifest.minDiskMb / 1024).toFixed(1)} GB free; ${(free / 1024).toFixed(1)} GB is.`);
		}
		const proxy = proxyFrom(env);
		if (proxy) say(`HTTP proxy: ${proxy}. Docker's daemon uses its own proxy settings (https://docs.docker.com/engine/daemon/proxy/); set them there too if pulls fail.`);

		// ── An existing install is never overwritten ────────────────────────────────────────────────────────
		const composeFile = join(home, "compose.yaml");
		const container = await docker(["container", "inspect", "--format", "{{.State.Status}}", manifest.name]);
		const volume = await docker(["volume", "inspect", manifest.volume]);
		const existing = { folder: existsSync(composeFile), container: container.code === 0 ? container.stdout.trim() : null, volume: volume.code === 0 };
		if (existing.folder || existing.container || existing.volume) {
			step("Existing install");
			if (existing.folder) say(`Compose file: ${composeFile}`);
			if (existing.container) say(`Container ${manifest.name}: ${existing.container}`);
			if (existing.volume) say(`Data volume ${manifest.volume}: present`);
			say("An existing install is never overwritten.");
			if (existing.folder && (await io.confirm("Repair it (start it again from its compose file)?", { defaultYes: false, action: "start" }))) {
				const up = await docker(["compose", "-f", composeFile, "up", "-d"], { inherit: true, cwd: home });
				if (up.code !== 0) throw new Stop(`docker compose up failed (exit ${up.code}).`);
				say("Started.");
			} else if (!existing.folder) {
				say(`To reinstall, remove the container and volume yourself first (this deletes ${manifest.title}'s data): docker rm -f ${manifest.name}; docker volume rm ${manifest.volume}`);
			}
			return { code: EXIT.ok, home, existing: true };
		}

		// ── 2. The registry token (private images only) ─────────────────────────────────────────────────────
		const tag = opts.version;
		let token = null;
		if (manifest.registry.private) {
			step("Registry token");
			token = opts.registryToken;
			if (!token) {
				say(`${manifest.image} is private. A classic GitHub token with ${manifest.registry.scope} can download it:`);
				say(`  https://github.com/settings/tokens/new?scopes=${encodeURIComponent(manifest.registry.scope)}&description=${encodeURIComponent(`${manifest.title} install`)}`);
				try {
					token = await io.secret("Token:");
				} catch (err) {
					if (err?.code === "no-tty") throw new Stop(`No terminal to ask for the token on; set ${manifest.envPrefix}_REGISTRY_TOKEN and run the installer again.`);
					throw err;
				}
				if (!token) throw new Stop("A token is needed to download the image.");
				secrets.push(token);
			}
			const acct = await githubAccount(token, { fetch: fetchImpl });
			if (!acct.ok) throw new Stop(acct.reason);
			say(`Token belongs to ${acct.login}`);
			if (acct.scopes && !scopeCovers(acct.scopes, manifest.registry.scope)) throw new Stop(`The token lacks ${manifest.registry.scope} (it has: ${acct.scopes.join(", ") || "no scopes"}). Create one with ${manifest.registry.scope}.`);
			if (!acct.scopes) warn("The token reports no classic scopes (a fine-grained token?). GitHub's container registry needs a classic token; checking access anyway.");
			const pull = await canPull({ image: manifest.image, tag, login: acct.login, token, fetch: fetchImpl });
			if (!pull.ok) throw new Stop(pull.reason);
			say(`It can read ${manifest.image}:${tag}`);
			const login = await dockerLogin({ host: manifest.registry.host, login: acct.login, token, docker });
			if (!login.ok) throw new Stop(`docker login failed: ${login.reason}`);
			say(`Docker is logged in to ${manifest.registry.host}. ${credentialStore(manifest.registry.host, { env }).text}`);
		}

		// ── The pull ────────────────────────────────────────────────────────────────────────────────────────
		step("Image");
		const ref = `${manifest.image}:${tag}`;
		const pulled = await docker(["pull", ref], { inherit: true });
		if (pulled.code !== 0) throw new Stop(`docker pull ${ref} failed (exit ${pulled.code}).`);

		// ── 5. The port ─────────────────────────────────────────────────────────────────────────────────────
		step("Port");
		const wanted = opts.port ?? manifest.port;
		const picked = await pickPort(wanted, { strict: opts.port != null, isFree: o.isFree });
		if (picked.port == null) throw new Stop(opts.port != null ? `Port ${wanted} is taken; set ${manifest.envPrefix}_PORT to a free one.` : `No free port found from ${wanted} up.`);
		say(picked.moved ? `Port ${wanted} is taken; using ${picked.port}.` : `Port ${picked.port}`);

		// ── 6. The GPU ──────────────────────────────────────────────────────────────────────────────────────
		let gpu = false;
		if (manifest.gpu) {
			step("GPU");
			const smi = await run("nvidia-smi", ["-L"]);
			const hasGpu = smi.code === 0 && /GPU \d/.test(smi.stdout);
			if (opts.gpu === false) say(`${manifest.envPrefix}_GPU=0: the CPU it is.`);
			else if (daemon.nvidia) {
				gpu = true;
				say("Docker has the NVIDIA runtime; the GPU will be used.");
			} else if (opts.gpu === true) throw new Stop(`${manifest.envPrefix}_GPU=1 but Docker has no NVIDIA runtime.`, EXIT.instructions, instructions("nvidia"));
			else if (hasGpu) for (const l of instructions("nvidia")) warn(l);
			else say("No NVIDIA GPU; the CPU it is.");
		} else if (opts.gpu === true) warn(`${manifest.title} does not use a GPU; ${manifest.envPrefix}_GPU is ignored.`);

		// ── 7. The compose file, from the image ─────────────────────────────────────────────────────────────
		step("Start");
		const printed = await docker(["run", "--rm", ref, "compose", "--port", String(picked.port), ...(gpu ? ["--gpu"] : [])]);
		if (printed.code !== 0 || !/^services:/m.test(printed.stdout)) throw new Stop(`The image did not print its compose file: ${(printed.stderr || printed.stdout).trim().split("\n").slice(-3).join(" ")}`);
		mkdirSync(home, { recursive: true });
		writeFileSync(composeFile, printed.stdout, { flag: "wx" });
		say(`Wrote ${composeFile}`);
		const upEnv = { ...env };
		const tokenVar = `${manifest.envPrefix}_REGISTRY_TOKEN`;
		const setupVar = `${manifest.envPrefix}_SETUP_TOKEN`;
		if (token) {
			if (manifest.env.includes(tokenVar)) upEnv[tokenVar] = token;
			else warn(`The app will ask for the registry token again in its setup (install.json does not pass ${tokenVar}).`);
		}
		if (opts.setupToken) upEnv[setupVar] = opts.setupToken;
		const up = await docker(["compose", "-f", composeFile, "up", "-d"], { inherit: true, cwd: home, env: upEnv });
		if (up.code !== 0) throw new Stop(`docker compose up failed (exit ${up.code}).`);

		// ── 8. Wait until it answers ────────────────────────────────────────────────────────────────────────
		say(`Waiting for ${manifest.title} to answer (the first start installs its packages; this can take a few minutes)…`);
		const ready = await waitForApp({ port: picked.port, fetch: fetchImpl, waitMs: o.waitMs ?? 20 * 60 * 1000, pollMs: o.pollMs ?? 2000, onStatus: (s) => say(`  ${s}`) });
		const url = `http://${lanAddress(o.ifaces)}:${picked.port}${manifest.setupPath}`;
		if (!ready) {
			warn(`${manifest.title} did not answer within the wait. It may still be installing: docker logs -f ${manifest.name}`);
			say(`Then open: ${url}`);
			return { code: EXIT.failed, home, url, port: picked.port };
		}
		let setupToken = null;
		if (opts.setupToken === "generate") {
			const logs = await docker(["logs", manifest.name]);
			const m = [...`${logs.stdout}\n${logs.stderr}`.matchAll(/Setup token: ([A-Za-z0-9_-]+)/g)].pop();
			setupToken = m ? m[1] : null;
		}
		step("Ready");
		say(`Open ${url} to set up ${manifest.title}.`);
		if (setupToken) say(`Setup token: ${setupToken}`);
		else if (opts.setupToken) say(`Use the setup token you set in ${setupVar}.`);
		else say("The first person to open it claims the install.");
		try {
			chmodSync(logFile, 0o600);
		} catch {
			/* not on every filesystem */
		}
		return { code: EXIT.ok, home, url, port: picked.port, setupToken };
	} catch (err) {
		if (err instanceof Stop) {
			warn(err.message);
			for (const l of err.lines) say(`  ${l}`);
			return { code: err.exitCode, home };
		}
		if (err?.code === "cancelled") {
			warn("Cancelled.");
			return { code: EXIT.failed, home };
		}
		warn(`The installer failed: ${err?.message || err}`);
		return { code: EXIT.failed, home };
	} finally {
		io.close?.();
	}
}

/**
 * Poll the app until `GET /health` answers 200, relaying the launcher's status page messages meanwhile.
 * @param {{ port: number, fetch: typeof fetch, waitMs: number, pollMs: number, onStatus?: (s: string) => void }} o
 * @returns {Promise<boolean>}
 */
export async function waitForApp({ port, fetch: f, waitMs, pollMs, onStatus }) {
	const end = Date.now() + waitMs;
	let last = null;
	while (Date.now() < end) {
		try {
			const res = await f(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
			if (res.status === 200) {
				const j = await res.json().catch(() => null);
				if (!j || j.ok !== false) return true;
			} else await res.body?.cancel?.();
			const st = await f(`http://127.0.0.1:${port}/launcher/status`, { signal: AbortSignal.timeout(5000) });
			if (st.ok) {
				// The launcher's status page (CLDMV/rummage#473): { phase, title, message, progress, error, lines }.
				const j = await st.json().catch(() => null);
				const progress = j?.progress && Number.isFinite(j.progress.total) && j.progress.total > 0 ? ` (${j.progress.done}/${j.progress.total})` : "";
				const msg = j ? `${j.message || j.phase || ""}${progress}`.trim() : null;
				if (msg && msg !== last) {
					last = msg;
					onStatus?.(msg);
				}
				if (j?.phase === "failed") {
					onStatus?.(`failed: ${j.error || j.message || "see the status page"}`);
					return false;
				}
			} else await st.body?.cancel?.();
		} catch {
			/* not listening yet */
		}
		await new Promise((r) => setTimeout(r, pollMs));
	}
	return false;
}

/**
 * The kit's entry: read the install.json the kit carries, run, exit with the installer's code.
 * @param {{ manifestFile?: string }} [o]
 */
export async function main({ manifestFile } = {}) {
	const file = manifestFile ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "install.json");
	let manifest;
	try {
		manifest = JSON.parse(readFileSync(file, "utf8"));
	} catch (err) {
		process.stderr.write(`installer: no readable install.json at ${file} (${err.code || err.message})\n`);
		process.exit(EXIT.failed);
	}
	const r = await runInstaller({ manifest });
	process.exit(r.code);
}
