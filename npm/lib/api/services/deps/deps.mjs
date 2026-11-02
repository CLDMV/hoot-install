/**
 *
 *	@Project: @cldmv/rummage
 *	@Filename: /src/api/services/deps/deps.mjs
 *	@Date: 2026-06-01T21:01:36-07:00 (1780372896)
 *	@Author: Nate Corcoran <CLDMV>
 *	@Email: <Shinrai@users.noreply.github.com>
 *	-----
 *	@Last modified by: Nate Corcoran <CLDMV> (Shinrai@users.noreply.github.com)
 *	@Last modified time: 2026-10-02T12:38:19-07:00 (1790969899)
 *	-----
 *	@Copyright: Copyright (c) 2013-2026 Catalyzed Motivation Inc. All rights reserved.
 *
 */

/*
 * Host system-deps service. F01 flatten: this file's 12 named exports
 * become api.host.services.deps.{install, register, unregister, query,
 * list, probe, probeAll, installTool, installOptions, cancelInstall,
 * listInstalls, setBroadcaster}.
 *
 * Architecture (was: src/main/system-deps-service.mjs):
 * The host owns the registry. Built-in tools (git, gh, ssh, node) and
 * package managers (winget / choco / scoop / brew / port / apt / dnf /
 * yum / pacman / zypper / apk / emerge / pkg) ship registered by
 * default; extensions add their own via host:deps:register from the
 * ext-host.
 *
 * Sync-cache contract:
 * Preload pushes the initial dep snapshot to the renderer once at
 * boot. Subsequent changes push delta events on `host:deps:changed`.
 * The renderer keeps a local mirror keyed by name; the UI primitive
 * `requires:` prop reads from that mirror synchronously so a button
 * can decide its disabled state at render time without a round-trip.
 *
 * install() returns the same 12-key control-object shape the
 * pre-slothlet `installSystemDepsService` did — keeps backward compat
 * with callers that destructure { register, list, probe, ... } from
 * the return. The leaves are exported at api.host.services.deps.* for
 * new callers; the returned object is the migration-bridge surface.
 *
 * Electron's `ipcMain` + `BrowserWindow` are loaded lazily inside the
 * function bodies that need them so this file can be imported by
 * plain node (tests, slothlet boot) without crashing on the electron
 * CJS module's lack of named exports.
 */

const _isNode = typeof process !== "undefined" && Boolean(process.versions?.node);

let spawn, execFile;
let promisify;
let platform;
let createRequire;
let _require;
let _exec;

if (_isNode) {
	({ spawn, execFile } = await import("node:child_process"));
	({ promisify } = await import("node:util"));
	({ platform } = await import("node:os"));
	({ createRequire } = await import("node:module"));
	_require = createRequire(import.meta.url);
	_exec = promisify(execFile);
}

function _ENSURE_MAIN(fnName) {
	if (!_isNode) {
		throw new Error(
			`@cldmv/rummage deps.${fnName}() is main-process only. ` +
				`Renderer code should use window.host.deps.* (which routes via this service over IPC).`
		);
	}
}

// ────────────────────────────────────────────────────────────────────
// State (module-singleton; non-exported — invisible to slothlet)
// ────────────────────────────────────────────────────────────────────

/*
 * One deps service per process. The state object is mutated in place by
 * the leaves below. Mutation is intentional — the shape is small,
 * bounded, and the cross-leaf sharing makes immutability more trouble
 * than it's worth.
 *
 * Behavioural note: the registry holds BOTH tools and package managers
 * keyed by name. `kind` discriminates them on the entry. PMs and tools
 * use the same probe/snapshot pipeline because they're shaped the same
 * from the registry's perspective.
 */

/* Status-state enum strings — used by the snapshot output. */
const STATE_UNKNOWN = "unknown"; // not yet probed
const STATE_AVAILABLE = "available"; // detected, version known
const STATE_MISSING = "missing"; // probe failed (ENOENT / non-zero exit)

/*
 * Per-platform preference order: when MULTIPLE detected PMs can install a
 * given dep and the caller didn't ask for a specific one, pick the first
 * from this list that satisfies (a) installed, (b) has a command for the
 * dep, (c) isn't elevated unless allowElevated is set. This mirrors what
 * most users prefer in practice (winget on modern Windows, brew on mac,
 * the distro-native PM on Linux).
 */
const PM_PREFERENCE = {
	win32: ["winget", "scoop", "choco"],
	darwin: ["brew", "port"],
	linux: ["apt", "dnf", "yum", "pacman", "zypper", "apk", "emerge"],
	freebsd: ["pkg"]
};

const _state = {
	/** name → spec + status. Tools and package managers live in the same Map. */
	registry: new Map(),
	/** installId → { name, pm, child, buffered, startedAt, command }. */
	activeInstalls: new Map(),
	/** monotonically-incrementing id for active installs. */
	installSeq: 0,
	/** Broadcaster used by _emitChange. Replaceable via setBroadcaster. */
	broadcast: () => {}
};

// ────────────────────────────────────────────────────────────────────
// Built-in tools + package managers
// ────────────────────────────────────────────────────────────────────

/*
 * Static spec tables for the built-in tools (git, gh, ssh, node) and the
 * package managers the host ships registered by default.
 *
 * Each registration is the static spec a tool ships with. The `status`
 * field is filled in by probe() at runtime. `installCommands` is a sparse
 * table keyed by package-manager name; a null value means "the pm exists
 * but this tool isn't easily installed via it" (the UI shows helpUrl
 * instead).
 *
 * `helpUrl` per PM points at the canonical install instructions so users
 * who don't have the PM can open the page (via the in-row external-link
 * button) and follow the official docs.
 */
// Built-in entries reference i18n keys via `{ i18nKey }` descriptors so the
// renderer can resolve them in the user's locale (and re-resolve on locale
// flip). The host bundle declares each key under `host.deps.<name>.*`. The
// service still accepts plain strings from extension-supplied entries
// (`installSystemDepsService({ deps: [...] })`) — passes them through
// unchanged for backwards compat.
const BUILTIN_TOOLS = [
	{
		name: "git",
		kind: "tool",
		displayName: { i18n: { key: "host.deps.git.displayName" } },
		description: { i18n: { key: "host.deps.git.description" } },
		helpUrl: "https://git-scm.com/downloads",
		probeArgs: ["--version"],
		parseVersion: (stdout) => (stdout.match(/git version ([\d.]+)/) || [])[1] || null,
		installCommands: {
			winget: {
				exe: "winget",
				args: ["install", "-e", "--id", "Git.Git", "--accept-source-agreements", "--accept-package-agreements"],
				elevated: false
			},
			choco: { exe: "choco", args: ["install", "-y", "git"], elevated: true },
			scoop: { exe: "scoop", args: ["install", "git"], elevated: false },
			brew: { exe: "brew", args: ["install", "git"], elevated: false },
			port: { exe: "port", args: ["install", "git"], elevated: true },
			apt: { exe: "apt-get", args: ["install", "-y", "git"], elevated: true },
			dnf: { exe: "dnf", args: ["install", "-y", "git"], elevated: true },
			yum: { exe: "yum", args: ["install", "-y", "git"], elevated: true },
			pacman: { exe: "pacman", args: ["-S", "--noconfirm", "git"], elevated: true },
			zypper: { exe: "zypper", args: ["--non-interactive", "install", "git"], elevated: true },
			apk: { exe: "apk", args: ["add", "git"], elevated: true },
			emerge: { exe: "emerge", args: ["--ask=n", "--quiet", "dev-vcs/git"], elevated: true },
			pkg: { exe: "pkg", args: ["install", "-y", "git"], elevated: true }
		}
	},
	{
		name: "gh",
		kind: "tool",
		displayName: { i18n: { key: "host.deps.gh.displayName" } },
		description: { i18n: { key: "host.deps.gh.description" } },
		helpUrl: "https://cli.github.com",
		probeArgs: ["--version"],
		parseVersion: (stdout) => (stdout.match(/gh version ([\d.]+)/) || [])[1] || null,
		installCommands: {
			winget: {
				exe: "winget",
				args: ["install", "-e", "--id", "GitHub.cli", "--accept-source-agreements", "--accept-package-agreements"],
				elevated: false
			},
			choco: { exe: "choco", args: ["install", "-y", "gh"], elevated: true },
			scoop: { exe: "scoop", args: ["install", "gh"], elevated: false },
			brew: { exe: "brew", args: ["install", "gh"], elevated: false },
			// apt / dnf / yum / zypper need a repo added first — see helpUrl.
			apt: null,
			dnf: null,
			yum: null,
			zypper: null,
			pacman: { exe: "pacman", args: ["-S", "--noconfirm", "github-cli"], elevated: true },
			apk: { exe: "apk", args: ["add", "github-cli"], elevated: true },
			emerge: { exe: "emerge", args: ["--ask=n", "--quiet", "dev-vcs/github-cli"], elevated: true },
			pkg: { exe: "pkg", args: ["install", "-y", "gh"], elevated: true }
		}
	},
	{
		name: "ssh",
		kind: "tool",
		displayName: { i18n: { key: "host.deps.ssh.displayName" } },
		description: { i18n: { key: "host.deps.ssh.description" } },
		helpUrl: "https://www.openssh.com/portable.html",
		probeArgs: ["-V"],
		// `ssh -V` prints to stderr, e.g. `OpenSSH_9.6p1, OpenSSL 3.0.13 30 Jan 2024`
		parseVersion: (stdout, stderr) => (((stderr || "") + (stdout || "")).match(/OpenSSH[_ ](\S+)/) || [])[1] || null,
		probeCaptureStderr: true,
		installCommands: {} // shipped with every modern OS by default
	},
	{
		name: "node",
		kind: "tool",
		displayName: { i18n: { key: "host.deps.node.displayName" } },
		description: { i18n: { key: "host.deps.node.description" } },
		helpUrl: "https://nodejs.org",
		probeArgs: ["--version"],
		parseVersion: (stdout) => (stdout.match(/v?([\d.]+)/) || [])[1] || null,
		installCommands: {} // bundled with Electron; the system `node` is informational
	}
];

/*
 * Each package-manager entry is itself a "tool" we probe (so the UI can
 * show which PM is available on the host machine + render the right
 * install command for everything else). The `installViaPm` map (Windows
 * only for now) lets the UI offer a one-shot "install Chocolatey via
 * winget" path when an absent PM CAN be installed by a PM the user
 * already has — most PMs require their own bespoke installer
 * (shell/powershell scripts), but a few have shortcuts and surfacing
 * them here keeps the UX consistent.
 */
const BUILTIN_PMS = [
	{
		name: "winget",
		kind: "pm",
		displayName: { i18n: { key: "host.deps.winget.displayName" } },
		description: { i18n: { key: "host.deps.winget.description" } },
		platforms: ["win32"],
		probeArgs: ["--version"],
		parseVersion: (s) => s.trim().replace(/^v/, "") || null,
		helpUrl: "https://learn.microsoft.com/windows/package-manager/winget/"
	},
	{
		name: "choco",
		kind: "pm",
		displayName: { i18n: { key: "host.deps.choco.displayName" } },
		description: { i18n: { key: "host.deps.choco.description" } },
		platforms: ["win32"],
		probeArgs: ["--version"],
		parseVersion: (s) => (s.match(/[\d.]+/) || [])[0] || null,
		helpUrl: "https://chocolatey.org/install"
	},
	{
		name: "scoop",
		kind: "pm",
		displayName: { i18n: { key: "host.deps.scoop.displayName" } },
		description: { i18n: { key: "host.deps.scoop.description" } },
		platforms: ["win32"],
		probeArgs: ["--version"],
		parseVersion: (s) => (s.match(/v?[\d.]+/) || [])[0] || null,
		helpUrl: "https://scoop.sh"
	},
	{
		name: "brew",
		kind: "pm",
		displayName: { i18n: { key: "host.deps.brew.displayName" } },
		description: { i18n: { key: "host.deps.brew.description" } },
		platforms: ["darwin", "linux"],
		probeArgs: ["--version"],
		parseVersion: (s) => (s.match(/Homebrew ([\d.]+)/) || [])[1] || null,
		helpUrl: "https://brew.sh"
	},
	{
		name: "port",
		kind: "pm",
		displayName: { i18n: { key: "host.deps.port.displayName" } },
		description: { i18n: { key: "host.deps.port.description" } },
		platforms: ["darwin"],
		probeArgs: ["version"],
		parseVersion: (s) => (s.match(/Version: ([\d.]+)/) || [])[1] || null,
		helpUrl: "https://www.macports.org/install.php"
	},
	{
		name: "apt",
		kind: "pm",
		displayName: { i18n: { key: "host.deps.apt.displayName" } },
		description: { i18n: { key: "host.deps.apt.description" } },
		platforms: ["linux"],
		probeArgs: ["--version"],
		parseVersion: (s) => (s.match(/apt ([\d.]+)/) || [])[1] || null,
		probeName: "apt-get",
		helpUrl: "https://wiki.debian.org/Apt"
	},
	{
		name: "dnf",
		kind: "pm",
		displayName: { i18n: { key: "host.deps.dnf.displayName" } },
		description: { i18n: { key: "host.deps.dnf.description" } },
		platforms: ["linux"],
		probeArgs: ["--version"],
		parseVersion: (s) => (s.match(/[\d.]+/) || [])[0] || null,
		helpUrl: "https://docs.fedoraproject.org/en-US/quick-docs/dnf/"
	},
	{
		name: "yum",
		kind: "pm",
		displayName: { i18n: { key: "host.deps.yum.displayName" } },
		description: { i18n: { key: "host.deps.yum.description" } },
		platforms: ["linux"],
		probeArgs: ["--version"],
		parseVersion: (s) => (s.match(/[\d.]+/) || [])[0] || null,
		helpUrl: "https://access.redhat.com/solutions/9934"
	},
	{
		name: "pacman",
		kind: "pm",
		displayName: { i18n: { key: "host.deps.pacman.displayName" } },
		description: { i18n: { key: "host.deps.pacman.description" } },
		platforms: ["linux"],
		probeArgs: ["--version"],
		parseVersion: (s) => (s.match(/Pacman v([\d.]+)/) || [])[1] || null,
		helpUrl: "https://wiki.archlinux.org/title/Pacman"
	},
	{
		name: "zypper",
		kind: "pm",
		displayName: { i18n: { key: "host.deps.zypper.displayName" } },
		description: { i18n: { key: "host.deps.zypper.description" } },
		platforms: ["linux"],
		probeArgs: ["--version"],
		parseVersion: (s) => (s.match(/zypper ([\d.]+)/) || [])[1] || null,
		helpUrl: "https://en.opensuse.org/SDB:Zypper_usage"
	},
	{
		name: "apk",
		kind: "pm",
		displayName: { i18n: { key: "host.deps.apk.displayName" } },
		description: { i18n: { key: "host.deps.apk.description" } },
		platforms: ["linux"],
		probeArgs: ["--version"],
		parseVersion: (s) => (s.match(/apk-tools ([\d.]+)/) || [])[1] || null,
		helpUrl: "https://wiki.alpinelinux.org/wiki/Alpine_Package_Keeper"
	},
	{
		name: "emerge",
		kind: "pm",
		displayName: { i18n: { key: "host.deps.emerge.displayName" } },
		description: { i18n: { key: "host.deps.emerge.description" } },
		platforms: ["linux"],
		probeArgs: ["--version"],
		parseVersion: (s) => (s.match(/Portage ([\d.]+)/) || [])[1] || null,
		helpUrl: "https://wiki.gentoo.org/wiki/Portage"
	},
	{
		name: "pkg",
		kind: "pm",
		displayName: { i18n: { key: "host.deps.pkg.displayName" } },
		description: { i18n: { key: "host.deps.pkg.description" } },
		platforms: ["freebsd"],
		probeArgs: ["--version"],
		parseVersion: (s) => s.trim() || null,
		helpUrl: "https://docs.freebsd.org/en/books/handbook/ports/"
	}
];

// ────────────────────────────────────────────────────────────────────
// Snapshot + registry-write helpers (non-exported)
// ────────────────────────────────────────────────────────────────────

/*
 * `_putEntry(spec)` is the single insertion point into the registry —
 * every leaf that adds (install, register) routes through it so the
 * default status shape, kind defaulting, and spec validation stay in
 * one place.
 *
 * `_snapshotEntry(entry)` produces the renderer-safe shape — strips
 * function fields (parseVersion, etc.), keeps only the data needed by
 * the UI. Called from list/query/probe + the change broadcast.
 *
 * `_emitChange(name)` is the single broadcast point. The active
 * broadcaster lives on _state.broadcast; setBroadcaster swaps it.
 */
// ────────────────────────────────────────────────────────────────────
// Install commands are PINNED (CLDMV/rummage#216)
// ────────────────────────────────────────────────────────────────────

/*
 * What an install may run, per package manager: its own binary — never one a spec names — the install verb with its
 * fixed flags, and package names. Whether it runs elevated is the package manager's, never the spec's. A spec whose
 * install command is anything else is refused when it is declared, so nothing that is not a package-manager install
 * of a package can ever reach the spawn (or sudo / RunAs).
 */
/*
 * A package token is ALLOWLISTED per manager: the grammar of that manager's own package names, never a denylist of
 * shapes to refuse. Every grammar starts with a letter or digit (never an option), has no `:`, no `~`, no `\\`, and no
 * `/` (the one exception: emerge's single `category/name`), so no URL, path or drive letter can be one. A name that ends
 * the way a package FILE or list does (`x.rpm`, `x.NUPKG`, `packages.config`, …), in any letter case, is refused on top,
 * because several managers install a file when an argument is named like one (and Windows matches extensions in any case).
 */
const PACKAGE_FILE = /\.(?:rpm|deb|udeb|apk|nupkg|nuspec|config|xml|ps1|psm1|psd1|bat|cmd|msi|msix|appx|appxbundle|exe|pkg|txz|tbz|tgz|tar|gz|xz|zst|bz2|zip|7z|json|rb|ebuild|dmg)$/i;
/** A manager's name grammar: its own (case-sensitive) body, and never a name a package FILE could have, in any case. */
const _NAME = (body) => {
	const re = new RegExp(`^${body}$`);
	return { test: (p) => !PACKAGE_FILE.test(p) && re.test(p) };
};
const GRAMMAR = Object.freeze({
	// Debian package names: lowercase letters, digits, + - . (Debian policy §5.6.1).
	deb: _NAME("[a-z0-9][a-z0-9+.-]*"),
	// RPM / apk / pkg / MacPorts names: letters, digits, + . _ -.
	rpm: _NAME("[A-Za-z0-9][A-Za-z0-9+._-]*"),
	// Homebrew formulae: lowercase, digits, + . _ - and a versioned `@` (python@3.12); no taps (no `/`).
	brew: _NAME("[a-z0-9][a-z0-9+._-]*(?:@[0-9][0-9.]*)?"),
	// winget package identifiers: dotted Publisher.Package segments.
	winget: _NAME("[A-Za-z0-9][A-Za-z0-9_-]*(?:\\.[A-Za-z0-9][A-Za-z0-9_+-]*)+"),
	// Chocolatey / Scoop ids: letters, digits, . _ -.
	choco: _NAME("[A-Za-z0-9][A-Za-z0-9._-]*"),
	// Arch package names: lowercase, digits, @ . _ + -.
	pacman: _NAME("[a-z0-9][a-z0-9@._+-]*"),
	// Gentoo atoms: an optional `category/` then the name.
	emerge: _NAME("(?:[a-z0-9][a-z0-9+_.-]*/)?[A-Za-z0-9][A-Za-z0-9+_-]*")
});
const PM_INSTALL = Object.freeze({
	winget: { exe: "winget", elevated: false, prefix: ["install", "-e", "--id"], suffix: ["--accept-source-agreements", "--accept-package-agreements"], max: 1, name: GRAMMAR.winget },
	choco: { exe: "choco", elevated: true, prefix: ["install", "-y"], name: GRAMMAR.choco },
	scoop: { exe: "scoop", elevated: false, prefix: ["install"], name: GRAMMAR.choco },
	brew: { exe: "brew", elevated: false, prefix: ["install"], name: GRAMMAR.brew },
	port: { exe: "port", elevated: true, prefix: ["install"], name: GRAMMAR.rpm },
	apt: { exe: "apt-get", elevated: true, prefix: ["install", "-y"], name: GRAMMAR.deb },
	dnf: { exe: "dnf", elevated: true, prefix: ["install", "-y"], name: GRAMMAR.rpm },
	yum: { exe: "yum", elevated: true, prefix: ["install", "-y"], name: GRAMMAR.rpm },
	pacman: { exe: "pacman", elevated: true, prefix: ["-S", "--noconfirm"], name: GRAMMAR.pacman },
	zypper: { exe: "zypper", elevated: true, prefix: ["--non-interactive", "install"], name: GRAMMAR.rpm },
	apk: { exe: "apk", elevated: true, prefix: ["add"], name: GRAMMAR.rpm },
	emerge: { exe: "emerge", elevated: true, prefix: ["--ask=n", "--quiet"], name: GRAMMAR.emerge },
	pkg: { exe: "pkg", elevated: true, prefix: ["install", "-y"], name: GRAMMAR.rpm }
});
/** The longest package token any manager is handed. */
const MAX_NAME_LENGTH = 128;
/** A dependency's own name. */
const DEP_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** The most packages one install names. */
const MAX_PACKAGES = 8;

/**
 * One package manager's install command, checked against what that package manager may run, and normalised to it.
 * @param {string} name — the dependency (for the message)
 * @param {string} pm
 * @param {object|null} cmd — `{ exe, args, elevated? }`, or null (no install through this pm)
 * @returns {{ exe: string, args: string[], elevated: boolean }|null}
 * @throws {Error} for anything but this pm's own binary running its install of package names
 */
function _pinnedCommand(name, pm, cmd) {
	if (cmd == null) return null;
	const pin = PM_INSTALL[pm];
	if (!pin) throw new Error(`system-deps: '${name}' names an install through '${pm}', which is no package manager this host knows`);
	if (cmd.exe !== pin.exe) throw new Error(`system-deps: '${name}' installs through ${pm} with '${cmd.exe}' — ${pm} runs '${pin.exe}' only`);
	const args = Array.isArray(cmd.args) ? cmd.args.map(String) : null;
	const suffix = pin.suffix || [];
	const ok =
		args &&
		args.length > pin.prefix.length + suffix.length &&
		pin.prefix.every((a, i) => args[i] === a) &&
		suffix.every((a, i) => args[args.length - suffix.length + i] === a);
	const packages = ok ? args.slice(pin.prefix.length, args.length - suffix.length) : [];
	if (!ok || !packages.length || packages.length > (pin.max || MAX_PACKAGES) || !packages.every((p) => p.length <= MAX_NAME_LENGTH && pin.name.test(p)))
		throw new Error(`system-deps: '${name}' installs through ${pm} with '${(args || []).join(" ")}' — only '${[...pin.prefix, "<package>", ...suffix].join(" ")}' is allowed, each <package> a ${pm} package name`);
	return { exe: pin.exe, args: [...pin.prefix, ...packages, ...suffix], elevated: pin.elevated };
}

/**
 * A spec as the registry keeps it: its name checked, every install command pinned (see PM_INSTALL). Only a BUILT-IN
 * is a package manager (`kind: "pm"`); every other spec is a tool.
 * @param {object} spec
 * @param {{ builtin?: boolean }} [opts]
 * @returns {object}
 * @throws {Error} for a spec that is not one
 */
function _validSpec(spec, { builtin = false } = {}) {
	if (!spec || typeof spec.name !== "string" || !DEP_NAME.test(spec.name)) throw new Error(`system-deps: a dependency needs a plain name (got ${JSON.stringify(spec?.name)})`);
	if (!builtin && spec.kind && spec.kind !== "tool") throw new Error(`system-deps: '${spec.name}' declares itself a '${spec.kind}' — only rummage's built-ins are package managers`);
	const installCommands = {};
	for (const [pm, cmd] of Object.entries(spec.installCommands || {})) installCommands[pm] = _pinnedCommand(spec.name, pm, cmd);
	return { ...spec, kind: builtin ? spec.kind || "tool" : "tool", installCommands };
}

/**
 * Check a dependency spec as the service would take it (CLDMV/rummage#216): its name, and every install command pinned
 * to its package manager's own binary running its install of package names.
 * @param {object} spec
 * @returns {object} the spec as it would be kept
 * @throws {Error} for a spec that is not valid
 */
export function validateDepSpec(spec) {
	return _validSpec(spec);
}

/** The names rummage's own entries hold — a declared spec never takes one over unless it is the app's own. */
const _builtinNames = () => new Set([...BUILTIN_TOOLS, ...BUILTIN_PMS].map((s) => s.name));

function _putEntry(spec, opts = {}) {
	const valid = _validSpec(spec, opts);
	const merged = {
		...valid,
		status: { state: STATE_UNKNOWN, version: null, path: null, error: null, lastProbedAt: 0 }
	};
	_state.registry.set(spec.name, merged);
	return merged;
}

function _snapshotEntry(entry) {
	return {
		name: entry.name,
		kind: entry.kind,
		displayName: entry.displayName || entry.name,
		description: entry.description || "",
		helpUrl: entry.helpUrl || null,
		platforms: entry.platforms || null,
		installCommands: entry.installCommands || {},
		status: { ...entry.status }
	};
}

function _emitChange(name) {
	const entry = _state.registry.get(name);
	if (!entry) return;
	try {
		_state.broadcast({ name, entry: _snapshotEntry(entry) });
	} catch (err) {
		console.warn(`[system-deps] broadcast for '${name}' failed:`, err?.message || err);
	}
}

// ────────────────────────────────────────────────────────────────────
// Probe runner (non-exported)
// ────────────────────────────────────────────────────────────────────

/*
 * Spawn-and-capture helper used by the probe leaf. One-shot
 * `<name> --version` (or whatever probeArgs says) with a 5s timeout —
 * captures stdout + stderr, runs parseVersion(), classifies the result
 * into STATE_AVAILABLE / STATE_MISSING.
 *
 * `probeCaptureStderr` is the ssh-style escape hatch: some tools print
 * their version banner to stderr AND exit non-zero (older `ssh -V`).
 * For those, execFile rejects, but the version string is still in the
 * caught err.stderr — extract it before classifying as missing.
 */
async function _runProbe(spec) {
	const probeName = spec.probeName || spec.name;
	const args = spec.probeArgs || ["--version"];
	// `probeEnv` (optional): a per-spec env DELTA merged onto process.env for THIS
	// probe only. Lets a dep whose BUNDLED binary needs private shared libraries —
	// e.g. an app-bundled linux qpdf shipped with its own `lib/` that must be on
	// LD_LIBRARY_PATH — probe (and thus report "available") without the caller
	// having to pollute the process env globally, which would risk shadowing system
	// libs for every OTHER probed tool. Absent → inherit process.env unchanged. Kept
	// out of the render-safe snapshot (see _snapshotEntry), so it never leaves main.
	const env = spec.probeEnv ? { ...process.env, ...spec.probeEnv } : undefined;
	try {
		const { stdout, stderr } = await _exec(probeName, args, { timeout: 5000, env });
		const version = spec.parseVersion ? spec.parseVersion(stdout, stderr) || null : (stdout.split("\n")[0] || "").trim();
		return { state: STATE_AVAILABLE, version, path: probeName, error: null, lastProbedAt: Date.now() };
	} catch (err) {
		// stderr-only tools (ssh -V) — execFile may still resolve via stdout/stderr; only
		// truly-not-found errors (ENOENT) or non-zero exit get here.
		if (spec.probeCaptureStderr && err.stderr) {
			const version = spec.parseVersion ? spec.parseVersion(err.stdout, err.stderr) || null : null;
			if (version) return { state: STATE_AVAILABLE, version, path: probeName, error: null, lastProbedAt: Date.now() };
		}
		const reason = err.code === "ENOENT" ? "not on PATH" : err.shortMessage || err.message || String(err);
		return { state: STATE_MISSING, version: null, path: null, error: reason, lastProbedAt: Date.now() };
	}
}

// ────────────────────────────────────────────────────────────────────
// PM detection (non-exported)
// ────────────────────────────────────────────────────────────────────

/*
 * Package-manager selection helpers used by installTool / installOptions.
 *
 * _pickPm() answers "which PM should we use to install this dep?" by
 * intersecting the dep's installCommands map with the registry's set of
 * available PMs, then applying PM_PREFERENCE order. If the caller asked
 * for a specific pm, we validate it instead of silently switching.
 *
 * _rankInstallablePms() answers the same question for the UI's "show all
 * candidate PMs" list — returns every viable option in preference order
 * rather than just the top pick.
 *
 * _applicableForPlatform() is the simple gate at registration time —
 * a windows-only PM is never added to the registry on linux.
 */
function _applicableForPlatform(spec) {
	if (!spec.platforms || !spec.platforms.length) return true;
	return spec.platforms.includes(platform());
}

function _pickPm(dep, options = {}) {
	const cmds = dep.installCommands || {};
	const availablePms = [..._state.registry.values()]
		.filter((e) => e.kind === "pm" && e.status?.state === STATE_AVAILABLE)
		.map((e) => e.name);
	const allowElevated = !!options.allowElevated;
	const ok = (pm) => availablePms.includes(pm) && cmds[pm] && (allowElevated || !cmds[pm].elevated);

	if (options.pm) {
		if (!ok(options.pm)) {
			// If caller asked for a specific PM, surface why we can't use it
			// rather than silently switching to another.
			if (!availablePms.includes(options.pm)) throw new Error(`pm '${options.pm}' is not detected on this host`);
			if (!cmds[options.pm]) throw new Error(`pm '${options.pm}' has no install command for this dep`);
			if (cmds[options.pm].elevated && !allowElevated)
				throw new Error(`pm '${options.pm}' requires elevation; pass allowElevated: true (Stage 3)`);
		}
		return options.pm;
	}

	const order = PM_PREFERENCE[platform()] || [];
	for (const pm of order) if (ok(pm)) return pm;
	// Fallback: any available PM with a non-elevated command (or elevated if allowed).
	for (const pm of availablePms) if (ok(pm)) return pm;
	return null;
}

function _rankInstallablePms(name, { allowElevated = false } = {}) {
	const dep = _state.registry.get(name);
	if (!dep) return [];
	const cmds = dep.installCommands || {};
	const availablePms = new Set(
		[..._state.registry.values()].filter((e) => e.kind === "pm" && e.status?.state === STATE_AVAILABLE).map((e) => e.name)
	);
	const order = PM_PREFERENCE[platform()] || [];
	const ranked = [];
	const seen = new Set();
	for (const pm of order) {
		if (availablePms.has(pm) && cmds[pm] && (allowElevated || !cmds[pm].elevated)) {
			ranked.push({ pm, ...cmds[pm] });
			seen.add(pm);
		}
	}
	// Append any other available PMs not in the preference order.
	for (const pm of availablePms) {
		if (seen.has(pm)) continue;
		if (cmds[pm] && (allowElevated || !cmds[pm].elevated)) ranked.push({ pm, ...cmds[pm] });
	}
	return ranked;
}

// ────────────────────────────────────────────────────────────────────
// IPC broadcast to BrowserWindows (non-exported)
// ────────────────────────────────────────────────────────────────────

/*
 * Send an IPC message to every live BrowserWindow. Used by installTool
 * for the started / output / done streaming events. Higher-level
 * registry change events go through state.broadcast (see install()).
 */
function _broadcastToWindows(channel, payload) {
	// Outside Electron (a node-only host, the tests) there are no windows to tell.
	let wins = [];
	try {
		wins = _require("electron")?.BrowserWindow?.getAllWindows?.() || [];
	} catch {
		wins = [];
	}
	for (const w of wins) {
		if (w && !w.isDestroyed()) {
			try {
				w.webContents.send(channel, payload);
			} catch {
				/* ignore — window dying mid-send is expected */
			}
		}
	}
}

// ────────────────────────────────────────────────────────────────────
// Public surface (exported — slothlet leaves)
// ────────────────────────────────────────────────────────────────────

/**
 * Service installer for the host system-deps subsystem. Called once at
 * process boot from the main bootstrap. Seeds the registry with the
 * built-in tools + platform-applicable PMs, layers any caller-supplied
 * extras on top, registers the `host:deps:*` IPC handlers, and kicks
 * off the initial probe sweep so the renderer has real status the
 * moment it asks.
 *
 * Returns the same control-object shape the pre-slothlet
 * `installSystemDepsService` did — keeps backward compat with callers
 * that destructure { register, list, probe, ... } from the return.
 *
 * @param {object} [opts]
 * @param {Array<object>} [opts.deps]              extra specs to register alongside the built-ins
 * @param {boolean}        [opts.probeAtStart=true] kick off the initial probe immediately
 * @param {(payload) => void} [opts.broadcast]      optional broadcaster for `host:deps:changed`
 *                                                   events (the install fn wires this when given
 *                                                   a window factory).
 * @param {Function} [opts.confirmElevated]          how an elevated install is confirmed (see
 *                                                   setElevatedConfirmer); unset, a native dialog asks.
 * @returns {{ register, unregister, query, list, probe, probeAll, install, cancelInstall, listInstalls, installablePmsFor, getSnapshot, setBroadcaster }}
 */
/**
 * Seed the registry: rummage's built-ins (the platform's package managers among them), then the declared extras — the
 * app's `deps` and the extensions' (CLDMV/rummage#192). The app's own specs may describe a built-in tool its own way
 * (its install commands still pinned); a spec an EXTENSION declares (`contributedBy`) never takes over a built-in. A
 * spec that is not valid is refused here, at start, with its reason — never registered to fail later (CLDMV/rummage#216).
 * Main-side only (no IPC); install() calls it.
 * @param {Array<object>} [extraDeps]
 * @returns {{ admitted: string[], refused: Array<{ name: string|null, reason: string }> }}
 */
export function seedRegistry(extraDeps = []) {
	_ENSURE_MAIN("seedRegistry");
	_state.registry.clear();
	for (const spec of BUILTIN_TOOLS) _putEntry(spec, { builtin: true });
	for (const spec of BUILTIN_PMS) if (_applicableForPlatform(spec)) _putEntry(spec, { builtin: true });
	const builtins = _builtinNames();
	const admitted = [];
	const refused = [];
	for (const spec of Array.isArray(extraDeps) ? extraDeps : []) {
		try {
			if (spec?.contributedBy && builtins.has(spec?.name)) throw new Error(`system-deps: ${spec.contributedBy} declares '${spec.name}', which is one of rummage's built-ins — refused`);
			_putEntry(spec);
			admitted.push(spec.name);
		} catch (err) {
			refused.push({ name: spec?.name ?? null, reason: err?.message || String(err) });
			console.warn(err?.message || err);
		}
	}
	return { admitted, refused };
}

export function install({ deps: extraDeps = [], probeAtStart = true, broadcast, confirmElevated, ipc = null } = {}) {
	_ENSURE_MAIN("install");
	const { ipcMain } = ipc ? { ipcMain: ipc } : _require("electron");
	if (broadcast) setBroadcaster(broadcast);
	if (confirmElevated) setElevatedConfirmer(confirmElevated);

	// Seed built-ins first, then any caller-supplied extras (the caller's
	// spec wins on collision so apps can override tool descriptions).
	seedRegistry(extraDeps);

	/* IPC */
	ipcMain.handle("host:deps:list", () => list());
	ipcMain.handle("host:deps:query", (_e, name) => query(name));
	ipcMain.handle("host:deps:probe", (_e, name) => probe(name));
	ipcMain.handle("host:deps:probeAll", () => probeAll());
	// No renderer registration (CLDMV/rummage#216): what the service knows is declared main-side — rummage's built-ins,
	// the app's `deps`, the extensions' manifests — so a page can never add a spec, its probe, or its install command.
	ipcMain.handle("host:deps:install", (_e, name, options) => installFromPage(name, options));
	ipcMain.handle("host:deps:install:cancel", (_e, installId) => cancelInstall(installId));
	ipcMain.handle("host:deps:install:list", () => listInstalls());
	ipcMain.handle("host:deps:install:options", (_e, name, options) => installOptions(name, options || {}));

	if (probeAtStart) {
		probeAll().catch((err) => console.warn("[system-deps] initial probeAll failed:", err?.message || err));
	}

	return {
		register,
		unregister,
		query,
		list,
		probe,
		probeAll,
		install: installTool,
		cancelInstall,
		listInstalls,
		installablePmsFor: installOptions,
		getSnapshot: list,
		setBroadcaster
	};
}

/**
 * Register a custom tool spec. Used by extensions that need a CLI tool
 * not in the built-in list (e.g. a packrat extension needing
 * `kubectl`). The spec shape matches built-in tools — see BUILTIN_TOOLS
 * above for examples.
 *
 * Newly-registered tools are probed immediately so the renderer doesn't
 * see "unknown" status flash before the first probe completes; the
 * probe runs detached (catches its own errors) so the caller's
 * register() returns synchronously with the initial snapshot.
 *
 * Re-registering an existing name overwrites it but does NOT re-probe
 * — the existing status carries forward. Callers that want a forced
 * re-probe should call probe(name) explicitly.
 *
 * @param {object} spec   Tool spec.
 * @returns {object}      Render-safe snapshot.
 */
export function register(spec) {
	_ENSURE_MAIN("register");
	if (_builtinNames().has(spec?.name)) throw new Error(`system-deps: '${spec?.name}' is one of rummage's built-ins — a registered spec never takes it over`);
	const had = _state.registry.has(spec.name);
	const entry = _putEntry(spec);
	if (!had) {
		// Probe newly-registered tools right away so the renderer sees a
		// real status, not "unknown", as soon as the register call returns.
		probe(spec.name).catch((err) => console.warn(`[system-deps] probe after register('${spec.name}') failed:`, err?.message || err));
	}
	return _snapshotEntry(entry);
}

/**
 * Remove a tool from the registry. Used by extensions when they
 * deactivate / unload — drops the dep so the deps view stops showing
 * it.
 *
 * Broadcasts a removal event (`{ name, entry: null, removed: true }`)
 * so renderer mirrors of the registry can drop the corresponding row.
 *
 * @param {string} name
 * @returns {boolean}  true if a row was actually removed, false if the name wasn't registered.
 */
export function unregister(name) {
	_ENSURE_MAIN("unregister");
	const had = _state.registry.delete(name);
	if (had) {
		try {
			_state.broadcast({ name, entry: null, removed: true });
		} catch (err) {
			console.warn(`[system-deps] unregister broadcast for '${name}' failed:`, err?.message || err);
		}
	}
	return had;
}

/**
 * Look up a single tool / pm by name and return its render-safe
 * snapshot. Synchronous — reads from the in-memory cache the probe
 * leaves keep up to date.
 *
 * Returns `null` for unknown names (rather than throwing) so callers
 * can distinguish "not registered" from "registered but missing".
 *
 * @param {string} name
 * @returns {object|null}
 */
export function query(name) {
	_ENSURE_MAIN("query");
	const entry = _state.registry.get(name);
	return entry ? _snapshotEntry(entry) : null;
}

/**
 * Render-safe snapshot of every registered tool + pm. Synchronous —
 * reads from the in-memory cache.
 *
 * Order matches registration order (Map iteration). Tools are inserted
 * first, then platform-applicable PMs, then any caller-supplied extras
 * (see install()).
 *
 * @returns {Array<object>}
 */
export function list() {
	_ENSURE_MAIN("list");
	return [..._state.registry.values()].map(_snapshotEntry);
}

/**
 * Probe a single tool / pm — spawn its probeArgs, update the cached
 * status, broadcast the change, return the post-probe snapshot.
 *
 * Returns `null` for unknown names. Probe errors don't throw: they
 * land as status.state = STATE_MISSING with an error string — that's
 * the data the UI wants to show, not a thrown exception to swallow.
 *
 * @param {string} name
 * @returns {Promise<object|null>}
 */
export async function probe(name) {
	_ENSURE_MAIN("probe");
	const entry = _state.registry.get(name);
	if (!entry) return null;
	entry.status = await _runProbe(entry);
	_emitChange(name);
	return _snapshotEntry(entry);
}

/**
 * Probe every registered tool + pm in parallel. Called once at boot
 * (when install() sees probeAtStart) and on-demand from the UI's
 * "refresh all" button.
 *
 * Each per-tool probe is independent — one slow `gh --version` doesn't
 * block the others. The 5s timeout in _runProbe caps worst case.
 *
 * @returns {Promise<Array<object>>}
 */
export async function probeAll() {
	_ENSURE_MAIN("probeAll");
	const names = [..._state.registry.keys()];
	await Promise.all(names.map((n) => probe(n)));
	return list();
}

/**
 * An install a page asked for over `host:deps:install` (CLDMV/rummage#503). Terminal mode is the main-side installer's
 * alone, so a page's `terminal` is dropped (an elevated install from a page always supplies its sudo password), and the
 * answer is only what structured-clones: `{ installId, pm, command }` — the `done` promise stays in the main process;
 * a page follows the install through the `host:deps:install:*` events.
 * @param {string} name
 * @param {object} [options]
 * @returns {Promise<{ installId: number, pm: string, command: string }>}
 */
export async function installFromPage(name, options) {
	const { terminal: _terminal, ...rest } = options && typeof options === "object" ? options : {};
	const { installId, pm, command } = await installTool(name, rest);
	return { installId, pm, command };
}

/**
 * Run the install command for a single tool. Picks the best available
 * PM (or honours an explicit options.pm), spawns the install, streams
 * stdout / stderr to every renderer window via IPC, and re-probes the
 * tool on exit so the UI badge flips missing → installed.
 *
 * Three runtime paths via the elevation branch:
 *   Linux / macOS:   prepend `sudo -S -p ""`, write password+\n to
 *                    stdin. Output streams normally. Caller MUST pass
 *                    options.password — without it we throw early.
 *   Windows:         shell out to powershell `Start-Process … -Verb
 *                    RunAs -Wait` which triggers UAC. The elevated
 *                    child runs detached (own console), so its output
 *                    isn't captured — we only see the exit code. UI
 *                    notes this with `outputCaptured: false` on the
 *                    started event.
 *   No elevation:    spawn directly. Output streams normally.
 *
 * Note on naming: the exported function is `installTool` (not `install`)
 * so it doesn't collide with the service installer `install()` that
 * boots the registry + IPC handlers. The install() return object
 * re-exposes this as `.install` for backward compat with consumers that
 * destructure { install } from the service handle.
 *
 * Returns `{ installId, pm, command }` immediately — the caller polls
 * via the streaming events for output / completion.
 *
 * @param {string} name
 * @param {object} [options]
 * @param {string} [options.pm]                Force a specific PM (validated).
 * @param {boolean} [options.allowElevated]    Permit elevation paths.
 * @param {string} [options.password]          Sudo password on linux/mac when elevated.
 * @param {boolean} [options.terminal]          A terminal program (the self-hosting installer, CLDMV/rummage#472): the
 *                                              install inherits the terminal, so `sudo` asks for the password itself on
 *                                              linux/mac (the caller never sees it) and the output goes straight to the
 *                                              terminal. Running as root, an elevated command runs without sudo.
 * @returns {Promise<{installId: number, pm: string, command: string, done: Promise<{ code: number|null, signal: string|null, ok: boolean, error?: string, status?: object|null }>}>}
 *   `done` settles (never rejects) when the install exits.
 */
export async function installTool(name, options = {}) {
	_ENSURE_MAIN("installTool");
	const dep = _state.registry.get(name);
	if (!dep) throw new Error(`system-deps.install: unknown dep '${name}'`);

	const pm = _pickPm(dep, options);
	if (!pm) {
		// Give the caller something actionable — list what we COULD use if
		// elevation were allowed, so the UI can surface a Stage-3 affordance.
		const elevated = _rankInstallablePms(name, { allowElevated: true })
			.filter((c) => c.elevated)
			.map((c) => c.pm);
		const detail = elevated.length
			? `No non-elevated install path detected. Elevated options available (pass allowElevated:true): ${elevated.join(", ")}`
			: "No detected package manager can install this dependency on the current host.";
		throw new Error(`system-deps.install('${name}'): ${detail}`);
	}

	const cmd = dep.installCommands[pm];
	const installId = ++_state.installSeq;
	const fullCommand = `${cmd.exe} ${cmd.args.join(" ")}`;

	let actualExe,
		actualArgs,
		writePassword = false,
		outputCaptured = true;
	// An ELEVATED install runs only once the person at the machine has confirmed it in a native dialog the main
	// process raises, naming the exact command (CLDMV/rummage#216) — never on a page's say-so alone.
	if (cmd.elevated && !(await _confirmElevated({ name, pm, command: `${cmd.exe} ${cmd.args.join(" ")}` }))) {
		try {
			if (options) options.password = "";
		} catch {}
		throw new Error(`system-deps.install('${name}'): the administrator install was not confirmed`);
	}
	const terminal = options.terminal === true;
	const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
	if (cmd.elevated && terminal && (platform() === "linux" || platform() === "darwin")) {
		// The terminal's own sudo prompt (or none as root): no password passes through this process.
		actualExe = isRoot ? cmd.exe : "sudo";
		actualArgs = isRoot ? cmd.args : ["--", cmd.exe, ...cmd.args];
		outputCaptured = false;
	} else if (cmd.elevated) {
		const plat = platform();
		if (plat === "linux" || plat === "darwin") {
			if (typeof options.password !== "string" || options.password === "") {
				throw new Error(`system-deps.install('${name}') via ${pm} requires sudo. Pass options.password.`);
			}
			actualExe = "sudo";
			actualArgs = ["-S", "-p", "", cmd.exe, ...cmd.args];
			writePassword = true;
		} else if (plat === "win32") {
			// PowerShell -Verb RunAs gives the UAC prompt. ArgumentList items
			// are quoted via PowerShell array literal; escape any single
			// quotes inside each arg.
			const psQ = (s) => `'${String(s).replace(/'/g, "''")}'`;
			const argList = cmd.args.map(psQ).join(",");
			actualExe = "powershell.exe";
			actualArgs = [
				"-NoProfile",
				"-NonInteractive",
				"-ExecutionPolicy",
				"Bypass",
				"-Command",
				`Start-Process -FilePath ${psQ(cmd.exe)} -ArgumentList ${argList} -Verb RunAs -Wait -PassThru | ForEach-Object { exit $_.ExitCode }`
			];
			outputCaptured = false;
		} else {
			throw new Error(`system-deps.install('${name}'): elevation not implemented on platform '${plat}'`);
		}
	} else {
		actualExe = cmd.exe;
		actualArgs = cmd.args;
		if (terminal) outputCaptured = false;
	}

	// Spawn — no shell, args array, captures stdout + stderr separately so
	// the renderer can colour-code them in the streaming output panel
	// (when outputCaptured; UAC installs skip the streaming).
	let child;
	try {
		child = spawn(actualExe, actualArgs, { stdio: terminal ? "inherit" : ["pipe", "pipe", "pipe"], shell: false });
	} catch (err) {
		throw new Error(`system-deps.install('${name}'): spawn failed: ${err?.message || err}`);
	}

	// Pipe the sudo password to stdin once spawned; then immediately
	// destroy stdin so the child doesn't sit waiting on additional input.
	// Zero the local before garbage-collection takes its time.
	if (writePassword) {
		try {
			child.stdin.write(options.password + "\n");
			child.stdin.end();
		} catch (err) {
			try {
				child.kill();
			} catch {}
			throw new Error(`system-deps.install('${name}'): write password failed: ${err?.message || err}`);
		} finally {
			// Best-effort scrub. JS doesn't give us deterministic zeroing;
			// this just removes the long-lived reference quickly.
			try {
				options.password = "";
			} catch {}
		}
	} else if (!terminal) {
		try {
			child.stdin.end();
		} catch {}
	}

	const entry = { installId, name, pm, command: fullCommand, child, buffered: { stdout: "", stderr: "" }, startedAt: Date.now() };
	_state.activeInstalls.set(installId, entry);

	_broadcastToWindows("host:deps:install:started", {
		installId,
		name,
		pm,
		command: fullCommand,
		elevated: !!cmd.elevated,
		outputCaptured
	});

	const _push = (stream, chunk) => {
		const text = chunk.toString("utf8");
		entry.buffered[stream] += text;
		// Cap the buffered tail so long installs don't balloon main RSS.
		const MAX = 64 * 1024;
		if (entry.buffered[stream].length > MAX) entry.buffered[stream] = entry.buffered[stream].slice(-MAX);
		_broadcastToWindows("host:deps:install:output", { installId, stream, chunk: text });
	};
	child.stdout?.on("data", (c) => _push("stdout", c));
	child.stderr?.on("data", (c) => _push("stderr", c));

	let settle;
	const done = new Promise((r) => (settle = r));

	child.on("error", (err) => {
		_state.activeInstalls.delete(installId);
		const result = {
			installId,
			name,
			pm,
			code: -1,
			signal: null,
			ok: false,
			error: err?.message || String(err)
		};
		_broadcastToWindows("host:deps:install:done", result);
		settle(result);
	});

	child.on("exit", async (code, signal) => {
		_state.activeInstalls.delete(installId);
		// Re-probe + emit done with the post-install status so the UI can
		// flip the dep's badge from missing → installed without a second
		// round-trip.
		let status = null;
		try {
			status = await probe(name);
		} catch {
			/* probe broadcast already emitted */
		}
		const result = {
			installId,
			name,
			pm,
			code,
			signal,
			ok: code === 0,
			status
		};
		_broadcastToWindows("host:deps:install:done", result);
		settle(result);
	});

	return { installId, pm, command: fullCommand, done };
}

/** The main-side confirmation an elevated install needs (replaceable by the host and by tests). */
let _confirmer = null;

/**
 * Set how an elevated install is confirmed: `(request) => Promise<boolean>`, given `{ name, pm, command }`. Main-side
 * only — never reachable from a renderer. Unset, a native Electron dialog asks.
 * @param {((request: { name: string, pm: string, command: string }) => Promise<boolean>)|null} fn
 */
export function setElevatedConfirmer(fn) {
	_ENSURE_MAIN("setElevatedConfirmer");
	_confirmer = typeof fn === "function" ? fn : null;
}

/** Ask the person at the machine, natively, whether to run this exact command with administrator rights. */
async function _confirmElevated(request) {
	if (_confirmer) return (await _confirmer(request)) === true;
	try {
		const { dialog } = _require("electron");
		const r = await dialog.showMessageBox({
			type: "warning",
			buttons: ["Cancel", "Install"],
			defaultId: 0,
			cancelId: 0,
			noLink: true,
			title: "Administrator install",
			message: `Install ${request.name} with administrator rights?`,
			detail: `This runs:\n\n${request.command}\n\nthrough ${request.pm}. Only continue if you started this install.`
		});
		return r?.response === 1;
	} catch (err) {
		console.warn(`[system-deps] the administrator install of '${request.name}' could not be confirmed: ${err?.message || err}`);
		return false;
	}
}

/**
 * Enumerate which package managers can install a given tool, ranked
 * by platform preference. The UI uses this to render a "choose how to
 * install" dropdown when more than one PM is viable, and to surface
 * helpful "the only option requires elevation" hints when the
 * non-elevated set is empty.
 *
 * Pass `allowElevated: true` to include elevated commands in the
 * result; default is false so callers without an elevation strategy
 * get only commands they can run today.
 *
 * Returns `[]` for unknown names (rather than throwing) so the UI can
 * treat "no installable PMs" and "name doesn't exist" the same way.
 *
 * @param {string} name
 * @param {object} [options]
 * @param {boolean} [options.allowElevated=false]
 * @returns {Array<{pm: string, exe: string, args: string[], elevated: boolean}>}
 */
export function installOptions(name, options = {}) {
	_ENSURE_MAIN("installOptions");
	return _rankInstallablePms(name, options);
}

/**
 * Cancel an in-flight install by sending SIGTERM to the spawned child.
 * The child's exit handler will fire and emit the standard
 * `host:deps:install:done` event, so renderers see the install
 * conclude through the normal channel (with whatever exit code the
 * child reports after termination).
 *
 * @param {number} installId
 * @returns {boolean}  true if a matching active install was found and a kill was attempted, false if the installId is unknown.
 */
export function cancelInstall(installId) {
	_ENSURE_MAIN("cancelInstall");
	const entry = _state.activeInstalls.get(installId);
	if (!entry) return false;
	try {
		entry.child.kill("SIGTERM");
	} catch (err) {
		console.warn(`[system-deps] cancel ${installId} kill failed:`, err?.message || err);
	}
	return true;
}

/**
 * Render-safe snapshot of every currently-active install. Used by the
 * UI to show progress / cancel buttons for installs that started
 * before the renderer connected (so it can pick up the existing
 * stream rather than missing the started event).
 *
 * Strips the `child` ChildProcess and the `buffered` tail — both are
 * internal state callers don't need (the tail is replayed via output
 * events; the child is just a process handle).
 *
 * @returns {Array<{installId: number, name: string, pm: string, command: string, startedAt: number}>}
 */
export function listInstalls() {
	_ENSURE_MAIN("listInstalls");
	return [..._state.activeInstalls.values()].map((e) => ({
		installId: e.installId,
		name: e.name,
		pm: e.pm,
		command: e.command,
		startedAt: e.startedAt
	}));
}

/**
 * Swap the broadcaster used by registry change events. The install
 * leaf accepts an `opts.broadcast` at boot, but callers that don't
 * have the broadcast function ready until later (e.g. window factory
 * not yet created) can call setBroadcaster() once it exists.
 *
 * Passing null / falsy resets to the no-op default so a deactivating
 * host doesn't leak listeners.
 *
 * @param {((payload: any) => void)|null|undefined} fn
 */
export function setBroadcaster(fn) {
	_ENSURE_MAIN("setBroadcaster");
	_state.broadcast = fn || (() => {});
}
