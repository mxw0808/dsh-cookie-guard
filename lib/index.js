// Host half of dsh-cookie-guard.
//
// Installing the plugin is the whole install: on load this half registers the
// Windows scheduled task "DSH Cookie Weekly Check" (pointing straight at the
// scripts inside this package), and on unload it removes that task again.
// Nothing has to be copied into %USERPROFILE% and no command has to be run by
// hand - `dsh plugin add dsh-cookie-guard` plus a restart is enough.
//
// Every schtasks call is best-effort: a refused or missing task must never break
// plugin loading. `last-load.json` next to this package records what the host
// actually did, which is the only proof visible from outside the app.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "cookie-guard";
export const PACKAGE_NAME = "dsh-cookie-guard";

const TASK_NAME = "DSH Cookie Weekly Check";
const START_TIME = "12:00";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(dirname(HERE), "scripts");
const WEEKLY = join(SCRIPTS, "dsh_cookie_weekly.ps1");
const GUARD = join(SCRIPTS, "dsh_cookie_guard.py");

const MARKER = join(HERE, "last-load.json");

function stamp(event, extra) {
	try {
		mkdirSync(dirname(MARKER), { recursive: true });
		const payload = { event, at: new Date().toISOString(), pid: process.pid, ...extra };
		writeFileSync(MARKER, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	} catch {
		// A missing marker must never break plugin loading.
	}
}

function runSchtasks(args) {
	return new Promise((resolve) => {
		execFile(
			"schtasks",
			args,
			{ windowsHide: true, timeout: 20000 },
			(error, stdout, stderr) => {
				resolve({
					ok: !error,
					text: `${stdout ?? ""}${stderr ?? ""}`.trim(),
				});
			},
		);
	});
}

// schtasks output is localized OEM text; keep ASCII only so the marker stays
// readable in a terminal that is not in the system code page.
function ascii(text) {
	return text.replace(/[^\x20-\x7E]+/g, " ").trim().slice(0, 200);
}

function taskCommand() {
	// The quotes matter: the profile path can contain spaces.
	return `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${WEEKLY}"`;
}

async function createTask() {
	const created = await runSchtasks([
		"/Create",
		"/TN",
		TASK_NAME,
		"/TR",
		taskCommand(),
		"/SC",
		"WEEKLY",
		"/D",
		"MON",
		"/ST",
		START_TIME,
		"/F",
	]);
	if (created.ok) {
		console.log(`[cookie-guard] registered scheduled task "${TASK_NAME}" (weekly, Mon ${START_TIME})`);
		return { ok: true, mode: "created", said: ascii(created.text) };
	}

	// A task may already exist from an earlier install (or from an admin account).
	// Enabling it is still better than doing nothing.
	const enabled = await runSchtasks(["/Change", "/TN", TASK_NAME, "/ENABLE"]);
	if (enabled.ok) {
		console.log(`[cookie-guard] reused existing scheduled task "${TASK_NAME}"`);
		return { ok: true, mode: "enabled-existing", said: ascii(enabled.text) };
	}

	console.warn(
		`[cookie-guard] could not register "${TASK_NAME}": ${ascii(created.text) || "unknown error"}`,
	);
	return { ok: false, mode: "failed", said: ascii(`${created.text} ${enabled.text}`) };
}

async function removeTask() {
	const deleted = await runSchtasks(["/Delete", "/TN", TASK_NAME, "/F"]);
	if (deleted.ok) {
		console.log(`[cookie-guard] removed scheduled task "${TASK_NAME}"`);
		return { ok: true, mode: "deleted", said: ascii(deleted.text) };
	}

	// Deleting can be refused when the task was created by another account;
	// disabling it still stops the weekly run.
	const disabled = await runSchtasks(["/Change", "/TN", TASK_NAME, "/DISABLE"]);
	if (disabled.ok) {
		return { ok: true, mode: "disabled", said: ascii(disabled.text) };
	}

	return { ok: false, mode: "failed", said: ascii(`${deleted.text} ${disabled.text}`) };
}

export function apply(ctx) {
	ctx.effect(
		() => {
			// Fire and forget: loading must not wait on Task Scheduler.
			void (async () => {
				if (process.platform !== "win32") {
					stamp("skipped", { reason: `unsupported platform ${process.platform}` });
					return;
				}
				if (!existsSync(WEEKLY) || !existsSync(GUARD)) {
					console.warn("[cookie-guard] scripts are missing from the package; task not registered");
					stamp("failed", { reason: "scripts missing", weekly: existsSync(WEEKLY), guard: existsSync(GUARD) });
					return;
				}
				const result = await createTask();
				stamp(result.ok ? "loaded" : "failed", {
					task: TASK_NAME,
					mode: result.mode,
					command: taskCommand(),
					schtasks_ok: result.ok,
					schtasks_said: result.said,
				});
			})();

			return () => {
				void (async () => {
					if (process.platform !== "win32") return;
					const result = await removeTask();
					stamp("unloaded", {
						task: TASK_NAME,
						mode: result.mode,
						schtasks_ok: result.ok,
						schtasks_said: result.said,
					});
				})();
			};
		},
		"cookie-guard: weekly task is created and removed with the plugin",
	);
}
