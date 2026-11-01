// Host half of dsh-cookie-guard.
//
// The Windows scheduled task "DSH Cookie Weekly Check" is only useful while the
// user wants it, so its enabled state follows this plugin's lifetime:
//   plugin loads  -> schtasks /Change /TN ... /ENABLE
//   plugin unloads -> schtasks /Change /TN ... /DISABLE
//
// Enabling/disabling the plugin in the DSH plugin list is therefore the switch.
// Everything here is best-effort: a missing task or a refused schtasks call must
// never break plugin loading.
//
// `last-load.json` next to this package records that the host really loaded the
// plugin (and what schtasks answered), which is the only visible proof available
// from outside the app.

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const name = "cookie-guard";
export const PACKAGE_NAME = "dsh-cookie-guard";

const TASK_NAME = "DSH Cookie Weekly Check";
const MARKER = join(
	homedir(),
	".dsh",
	"profiles",
	"desktop",
	"plugins",
	"dsh-cookie-guard",
	"last-load.json",
);

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
			{ windowsHide: true, timeout: 15000 },
			(error, stdout, stderr) => {
				resolve({
					ok: !error,
					text: `${stdout ?? ""}${stderr ?? ""}`.trim(),
				});
			},
		);
	});
}

async function setTaskState(enabled) {
	const verb = enabled ? "/ENABLE" : "/DISABLE";
	const result = await runSchtasks(["/Change", "/TN", TASK_NAME, verb]);
	const state = enabled ? "enabled" : "disabled";
	if (result.ok) {
		console.log(`[cookie-guard] weekly task ${state}`);
	} else {
		console.warn(
			`[cookie-guard] could not ${enabled ? "enable" : "disable"} "${TASK_NAME}": ${result.text || "unknown error"}`,
		);
	}
	stamp(enabled ? "loaded" : "unloaded", {
		task: state,
		schtasks_ok: result.ok,
		// schtasks 输出是系统 OEM 代码页的本地化文本；只留 ASCII，避免 markdown 里出现乱码
		schtasks_said: result.text.replace(/[^\x20-\x7E]+/g, " ").trim().slice(0, 200),
	});
	return result.ok;
}

export function apply(ctx) {
	ctx.effect(
		() => {
			// Fire and forget: loading must not wait on Task Scheduler.
			void setTaskState(true);

			return () => {
				void setTaskState(false);
			};
		},
		"cookie-guard: weekly task follows plugin lifetime",
	);
}
