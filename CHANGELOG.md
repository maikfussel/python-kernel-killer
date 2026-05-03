# Change Log

All notable changes to the "python-kernel-killer" extension will be documented in this file.

## [0.1.0]

### Added

- Detection of multiple process categories:
  - Zombie processes
  - Orphan processes
  - IPython/Jupyter kernels
  - JupyterLab servers
  - Terminal Python processes

- CPU and memory usage display
- RSS memory calculation in MB

- Environment detection:
  - Conda environments
  - venv project names

- Auto-refresh (5s) with visual indicator

- Kill modes:
  - Soft kill (SIGTERM)
  - Force kill (SIGKILL)

- Safety protections:
  - Block PID 1
  - Protect system Python processes

### Improved

- Performance:
  - Single filtered `ps` call per refresh
- Security:
  - Pre-filtered process selection via `awk`

## [0.0.1]

- Initial release
- Basic kernel listing
- Kill functionality
- Manual refresh