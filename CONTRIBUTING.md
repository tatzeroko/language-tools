# Contributing

Thanks for your interest in contributing! ❤️  
Contributions of all kinds are welcome — code, docs, ideas, and bug reports.

## Development setup

### Prerequisites
- Node.js (LTS recommended)
- pnpm
- Visual Studio Code

### Running the `VSCode` extension

1. Clone the repository
2. Run `pnpm install` at the repository root
3. Use the `Debugger`(run and debug) view to launch the `Extension Development Host`

This will open a new VS Code window with the extension enabled.

> [!NOTE]
> The pre-configured launchers will prepare required builds as needed.

### Working on the TypeScript plugin

- The TypeScript plugin is loaded automatically by the extension
- Changes usually require rebuilding and reloading the Extension Development Host
- Enable TS Server logs for debugging if needed: `TypeScript: Open TS Server log`

### Other editors

At the moment, development and testing are focused on `VSCode`. Support for other editors (e.g. `Neovim`) may be explored in the future.