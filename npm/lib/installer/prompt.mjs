/**
 *
 *	@Project: @cldmv/rummage
 *	@Filename: /src/installer/prompt.mjs
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
 * The installer's terminal (CLDMV/rummage#472). Questions go to the terminal, never to a pipe: under `curl … | sh`
 * stdin is the script, so the bootstrap starts the installer with stdin from /dev/tty, and on POSIX this module opens
 * /dev/tty itself when stdin is not a terminal. With no terminal at all, a question fails with what to set instead
 * (the `<PREFIX>_…` variables), unless `yes` accepts it.
 *
 * Node builtins only.
 */

import { openSync, closeSync, existsSync } from "node:fs";
import tty from "node:tty";

/**
 * A terminal io: `say`, `warn`, `ask`, `confirm`, `secret`. Tests pass their own.
 * @param {{ yes?: boolean, out?: NodeJS.WriteStream, input?: NodeJS.ReadStream|null }} [o]
 */
export function createIo({ yes = false, out = process.stderr, input } = {}) {
	let ttyIn = input ?? null;
	let fd = null;
	const open = () => {
		if (ttyIn) return ttyIn;
		if (process.stdin.isTTY) return (ttyIn = process.stdin);
		if (process.platform !== "win32" && existsSync("/dev/tty")) {
			try {
				fd = openSync("/dev/tty", "r");
				ttyIn = new tty.ReadStream(fd);
				return ttyIn;
			} catch {
				fd = null;
			}
		}
		return null;
	};
	const line = (s = "") => out.write(`${s}\n`);
	const readLine = (question, { hidden = false } = {}) =>
		new Promise((resolve, reject) => {
			const inp = open();
			if (!inp) return reject(Object.assign(new Error("no terminal to ask on"), { code: "no-tty" }));
			out.write(question);
			let buf = "";
			const raw = hidden && typeof inp.setRawMode === "function";
			if (raw) inp.setRawMode(true);
			inp.setEncoding("utf8");
			inp.resume();
			const done = (err, v) => {
				inp.removeListener("data", onData);
				if (raw) inp.setRawMode(false);
				inp.pause();
				if (err) reject(err);
				else resolve(v);
			};
			const onData = (chunk) => {
				for (const ch of chunk) {
					if (ch === "\r" || ch === "\n") {
						if (hidden) out.write("\n");
						return done(null, buf);
					}
					if (ch === "\u0003") {
						out.write("\n");
						return done(Object.assign(new Error("cancelled"), { code: "cancelled" }));
					}
					if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
					else if (ch >= " ") buf += ch;
				}
			};
			inp.on("data", onData);
		});
	return {
		yes,
		say: (s) => line(s),
		warn: (s) => line(`! ${s}`),
		step: (s) => line(`\n== ${s}`),
		/** A yes/no question; `yes` mode answers yes. */
		async confirm(question, { defaultYes = true } = {}) {
			if (yes) {
				line(`${question} yes (accepted)`);
				return true;
			}
			const a = (await readLine(`${question} [${defaultYes ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
			return a ? a === "y" || a === "yes" : defaultYes;
		},
		/** A free-text question. */
		async ask(question, { defaultValue = "" } = {}) {
			const a = (await readLine(`${question}${defaultValue ? ` [${defaultValue}]` : ""} `)).trim();
			return a || defaultValue;
		},
		/** A hidden answer (a token): not echoed. */
		async secret(question) {
			return (await readLine(`${question} `, { hidden: true })).trim();
		},
		close() {
			if (fd != null) {
				try {
					ttyIn?.destroy?.();
					closeSync(fd);
				} catch {
					/* already closed */
				}
				fd = null;
			}
		}
	};
}
