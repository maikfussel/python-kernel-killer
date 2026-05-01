import * as vscode from "vscode";
import { exec } from "child_process";

class KernelItem extends vscode.TreeItem {
  constructor(
    public readonly pid: string,
    public readonly processCommand: string
  ) {
    super(`PID ${pid}`, vscode.TreeItemCollapsibleState.None);

    this.description = processCommand;
    this.tooltip = processCommand;
    this.contextValue = "pythonKernelProcess";
    this.iconPath = new vscode.ThemeIcon("server-process");

    this.command = {
      command: "pythonKernelKiller.kill",
      title: "Kill Kernel",
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

class AutoRefreshItem extends vscode.TreeItem {
  constructor(public readonly enabled: boolean) {
    super(
      enabled ? "Auto-refresh: enabled (5s)" : "Auto-refresh: disabled",
      vscode.TreeItemCollapsibleState.None
    );

    this.contextValue = "pythonKernelAutoRefresh";
    this.iconPath = new vscode.ThemeIcon(enabled ? "check" : "circle-large-outline");

    this.command = {
      command: "pythonKernelKiller.toggleAutoRefresh",
      title: "Toggle Auto-refresh",
      arguments: [this]
    };
  }
}

type TreeEntry = KernelItem | InfoItem | AutoRefreshItem;

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

  async getChildren(): Promise<TreeEntry[]> {
    const kernels = await getRunningKernels();

    const entries: TreeEntry[] = [
      new AutoRefreshItem(this.autoRefreshEnabled)
    ];

    if (kernels.length === 0) {
      entries.push(new InfoItem("No running Python Jupyter kernels found"));
      return entries;
    }

    entries.push(...kernels.map(k => new KernelItem(k.pid, k.command)));
    return entries;
  }
}

type KernelProcess = {
  pid: string;
  command: string;
};

function getRunningKernels(): Promise<KernelProcess[]> {
  return new Promise((resolve) => {
    const cmd = `ps -eo pid,args | grep -E "ipykernel_launcher|jupyter.*kernel|python.*-m ipykernel|python.*ipykernel" | grep -v grep`;

    exec(cmd, (error, stdout) => {
      if (error && !stdout.trim()) {
        resolve([]);
        return;
      }

      const kernels = stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(line => {
          const trimmed = line.trim();
          const firstSpace = trimmed.indexOf(" ");

          return {
            pid: trimmed.slice(0, firstSpace),
            command: trimmed.slice(firstSpace + 1)
          };
        })
        .filter(k => k.pid !== process.pid.toString());

      resolve(kernels);
    });
  });
}

function killKernel(pid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(`kill ${pid}`, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new KernelProvider();

  vscode.window.createTreeView("pythonKernelKillerView", {
    treeDataProvider: provider
  });

  let autoRefreshTimer: NodeJS.Timeout | undefined;

  function startAutoRefresh(): void {
    if (autoRefreshTimer) {
      return;
    }

    autoRefreshTimer = setInterval(() => {
      provider.refresh();
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
      provider.refresh();
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

      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pythonKernelKiller.kill", async (item?: KernelItem) => {
      if (!item || item.pid === "-") {
        return;
      }

      if (!item.processCommand.includes("ipykernel")) {
        vscode.window.showWarningMessage("This does not look like a Jupyter kernel.");
        return;
      }

      const answer = await vscode.window.showWarningMessage(
        `Kill Python kernel PID ${item.pid}?`,
        { modal: true },
        "Kill"
      );

      if (answer !== "Kill") {
        return;
      }

      try {
        await killKernel(item.pid);
        vscode.window.showInformationMessage(`Killed kernel PID ${item.pid}`);
        provider.refresh();
      } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to kill PID ${item.pid}: ${error.message}`);
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      stopAutoRefresh();
    }
  });

  provider.refresh();
}

export function deactivate() {}