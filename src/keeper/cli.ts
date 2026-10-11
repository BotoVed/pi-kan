#!/usr/bin/env node
// kan-keeper install|run|status|stop — установка systemd-user-юнита и управление.

import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const UNIT = "kan-keeper.service";

function unitPath(): string {
  return join(homedir(), ".config", "systemd", "user", UNIT);
}

function cliPath(): string {
  // абсолютный путь к этому файлу (запускаем нативным node с type-stripping)
  return fileURLToPath(import.meta.url);
}

function systemctl(...args: string[]): number {
  const r = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  return r.status ?? 1;
}

async function cmdInstall(): Promise<number> {
  mkdirSync(dirname(unitPath()), { recursive: true });
  writeFileSync(
    unitPath(),
    `[Unit]
Description=pi-kan keeper (хранитель борды Kan.bn)
After=network-online.target

[Service]
ExecStart=${process.execPath} ${cliPath()} run
Environment=PATH=${homedir()}/.pi/agent/bin:${homedir()}/.local/bin:${homedir()}/.local/share/pi-node/current/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`,
  );
  systemctl("daemon-reload");
  const code = systemctl("enable", "--now", UNIT);
  console.log(`юнит: ${unitPath()}`);
  console.log(`журнал: journalctl --user -u ${UNIT} -f`);
  return code;
}

async function cmdStatus(): Promise<number> {
  const installed = existsSync(unitPath());
  console.log(`юнит: ${installed ? unitPath() : "не установлен (kan-keeper install)"}`);
  const st = spawnSync("systemctl", ["--user", "is-active", UNIT], { encoding: "utf8" });
  console.log(`systemd: ${(st.stdout ?? "").trim() || "?"}`);
  try {
    const { loadHostConfig } = await import("../config.ts");
    const { loadState } = await import("../state.ts");
    const { activeLocks } = await import("./wake.ts");
    const host = loadHostConfig();
    const state = loadState(host.kanRoot);
    const boards = Object.entries(state.boards);
    console.log(`борд с конфиг-карточкой: ${boards.length}`);
    for (const [id, bs] of boards) {
      console.log(`  ${id}: карточек ${Object.keys(bs.cards).length}, в очереди ${Object.keys(bs.pending ?? {}).length}`);
    }
    const locks = activeLocks(host.kanRoot);
    console.log(`активных сессий: ${locks.length}`);
    for (const l of locks) console.log(`  ${l.cardPublicId} pid=${l.pid} run=${l.runId} с ${l.startedAt}`);
  } catch (e) {
    console.log(`(состояние недоступно: ${(e as Error).message})`);
  }
  return 0;
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "run";
  switch (cmd) {
    case "run": {
      const { runDaemon } = await import("./daemon.ts");
      await runDaemon();
      break;
    }
    case "install":
      process.exit(await cmdInstall());
      break;
    case "status":
      process.exit(await cmdStatus());
      break;
    case "stop":
      process.exit(systemctl("stop", UNIT));
      break;
    case "start":
      process.exit(systemctl("start", UNIT));
      break;
    case "uninstall":
      systemctl("disable", "--now", UNIT);
      spawnSync("rm", ["-f", unitPath()]);
      systemctl("daemon-reload");
      console.log("снят");
      break;
    default:
      console.log("использование: kan-keeper [run|install|status|start|stop|uninstall]");
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
