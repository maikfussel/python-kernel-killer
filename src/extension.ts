import * as vscode from "vscode";
import { exec } from "child_process";

/*
 * Python Kernel Killer
 *
 * Linux-focused VS Code/VSCodium extension.
 *
 * Features:
 * - Lists Python/Jupyter-related processes only
 * - Groups processes into:
 *   - zombie Python processes
 *   - orphan Python processes
 *   - IPython/Jupyter kernels
 *   - JupyterLab servers
 *   - terminal Python processes
 * - Shows PID, CPU usage, memory usage
 * - Supports safe kill modes:
 *   - Soft kill: SIGTERM
 *   - Force kill: SIGKILL
 *
 * Security/privacy note:
 * The extension intentionally avoids collecting the full system process table.
 * The `ps` output is filtered with `awk` before it reaches the extension process.
 *
 * Memory usage:
 * %MEM = RSS / total_physical_RAM * 100
 */

const HIGH_CPU_THRESHOLD = 50.0;

type ProcessCategory = "zombie" | "orphan" | "ipykernel" | "jupyterLab" | "python";

type KillMode = "soft" | "force";

type PythonProcess = {
  pid: string;
  ppid: string;
  stat: string;
  tty: string;
  cpu: number;
  mem: number;
  rssKb: number;
  commandName: string;
  command: string;
  executablePath: string;
  category: ProcessCategory;
  kernelOrProjectName?: string;
};

class AutoRefreshItem extends vscode.TreeItem {
  public readonly labelText: string;

  constructor(public readonly enabled: boolean) {
    const labelText = enabled ? "Auto-refresh: enabled (5s)" : "Auto-refresh: disabled";

    super(labelText, vscode.TreeItemCollapsibleState.None);

    this.labelText = labelText;
    this.contextValue = "pythonKernelAutoRefresh";
    this.iconPath = new vscode.ThemeIcon(enabled ? "check" : "circle-large-outline");

    if (enabled) {
      this.resourceUri = vscode.Uri.parse("python-kernel-killer-auto-refresh://enabled/state");
    }

    this.command = {
      command: "pythonKernelKiller.toggleAutoRefresh",
      title: "Toggle Auto-refresh",
      arguments: [this]
    };
  }
}

function makeSeparatorLikeText(text: string): string {
  return "─".repeat(text.length);
}

class SpacerItem extends vscode.TreeItem {
  constructor(textToMatch: string) {
    super(makeSeparatorLikeText(textToMatch), vscode.TreeItemCollapsibleState.None);

    this.contextValue = "pythonKernelSpacer";
    this.iconPath = undefined;
    this.command = undefined;
  }
}

class GroupItem extends vscode.TreeItem {
  constructor(
    public readonly category: ProcessCategory,
    label: string,
    public readonly processes: PythonProcess[]
  ) {
    super(`${label} (${processes.length})`, vscode.TreeItemCollapsibleState.Expanded);

    const isWarningGroup =
      (category === "orphan" || category === "zombie") && processes.length > 0;

    this.contextValue =
      category === "orphan" ? "pythonKernelOrphanGroup" :
      category === "zombie" ? "pythonKernelZombieGroup" :
      "pythonKernelGroup";

    this.iconPath = new vscode.ThemeIcon(isWarningGroup ? "warning" : "folder");

    if (isWarningGroup) {
      this.resourceUri = vscode.Uri.parse(
        `python-kernel-killer-group://${category}/group`
      );
    }
  }
}

class ProcessItem extends vscode.TreeItem {
  constructor(public readonly processInfo: PythonProcess) {
    const highCpu = processInfo.cpu > HIGH_CPU_THRESHOLD;
    const isWarningProcess =
      processInfo.category === "orphan" ||
      processInfo.category === "zombie" ||
      highCpu;

    super(
      `PID ${processInfo.pid} | CPU ${processInfo.cpu.toFixed(1)}% | MEM ${processInfo.mem.toFixed(1)}%`,
      vscode.TreeItemCollapsibleState.None
    );

    this.description = processInfo.command;

    this.tooltip =
      `PID: ${processInfo.pid}\n` +
      `CPU: ${processInfo.cpu.toFixed(1)}%\n` +
      `MEM: ${processInfo.mem.toFixed(2)}%\n` +
      `RSS: ${(processInfo.rssKb / 1024).toFixed(1)} MB\n\n` +
      `Full command:\n${processInfo.command}`;

    this.contextValue = "pythonKernelProcess";
    this.iconPath = new vscode.ThemeIcon(isWarningProcess ? "warning" : "server-process");

    this.resourceUri = vscode.Uri.parse(
      `python-kernel-killer://${processInfo.pid}/${encodeURIComponent(processInfo.category)}`
    );

    this.command = {
      command: "pythonKernelKiller.kill",
      title: "Kill Process",
      arguments: [this]
    };
  }
}

class InfoItem extends vscode.TreeItem {
  constructor(label: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "pythonKernelInfo";
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

type TreeEntry = AutoRefreshItem | SpacerItem | GroupItem | ProcessItem | InfoItem;

class KernelProvider implements vscode.TreeDataProvider<TreeEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeEntry | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  public autoRefreshEnabled = false;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeEntry): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeEntry): Promise<TreeEntry[]> {
    if (element instanceof GroupItem) {
      if (element.processes.length === 0) {
        return [new InfoItem("No processes found")];
      }

      return element.processes.map(processInfo => new ProcessItem(processInfo));
    }

    if (element) {
      return [];
    }

    const processes = await getRunningPythonProcesses();
    const autoRefreshItem = new AutoRefreshItem(this.autoRefreshEnabled);

    return [
      autoRefreshItem,
      new SpacerItem(autoRefreshItem.labelText),
      new GroupItem("zombie", "Zombie Python processes", processes.filter(p => p.category === "zombie")),
      new GroupItem("orphan", "Orphan Python processes", processes.filter(p => p.category === "orphan")),
      new GroupItem("ipykernel", "IPython / Jupyter kernels", processes.filter(p => p.category === "ipykernel")),
      new GroupItem("jupyterLab", "JupyterLab servers", processes.filter(p => p.category === "jupyterLab")),
      new GroupItem("python", "Terminal Python processes", processes.filter(p => p.category === "python"))
    ];
  }
}

class ProcessDecorationProvider implements vscode.FileDecorationProvider {
  private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  private highCpuPids = new Set<string>();
  private orphanPids = new Set<string>();
  private zombiePids = new Set<string>();
  private autoRefreshEnabled = false;

  setDecorations(
    highCpuPids: string[],
    orphanPids: string[],
    zombiePids: string[],
    autoRefreshEnabled: boolean
  ): void {
    this.highCpuPids = new Set(highCpuPids);
    this.orphanPids = new Set(orphanPids);
    this.zombiePids = new Set(zombiePids);
    this.autoRefreshEnabled = autoRefreshEnabled;
    this._onDidChangeFileDecorations.fire(undefined);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme === "python-kernel-killer-auto-refresh" && uri.authority === "enabled") {
      if (!this.autoRefreshEnabled) {
        return undefined;
      }

      return {
        badge: "●",
        color: new vscode.ThemeColor("charts.yellow")
      };
    }

    if (uri.scheme === "python-kernel-killer-group") {
      if (uri.authority === "orphan" && this.orphanPids.size > 0) {
        return {
          badge: "O",
          color: new vscode.ThemeColor("errorForeground")
        };
      }

      if (uri.authority === "zombie" && this.zombiePids.size > 0) {
        return {
          badge: "Z",
          color: new vscode.ThemeColor("errorForeground")
        };
      }

      return undefined;
    }

    if (uri.scheme !== "python-kernel-killer") {
      return undefined;
    }

    const pid = uri.authority;

    if (this.zombiePids.has(pid)) {
      return {
        badge: "Z",
        color: new vscode.ThemeColor("errorForeground")
      };
    }

    if (this.orphanPids.has(pid)) {
      return {
        badge: "O",
        color: new vscode.ThemeColor("errorForeground")
      };
    }

    if (this.highCpuPids.has(pid)) {
      return {
        badge: "!",
        color: new vscode.ThemeColor("errorForeground")
      };
    }

    return undefined;
  }
}

function runProcessCommand(command: string): Promise<string[]> {
  return new Promise((resolve) => {
    exec(command, (error, stdout) => {
      if (error && !stdout.trim()) {
        resolve([]);
        return;
      }

      resolve(stdout.trim().split("\n").map(line => line.trim()).filter(Boolean));
    });
  });
}

function getTotalMemoryKb(): Promise<number> {
  return new Promise((resolve) => {
    exec(`awk '/MemTotal:/ {print $2}' /proc/meminfo`, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve(0);
        return;
      }

      resolve(Number.parseFloat(stdout.trim()));
    });
  });
}

function readExecutablePath(pid: string): Promise<string> {
  return new Promise((resolve) => {
    exec(`readlink -f /proc/${pid}/exe`, (error, stdout) => {
      if (error || !stdout.trim()) {
        resolve("");
        return;
      }

      resolve(stdout.trim());
    });
  });
}

/*
 * Extract only names that can be inferred with high confidence.
 *
 * Conda/Miniforge:
 *   .../envs/myenv/bin/python -> myenv
 *
 * venv:
 *   /project/.venv/bin/python -> project
 *
 * Other layouts:
 *   return undefined, because guessing can be misleading.
 */
function extractKernelOrProjectName(executablePath: string): string | undefined {
  const condaMatch = executablePath.match(/\/envs\/([^/]+)\/bin\/python[0-9.]*$/);
  if (condaMatch) {
    return condaMatch[1];
  }

  const venvMatch = executablePath.match(/\/([^/]+)\/\.venv\/bin\/python[0-9.]*$/);
  if (venvMatch) {
    return venvMatch[1];
  }

  return undefined;
}

async function enrichProcess(processInfo: PythonProcess): Promise<PythonProcess> {
  const executablePath = await readExecutablePath(processInfo.pid);
  const kernelOrProjectName = extractKernelOrProjectName(executablePath);

  return {
    ...processInfo,
    executablePath,
    kernelOrProjectName
  };
}

function isZombieStat(stat: string): boolean {
  return stat.includes("Z");
}

function isOrphanPpid(ppid: string): boolean {
  return ppid === "1";
}

function isSystemPythonExecutable(executablePath: string, command: string): boolean {
  const target = executablePath || command;

  return (
    target.startsWith("/usr/bin/python") ||
    target.startsWith("/usr/lib/") ||
    target.includes("/usr/lib/")
  );
}

/*
 * Some Linux desktop helpers are written in Python.
 * These should not be treated as user computation processes.
 */
function isKnownPythonDesktopHelper(command: string): boolean {
  const cmd = command.toLowerCase();

  const excludedPatterns = [
    "/usr/lib/",
    "/usr/bin/blueman",
    "/usr/bin/solaar",
    "cpupower-gui",
    "blueman-applet",
    "blueman-tray",
    "solaar"
  ];

  return excludedPatterns.some(pattern => cmd.includes(pattern));
}

/*
 * Parse one filtered ps output line.
 *
 * Expected format:
 * pid ppid stat tty pcpu rss comm args
 *
 * Example:
 * 1264297 1019306 Sl ? 0.0 347752 python /path/bin/python -m ipykernel_launcher ...
 */
function parseProcessLine(
  line: string,
  totalMemoryKb: number
): PythonProcess | undefined {
  const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([0-9.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);

  if (!match) {
    return undefined;
  }

  const pid = match[1];
  const ppid = match[2];
  const stat = match[3];
  const tty = match[4];
  const cpu = Number.parseFloat(match[5]);
  const rssKb = Number.parseFloat(match[6]);
  const commandName = match[7];
  const command = match[8].trim();

  const mem = totalMemoryKb > 0 ? (rssKb / totalMemoryKb) * 100.0 : 0.0;

  if (isKnownPythonDesktopHelper(command)) {
    return undefined;
  }

  const category = classifyProcess({
    ppid,
    stat,
    tty,
    commandName,
    command
  });

  if (!category) {
    return undefined;
  }

  return {
    pid,
    ppid,
    stat,
    tty,
    cpu,
    mem,
    rssKb,
    commandName,
    command,
    executablePath: "",
    category
  };
}

function classifyProcess(input: {
  ppid: string;
  stat: string;
  tty: string;
  commandName: string;
  command: string;
}): ProcessCategory | undefined {
  const { ppid, stat, tty, commandName, command } = input;
  const cmd = command.toLowerCase();
  const comm = commandName.toLowerCase();

  /*
   * Priority:
   * zombie > orphan > ipykernel > jupyterLab > terminal python
   */
  if (isZombieStat(stat)) {
    return "zombie";
  }

  if (isOrphanPpid(ppid) && /^python[0-9.]*$/.test(comm)) {
    return "orphan";
  }

  if (
    /^python[0-9.]*$/.test(comm) &&
    (
      cmd.includes("ipykernel_launcher") ||
      cmd.includes("-m ipykernel") ||
      cmd.includes("ipykernel")
    )
  ) {
    return "ipykernel";
  }

  if (
    comm === "jupyter-lab" ||
    cmd.includes("/jupyter-lab") ||
    cmd.includes(" jupyter-lab")
  ) {
    return "jupyterLab";
  }

  if (tty !== "?" && /^python[0-9.]*$/.test(comm)) {
    return "python";
  }

  return undefined;
}

/*
 * Single filtered ps command per refresh.
 *
 * Performance:
 * This avoids several separate process discovery calls.
 *
 * Security/privacy:
 * The awk filter limits output before it reaches the extension.
 *
 * Test command:
 *
 * ps -eo pid=,ppid=,stat=,tty=,pcpu=,rss=,comm=,args= \
 * | awk '
 *   $7 ~ /^python[0-9.]*$/ ||
 *   $7 == "jupyter-lab" ||
 *   ($7 ~ /^python[0-9.]*$/ && $0 ~ /ipykernel_launcher| -m ipykernel|ipykernel/) ||
 *   ($7 ~ /^python[0-9.]*$/ && $3 ~ /Z/) ||
 *   ($7 ~ /^python[0-9.]*$/ && $2 == 1)
 * '
 */
async function getRunningPythonProcesses(): Promise<PythonProcess[]> {
  const totalMemoryKb = await getTotalMemoryKb();

  const command =
    `ps -eo pid=,ppid=,stat=,tty=,pcpu=,rss=,comm=,args= | ` +
    `awk '$7 ~ /^python[0-9.]*$/ || $7 == "jupyter-lab" || ` +
    `($7 ~ /^python[0-9.]*$/ && $0 ~ /ipykernel_launcher| -m ipykernel|ipykernel/) || ` +
    `($7 ~ /^python[0-9.]*$/ && $3 ~ /Z/) || ` +
    `($7 ~ /^python[0-9.]*$/ && $2 == 1)'`;

  const lines = await runProcessCommand(command);

  const parsed = lines
    .map(line => parseProcessLine(line, totalMemoryKb))
    .filter((p): p is PythonProcess => p !== undefined)
    .filter(p => p.pid !== process.pid.toString())
    .sort((a, b) => b.cpu - a.cpu);

  return Promise.all(parsed.map(enrichProcess));
}

function sendSignal(pid: string, signal: "TERM" | "KILL"): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(`kill -${signal} ${pid}`, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

/*
 * Safety rules:
 * - Never kill PID 1.
 * - System Python paths are blocked for soft/default kill.
 * - System Python paths require explicit confirmation for force mode.
 */
function getSafetyWarning(processInfo: PythonProcess, mode: KillMode): string | undefined {
  if (processInfo.pid === "1") {
    return "PID 1 is protected and cannot be killed.";
  }

  const isSystemPython = isSystemPythonExecutable(
    processInfo.executablePath,
    processInfo.command
  );

  if (isSystemPython && mode === "soft") {
    return "This looks like a system Python process. Use force mode only if you are certain.";
  }

  return undefined;
}

async function killProcess(processInfo: PythonProcess, mode: KillMode): Promise<string> {
  const safetyWarning = getSafetyWarning(processInfo, mode);

  if (safetyWarning) {
    throw new Error(safetyWarning);
  }

  if (mode === "soft") {
    await sendSignal(processInfo.pid, "TERM");
    return "Sent SIGTERM";
  }

  await sendSignal(processInfo.pid, "KILL");
  return "Sent SIGKILL";
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new KernelProvider();
  const decorationProvider = new ProcessDecorationProvider();

  vscode.window.createTreeView("pythonKernelKillerView", {
    treeDataProvider: provider,
    showCollapseAll: true
  });

  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(decorationProvider)
  );

  let autoRefreshTimer: NodeJS.Timeout | undefined;

  async function refreshWithDecorations(): Promise<void> {
    const processes = await getRunningPythonProcesses();

    const highCpuPids = processes
      .filter(p => p.cpu > HIGH_CPU_THRESHOLD)
      .map(p => p.pid);

    const orphanPids = processes
      .filter(p => p.category === "orphan")
      .map(p => p.pid);

    const zombiePids = processes
      .filter(p => p.category === "zombie")
      .map(p => p.pid);

    decorationProvider.setDecorations(
      highCpuPids,
      orphanPids,
      zombiePids,
      provider.autoRefreshEnabled
    );

    provider.refresh();
  }

  function startAutoRefresh(): void {
    if (autoRefreshTimer) {
      return;
    }

    autoRefreshTimer = setInterval(() => {
      refreshWithDecorations();
    }, 5000);
  }

  function stopAutoRefresh(): void {
    if (!autoRefreshTimer) {
      return;
    }

    clearInterval(autoRefreshTimer);
    autoRefreshTimer = undefined;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("pythonKernelKiller.refresh", () => {
      refreshWithDecorations();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pythonKernelKiller.toggleAutoRefresh", () => {
      provider.autoRefreshEnabled = !provider.autoRefreshEnabled;

      if (provider.autoRefreshEnabled) {
        startAutoRefresh();
      } else {
        stopAutoRefresh();
      }

      refreshWithDecorations();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pythonKernelKiller.kill", async (item?: ProcessItem) => {
      if (!item) {
        return;
      }

      const processInfo = item.processInfo;
      const nameText = processInfo.kernelOrProjectName;

      /*
       * A zombie process is already dead.
       *
       * SIGTERM and SIGKILL cannot remove a zombie entry.
       * The zombie disappears only when its parent process reaps it
       * with wait()/waitpid(), or when the parent process exits.
       */
      if (processInfo.category === "zombie") {
        const answer = await vscode.window.showWarningMessage(
          `ZOMBIE PROCESS: PID ${processInfo.pid}\n\n` +
          `This process is already dead. SIGTERM and SIGKILL cannot remove it.\n\n` +
          `A zombie disappears only when its parent process reaps it with wait()/waitpid(), ` +
          `or when the parent process exits.\n\n` +
          `Parent PID: ${processInfo.ppid}\n\n` +
          `Full command:\n${processInfo.command}`,
          { modal: true },
          "Kill parent process"
        );

        if (answer !== "Kill parent process") {
          return;
        }

        if (processInfo.ppid === "1") {
          vscode.window.showWarningMessage("Parent PID is 1. This parent is protected and cannot be killed.");
          return;
        }

        try {
          await sendSignal(processInfo.ppid, "TERM");
          vscode.window.showInformationMessage(`Sent SIGTERM to parent PID ${processInfo.ppid}`);
          await refreshWithDecorations();
        } catch (error: any) {
          vscode.window.showErrorMessage(`Failed to kill parent PID ${processInfo.ppid}: ${error.message}`);
        }

        return;
      }

      const answer = await vscode.window.showWarningMessage(
        `KILL PROCESS: PID ${processInfo.pid}\n\n` +
        `${nameText ? `Name of Kernel/Project: ${nameText}\n` : ""}` +
        `CPU: ${processInfo.cpu.toFixed(1)}%\n` +
        `MEM: ${processInfo.mem.toFixed(2)}%\n` +
        `Category: ${processInfo.category.toUpperCase()}\n` +
        `Executable: ${processInfo.executablePath || "-"}\n\n` +
        `Full command:\n${processInfo.command}`,
        { modal: true },
        "Force kill",
        "Soft kill",
      );

      if (!answer) {
        return;
      }

      const mode: KillMode = answer === "Soft kill" ? "soft" : "force";
      const safetyWarning = getSafetyWarning(processInfo, mode);

      if (safetyWarning) {
        vscode.window.showWarningMessage(safetyWarning);
        return;
      }

      /*
       * Extra confirmation for force mode on system Python.
       */
      if (
        mode === "force" &&
        isSystemPythonExecutable(processInfo.executablePath, processInfo.command)
      ) {
        const forceAnswer = await vscode.window.showWarningMessage(
          `This appears to be a system Python process.\n\n` +
          `Executable: ${processInfo.executablePath || processInfo.command}\n\n` +
          `Force killing system processes can break desktop/session components.`,
          { modal: true },
          "Force anyway"
        );

        if (forceAnswer !== "Force anyway") {
          return;
        }
      }

      try {
        const result = await killProcess(processInfo, mode);
        vscode.window.showInformationMessage(`${result}: PID ${processInfo.pid}`);
        await refreshWithDecorations();
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to kill PID ${processInfo.pid}: ${error.message}`);
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      stopAutoRefresh();
    }
  });

  refreshWithDecorations();
}

export function deactivate() {}