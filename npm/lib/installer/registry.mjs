/**
 *
 *	@Project: @cldmv/rummage
 *	@Filename: /src/installer/registry.mjs
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
 * The registry token for a private image (CLDMV/rummage#472): find the GitHub account it belongs to (no username to
 * type), check its scopes, check it can read the image, and log Docker in with it. The token is only ever sent to
 * api.github.com, to the image's registry, and to `docker login` on stdin; it is never printed, logged or written by
 * the installer (Docker's credential store keeps it; the installer says where).
 *
 * Node builtins only.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const GITHUB_API = "https://api.github.com";

/**
 * Who a GitHub token belongs to, and its classic scopes.
 * @param {string} token
 * @param {{ fetch?: typeof fetch }} [o]
 * @returns {Promise<{ ok: true, login: string, scopes: string[]|null } | { ok: false, reason: string, code: string }>}
 *   `scopes` is null for a token that reports none (a fine-grained token).
 */
export async function githubAccount(token, { fetch: f = globalThis.fetch } = {}) {
	let res;
	try {
		res = await f(`${GITHUB_API}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "rummage-installer" } });
	} catch (err) {
		return { ok: false, code: "network", reason: `could not reach api.github.com (${err?.message || err}); check the network or proxy` };
	}
	if (res.status === 401) return { ok: false, code: "expired", reason: "GitHub refused the token: it is wrong, revoked or expired. Create a new one." };
	if (res.status === 403) return { ok: false, code: "forbidden", reason: "GitHub refused the token (403). It may be blocked by an organization's token policy, or rate limited." };
	if (!res.ok) return { ok: false, code: "github", reason: `GitHub answered ${res.status} for the token` };
	const body = await res.json().catch(() => null);
	if (!body?.login) return { ok: false, code: "github", reason: "GitHub did not say which account the token belongs to" };
	const header = res.headers.get("x-oauth-scopes");
	const scopes = header == null ? null : header.split(",").map((s) => s.trim()).filter(Boolean);
	return { ok: true, login: String(body.login), scopes };
}

/**
 * Does a classic token's scope list cover `needed`? (`write:packages` implies `read:packages`.)
 * @param {string[]} scopes
 * @param {string} needed
 */
export function scopeCovers(scopes, needed) {
	if (scopes.includes(needed)) return true;
	if (needed === "read:packages") return scopes.includes("write:packages") || scopes.includes("delete:packages");
	return false;
}

/**
 * Can these credentials pull `<image>:<tag>`? Asks the registry's token endpoint for a pull token, then the manifest
 * (a HEAD), so an account without access to the package is told apart from a bad token.
 * @param {{ image: string, tag: string, login?: string|null, token?: string|null, fetch?: typeof fetch }} o
 * @returns {Promise<{ ok: boolean, code?: string, reason?: string }>}
 */
export async function canPull({ image, tag, login = null, token = null, fetch: f = globalThis.fetch }) {
	const [host, ...rest] = image.split("/");
	const repo = rest.join("/");
	const headers = { "User-Agent": "rummage-installer" };
	if (token) headers.Authorization = `Basic ${Buffer.from(`${login || "token"}:${token}`).toString("base64")}`;
	let res;
	try {
		res = await f(`https://${host}/token?service=${encodeURIComponent(host)}&scope=${encodeURIComponent(`repository:${repo}:pull`)}`, { headers });
	} catch (err) {
		return { ok: false, code: "network", reason: `could not reach ${host} (${err?.message || err})` };
	}
	if (res.status === 401 || res.status === 403) return { ok: false, code: "refused", reason: `${host} refused the token for ${repo} (expired, or missing read:packages)` };
	if (!res.ok) return { ok: false, code: "registry", reason: `${host} answered ${res.status} for a pull token` };
	const j = await res.json().catch(() => null);
	const bearer = j?.token || j?.access_token;
	if (!bearer) return { ok: false, code: "registry", reason: `${host} answered without a pull token` };
	try {
		res = await f(`https://${host}/v2/${repo}/manifests/${encodeURIComponent(tag)}`, {
			method: "HEAD",
			headers: {
				Authorization: `Bearer ${bearer}`,
				Accept: "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
				"User-Agent": "rummage-installer"
			}
		});
	} catch (err) {
		return { ok: false, code: "network", reason: `could not reach ${host} (${err?.message || err})` };
	}
	if (res.status === 200) return { ok: true };
	if (res.status === 404) return { ok: false, code: "missing", reason: `${image}:${tag} does not exist, or this account cannot see it` };
	if (res.status === 401 || res.status === 403) return { ok: false, code: "denied", reason: `this account cannot read ${image} (ask for access to the package)` };
	return { ok: false, code: "registry", reason: `${host} answered ${res.status} for ${image}:${tag}` };
}

/**
 * `docker login <host> -u <login> --password-stdin`; the token goes on stdin only.
 * @param {{ host: string, login: string, token: string, docker: (args: string[], o?: object) => Promise<{ code: number, stdout: string, stderr: string }> }} o
 */
export async function dockerLogin({ host, login, token, docker }) {
	const r = await docker(["login", host, "--username", login, "--password-stdin"], { input: `${token}\n` });
	if (r.code !== 0) return { ok: false, reason: (r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" ") || `docker login exited ${r.code}` };
	return { ok: true };
}

/**
 * Where Docker keeps the registry credential: a credential helper, or the plain config file.
 * @param {string} host
 * @param {{ env?: Record<string,string|undefined>, home?: string }} [o]
 */
export function credentialStore(host, { env = process.env, home = homedir() } = {}) {
	const file = join(env.DOCKER_CONFIG || join(home, ".docker"), "config.json");
	let cfg = {};
	try {
		cfg = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		/* none yet */
	}
	const helper = cfg.credHelpers?.[host] || cfg.credsStore || null;
	if (helper) return { helper: `docker-credential-${helper}`, file, text: `Docker keeps it in the docker-credential-${helper} credential helper.` };
	return { helper: null, file, text: `Docker keeps it in ${file}, base64-encoded but not encrypted (install a credential helper to change that).` };
}
