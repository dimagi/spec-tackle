# AGENTS.md

spec-tackle is a local web app for reviewing GitHub pull requests, built for spec and design-doc PRs. A FastAPI backend talks to GitHub and serves a React UI that shows markdown as a readable document, with review threads in the margin. See `README.md` for what it does from the user's side.

## Layout

- `src/spec_tackle/`: Python package (Python 3.12, managed with uv)
  - `app.py`: FastAPI app and JSON API
  - `pages.py`: builds the review page's data
  - `github.py`: async GitHub GraphQL/REST client
  - `render.py`: markdown → HTML where each block carries `data-ls`/`data-le` source line ranges, so comments land on the right lines
  - `access.py`: the launch link and access cookie that lock the server to your browser
  - `auth.py`: GitHub sign-in (`GITHUB_TOKEN`/`GH_TOKEN`, `gh auth token`, `gh auth login --web`, or a pasted token kept in memory only)
  - `claude.py`, `claude_api.py`, `turns.py`, `checkout.py`: Ask Claude (private threads, background turns, read-only repo worktrees)
  - `logic.py`, `logic_api.py`: the Logic view's Flow mode (a Claude-drawn flowchart of the PR)
  - `calls.py`, `calls_api.py`: the Logic view's Calls mode (a static call tree of the changed Python code, via `ast`; no Claude)
  - `store.py`: local SQLite state under `~/.local/share/spec-tackle/`
  - `static/dist/`: the **committed** frontend build
- `frontend/`: React 19 + TypeScript + Tailwind 4 + Vite. React Query for server data, zustand for UI state.
- `tests/`: pytest. `tests/e2e_server.py` runs the app against an in-memory fake GitHub for Playwright.
- `docs/specs/`: feature specs. `docs/plans/`: implementation plans.

## Commands

```bash
uv sync --extra claude        # install; the extra enables Ask Claude
uv run pytest                 # backend tests (also checks the frontend bundle is fresh)
uv run spec-tackle <PR URL>   # run on http://127.0.0.1:8765

cd frontend
npm install
npm run dev        # Vite on :5173, proxies the API to :8765
npm test           # vitest
npm run typecheck
npm run e2e        # Playwright against tests/e2e_server.py on :8799
npm run build      # rebuilds src/spec_tackle/static/dist/
```

## Rules

- **Rebuild after any frontend change.** The bundle is committed so installing needs no Node. `npm run build` writes `static/dist/.source-hash`, and `tests/test_frontend_bundle.py` fails if it doesn't match `frontend/src` plus the build config. Commit the rebuilt `dist/` together with the source change. If you change the set of hashed inputs, update `frontend/scripts/source-hash.mjs` and the test together.
- **`claude-agent-sdk` is optional.** Import it only inside the functions that need it (see `claude.py`), so the app runs without the `claude` extra.
- **Never leak the GitHub token.** It goes to git through `GIT_CONFIG_*` env vars (`checkout.py`), never through argv, config files or error messages. Pasted tokens are never written to disk.
- **Every route except `/static/` needs the access cookie** (`access.py`). The launch link `main()` prints sets it. Tests get it from `conftest.py`, and Playwright from `playwright.config.ts`. `/raw` serves only images inline, sandboxed; everything else is a download, because any page can open a `/raw` URL on our origin.
- **Ask Claude stays private.** Questions and answers are stored locally and never posted to GitHub. Claude sessions get read-only file access and never start MCP servers.
- **Pin frontend dependencies** to exact versions in `package.json`.
- New feature specs go in `docs/specs/`. `docs/superpowers/` is gitignored scratch space.
- Commit messages use Conventional Commits with an optional scope, e.g. `feat(frontend): …`, `fix: …`, `test: …`, `docs: …`, `chore: …`.
