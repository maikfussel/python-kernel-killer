# Python Kernel Killer

Python Kernel Killer is a small VS Code/VSCodium extension for Linux that shows running Python Jupyter kernels in a sidebar and lets you terminate stuck kernels directly from the editor.

## Features

- Lists running Python Jupyter/IPython kernel processes
- Shows process ID and command line
- Kills selected kernels from the sidebar
- Manual refresh button
- Optional auto-refresh mode
- Useful when VS Code/Jupyter cannot restart or disconnect a stuck kernel

## Requirements

This extension currently targets Linux systems.

It uses standard system commands:

- `ps`
- `kill`

No Python package installation is required.

## Usage

1. Open the **Python Kernels** sidebar.
2. Review the running kernel processes.
3. Use the refresh button if needed.
4. Select a kernel to terminate it.
5. Confirm the kill action.

## Known Issues

- Linux only for now.
- Process detection is based on command-line matching for Jupyter/IPython kernels.
- Remote kernels are only visible if their process runs on the same local machine.

## Release Notes

### 0.0.1

Initial release.

- Added sidebar view for running Python kernels
- Added manual refresh
- Added kernel termination
- Added optional auto-refresh