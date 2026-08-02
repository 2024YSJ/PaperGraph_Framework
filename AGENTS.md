# PaperGraph3D — Obsidian plugin

## Project overview

- Target: Obsidian Community Plugin (TypeScript → bundled JavaScript).
- Purpose: collect, embed, and visualize academic papers as a 3D graph, built as an
  extensible framework (developers can hook in via `Middleware` and `TaskManager`).
- Entry point: `src/main.ts` (`PaperGraph3D`, extends Obsidian's `Plugin` directly)
  compiled to `main.js` and loaded by Obsidian.
- Required release artifacts: `main.js`, `manifest.json`, and optional `styles.css`.
- Design reference: [`docs/Structure/PaperGraph3D_Class_Diagram.md`](docs/Structure/PaperGraph3D_Class_Diagram.md)
  (class diagram + agreed design decisions). Work log:
  [`docs/plan/primary_plan.md`](docs/plan/primary_plan.md).

## Environment & tooling

- Node.js: use current LTS (Node 18+ recommended).
- Package manager: **npm** (`package.json` defines npm scripts and dependencies).
- Bundler: **esbuild** (`esbuild.config.mjs` and build scripts depend on it).
- Types: `obsidian` type definitions.

### Install

```bash
npm install
```

### Dev (watch)

```bash
npm run dev
```

### Production build

```bash
npm run build
```

## Linting

- ESLint is preconfigured with `eslint-plugin-obsidianmd` for Obsidian-specific rules.
- Run `npm run lint` to lint the project.
- A GitHub Action automatically lints every commit on all branches.

## File & folder conventions

- Source lives in `src/`, organized by pipeline stage, not by file type:
    ```
    src/
      main.ts       # PaperGraph3D plugin entry point (Plugin lifecycle, init, commands)
      collect/      # Collection pipeline: CollectAndSave, Subscriptions, Secret, API,
                     # SearchQuery, Paper, Embedding
      visualize/    # Visualization pipeline: VisualizationFlow, PCA, Visualization, GraphData
      common/       # Shared building blocks: Middleware, EventListener, TaskManager, Task
                     # (no obsidian import — plain TS)
      adapter/      # Obsidian-specific: SettingTab, VisualizationView, PaperStore,
                     # SecretStore
    ```
- Keep `main.ts` small and focused on plugin lifecycle (loading, unloading, registering
  commands) — delegate feature logic to `collect/`, `visualize/`, `common/`, `adapter/`.
- `common/` is Obsidian-agnostic plain TypeScript; anything touching the `obsidian` API
  (Vault, Plugin, etc.) belongs in `adapter/`.
- Persistence is split by storage medium and owner concern:
  - `PaperStore` (`src/adapter/PaperStore.ts`) is a **static** class backed by `Vault`
    (call `PaperStore.method(...)` directly, after `PaperStore.init(vault)` has run once
    in `PaperGraph3D.init()`).
  - `SecretStore` (`src/adapter/SecretStore.ts`) is a **static** class backed by
    `Plugin.saveData/loadData` (call `SecretStore.method(...)` directly, after
    `SecretStore.init(plugin)` has run once in `PaperGraph3D.init()`). Secrets are meant
    to be encrypted before being written — the key-management approach isn't decided yet
    (see the `TODO` in that file); merely storing under the plugin data folder is **not**
    itself a security boundary (it's still a plaintext file inside the vault tree).
  - They're kept separate on purpose: `Secret`'s storage medium/security needs are still
    undecided while `Paper`'s (vault notes) is essentially fixed, and merging them into
    one class previously forced anything touching `Secret` to also satisfy `Vault`
    initialization (impossible to construct outside real Obsidian — the `obsidian` npm
    package ships types only, no runtime).
- **Do not commit build artifacts**: Never commit `node_modules/`, `main.js`, or other
  generated files to version control (already gitignored).
- Keep the plugin small. Avoid large dependencies. Prefer browser-compatible packages.

## Manifest rules (`manifest.json`)

- Must include (non-exhaustive):
    - `id` (`papergraph3d`; never change after release — treat it as stable API)
    - `name`, `version` (SemVer `x.y.z`), `minAppVersion`, `description`,
      `isDesktopOnly` (boolean)
    - Optional: `author`, `authorUrl`, `fundingUrl`
- Keep `minAppVersion` accurate when using newer APIs.
- Canonical requirements are coded here: https://github.com/obsidianmd/obsidian-releases/blob/master/.github/workflows/validate-plugin-entry.yml

## Testing

- Manual install for testing: copy `main.js`, `manifest.json`, `styles.css` (if any) to:
    ```
    <Vault>/.obsidian/plugins/papergraph3d/
    ```
- Reload Obsidian and enable the plugin in **Settings → Community plugins**.
- Many core classes (`CollectAndSave`, `Embedding`, `PCA`, `Visualization`, etc.) are
  still stubs that `throw`. The temporary UI (ribbon icon, settings tab, visualization
  view) is deliberately wired stage-by-stage so each pipeline step can be exercised as
  soon as its owner implements it, without waiting on the full `run()` flow. When adding
  a new stage implementation, wire a matching UI trigger rather than only the
  end-to-end `run()`.

## Commands & settings

- User-facing commands are added via `this.addCommand(...)` in `main.ts`.
- Settings live in `src/adapter/SettingTab.ts`. It currently binds to local component
  state only (Secret/Subscriptions/API field shapes aren't finalized yet) — connect real
  persistence via `SecretStore`/`PaperStore` once their concrete implementations land
  (see the `TODO` comments in those files).
- Use stable command IDs; avoid renaming once released.

## Versioning & releases

- Bump `version` in `manifest.json` (SemVer) and update `versions.json` to map plugin
  version → minimum app version.
- Create a GitHub release whose tag exactly matches `manifest.json`'s `version`. Do not
  use a leading `v`.
- Attach `manifest.json`, `main.js`, and `styles.css` (if present) to the release as
  individual assets (`.github/workflows/release.yml` automates this on tag push).

## Security, privacy, and compliance

Follow Obsidian's **Developer Policies** and **Plugin Guidelines**. In particular:

- Default to local/offline operation. Only make network requests when essential
  (paper collection APIs, embedding model downloads).
- No hidden telemetry. If optional analytics or third-party services are added, require
  explicit opt-in and document clearly in `README.md` and in settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside
  of normal releases.
- Minimize scope: read/write only what's necessary inside the vault. Do not access files
  outside the vault.
- Clearly disclose any external services used (search APIs, embedding services), data
  sent, and risks.
- Respect user privacy. Do not collect vault contents, filenames, or personal
  information unless absolutely necessary and explicitly consented.
- Register and clean up all DOM, app, and interval listeners using the provided
  `register*` helpers so the plugin unloads safely.

## UX & copy guidelines (for UI text, commands, settings)

- Prefer sentence case for headings, buttons, and titles.
- Use clear, action-oriented imperatives in step-by-step copy.
- Use **bold** to indicate literal UI labels. Prefer "select" for interactions.
- Use arrow notation for navigation: **Settings → Community plugins**.
- Keep in-app strings short, consistent, and free of jargon.

## Performance

- Keep startup light. Defer heavy work until needed.
- Avoid long-running tasks during `onload`; use lazy initialization.
- Batch disk access and avoid excessive vault scans.
- Debounce/throttle expensive operations (collection polling, embedding calls) in
  response to file system or scheduled events.

## Coding conventions

- TypeScript with `"strict": true`.
- **Keep `main.ts` minimal**: plugin lifecycle only (`onload`, `onunload`, `init`,
  `addCommand` calls). Delegate feature logic to `collect/`, `visualize/`, `common/`,
  `adapter/`.
- **Split large files**: if any file exceeds ~200-300 lines, break it into smaller,
  focused modules.
- Each file should have a single, well-defined responsibility, matching the class
  diagram in `docs/Structure/PaperGraph3D_Class_Diagram.md`.
- Bundle everything into `main.js` (no unbundled runtime deps).
- Avoid Node/Electron APIs if you want mobile compatibility; set `isDesktopOnly`
  accordingly.
- Prefer `async/await` over promise chains; handle errors gracefully.
- Follow the pipeline's flow-control rule from the class diagram: middleware/loop
  control lives only inside a flow's `run()` (e.g. `CollectAndSave.run`,
  `VisualizationFlow.run`) — sub-functions should not drive that flow themselves.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behavior unless `isDesktopOnly` is `true`.
- Avoid large in-memory structures; be mindful of memory and storage constraints.

## Agent do/don't

**Do**

- Add commands with stable IDs (don't rename once released).
- Provide defaults and validation in settings.
- Write idempotent code paths so reload/unload doesn't leak listeners or intervals.
- Use `this.register*` helpers for everything that needs cleanup.
- Record non-obvious design decisions in `docs/plan/primary_plan.md` and, if they affect
  the class diagram, in `docs/Structure/PaperGraph3D_Class_Diagram.md` too.

**Don't**

- Introduce network calls without an obvious user-facing reason and documentation.
- Ship features that require cloud services without clear disclosure and explicit
  opt-in.
- Store or transmit vault contents unless essential and consented.
- Invent public API surface for a class another teammate owns (see the role split in
  `docs/plan/primary_plan.md`) — stub it and leave a note instead.

## Troubleshooting

- Plugin doesn't load after build: ensure `main.js` and `manifest.json` are at the top
  level of the plugin folder under `<Vault>/.obsidian/plugins/papergraph3d/`.
- Build issues: if `main.js` is missing, run `npm run build` or `npm run dev` to compile
  the TypeScript source.
- Commands not appearing: verify `addCommand` runs after `onload` and IDs are unique.
- Settings not persisting: expected for now — `SettingTab` only binds to local state
  until `PaperStore`/`SecretStore`/`Secret`/`Subscriptions` are implemented (see the
  `TODO` comments there).
- Mobile-only issues: confirm you're not using desktop-only APIs; check
  `isDesktopOnly` and adjust.

## References

- API documentation: https://docs.obsidian.md
- Developer policies: https://docs.obsidian.md/Developer+policies
- Plugin guidelines: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
- Style guide: https://help.obsidian.md/style-guide
