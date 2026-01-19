# tatzeroko-language-tools

Tatzeroko is a unified language tooling foundation for Salesforce projects,
designed to improve the developer experience by extending TypeScript and editor tooling
with Salesforce workspace awareness and custom resolution capabilities.

The project focuses on building the **infrastructure required for Salesforce-aware tooling** —
such as virtual files, custom module resolution, and editor integration —
with deeper Salesforce-specific type intelligence planned for future releases.

## ✨ What it does (today)

- Salesforce workspace detection and awareness
- Integration with TypeScript and editor tooling (via TS plugin and language server)
- Custom file and module resolution for Salesforce project layouts
- Virtual file support for generated and inferred sources

> [!WARNING]
> Apex-aware types, Salesforce metadata integration, and org-based type inference
are planned, but not yet implemented.

## 📦 Monorepo structure

| Package | Description |
| - | - |
| <code><a href="packages/tatzeroko-vscode">tatzeroko-vscode</a></code> | Integrates the tooling into VS Code. |
| <code><a href="packages/typescript-plugin">@tatzeroko/typescript-plugin</a></code> | Extends the TypeScript server with custom resolution and virtual files. |
| <code><a href="packages/language-server">@tatzeroko/language-server</a></code> | Language server providing editor-facing features and coordination. |

## 🚀 Getting started

### VS Code
Search for **Tatzeroko Language Tools** in the VS Code Marketplace and install the extension.

This will automatically enable the TypeScript plugin and language server for supported projects.

### Other editors
Support for editors beyond VS Code is not yet provided. Manual configuration may be possible,
and documentation for additional editors may be added in the future.

## ❤️ Support the project

If you find this project useful or interesting, consider supporting its development:

- GitHub Sponsors: https://github.com/sponsors/Tatzeroko

Support helps keep the project open, maintained, and community-focused.
