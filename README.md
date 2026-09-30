# Pilot Browser

A minimalist, Arc-inspired desktop browser built on Electron — vertical tabs,
spaces, a command palette, split view, and an optional local AI assistant.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Real browsing** — each tab is a Chromium `<webview>` on a persistent
  session, so cookies and logins survive restarts.
- **Vertical tab sidebar** — pinned-tab grid, per-tab audio indicator, mute,
  duplicate, drag-to-reorder, context menus.
- **Spaces** — separate tab sets with their own accent color (Personal, Work,
  Explore — add your own). Tabs, pins, and the active space restore on launch.
- **Command palette** (`Ctrl/Cmd+K`) — fuzzy search across open tabs, history,
  bookmarks, and every browser action.
- **Omnibox** — URLs or search queries (Google, Bing, DuckDuckGo, Brave,
  Perplexity) with live suggestions from tabs, bookmarks, and history.
- **Split view** — put any two tabs side-by-side (`Split right with…` in the
  tab context menu or the toolbar button).
- **Start page** — clock, quick search, and a customizable tile grid on every
  new tab.
- **Find in page** (`Ctrl/Cmd+F`), zoom, back/forward, reload/stop, downloads
  with progress, and a library overlay for history, bookmarks, and downloads.
- **Pilot AI panel** — a right-hand assistant that can summarize the current
  page or answer questions using it as context. Powered by the bundled FastAPI
  backend: an OpenAI-compatible local LLM (e.g. LM Studio) when one is
  configured, with a DuckDuckGo instant-answer fallback so it always responds.
- **Dark and light themes** plus a "Dark web pages" option; per-space accent
  colors; frameless window with traffic-light controls.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| `Ctrl/Cmd+K` | Command palette |
| `Ctrl/Cmd+T` / `W` | New / close tab |
| `Ctrl/Cmd+L` | Focus omnibox |
| `Ctrl/Cmd+F` | Find in page |
| `Ctrl/Cmd+D` | Bookmark page |
| `Ctrl/Cmd+R` | Reload |
| `Ctrl/Cmd+H` | History (library) |
| `Ctrl/Cmd+Shift+B` | Toggle sidebar |
| `Ctrl/Cmd+Shift+J` | Toggle AI assistant |
| `Ctrl/Cmd+Tab` | Cycle tabs |
| `Ctrl/Cmd+1–9` | Jump to tab / last tab |
| `Ctrl/Cmd+= / - / 0` | Zoom in / out / reset |
| `Alt+←/→` | Back / forward |
| `F12` | Guest devtools |

## Getting started

### Prerequisites

- Node.js 18+ and npm
- Python 3.10+ (optional, for the AI backend)

### Install and run

```bash
npm install
npm run dev        # builds the renderer and launches Electron
```

The browser works fully without the backend. To enable Pilot AI:

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
npm run backend                  # uvicorn on http://localhost:8000
```

Point the assistant at a local LLM via env vars before starting the backend:

```bash
export OPENAI_API_BASE=http://localhost:1234/v1   # LM Studio default
export OPENAI_API_KEY=lm-studio
export LLM_MODEL=gemma-3-4b
```

The backend URL is also configurable in Settings → Pilot AI Backend.

### Production build

```bash
npm run build      # vite build → dist/renderer
npm start          # electron . (loads dist/renderer)
npm run package    # electron-builder → release/ (AppImage, deb, dmg, nsis)
```

## Project structure

```
├── electron/
│   ├── main.cjs        # BrowserWindow, persistent session, downloads, IPC
│   └── preload.cjs     # contextBridge surface (window.pilot)
├── src/renderer/
│   ├── index.html      # Shell markup: sidebar, toolbar, overlays
│   ├── css/styles.css  # Design system (dark/light, per-space accent)
│   └── js/
│       ├── app.js      # Bootstrap, theme, shortcuts, start page
│       ├── store.js    # localStorage persistence + settings/spaces model
│       ├── tabs.js     # Tab engine: webview lifecycle, nav, split, spaces
│       ├── sidebar.js  # Spaces, pinned grid, tab list, context menus
│       ├── omnibox.js  # Omnibox + suggestions
│       ├── palette.js  # Command palette
│       ├── ui.js       # Toolbar, find bar, library panels, context menus
│       ├── settings.js # Settings panel
│       └── assistant.js# Pilot AI side panel
├── backend/            # FastAPI + SQLAlchemy; /api/v1/assistant/ask
├── scripts/dev.js      # Dev launcher (vite build + electron)
└── assets/icon.png
```

## Security notes

- Webview guests run sandboxed with context isolation and no Node integration.
- The shell exposes a minimal `window.pilot` IPC surface via a preload bridge.
- Downloads stream through the main process into your Downloads folder.
- The backend stores its SQLite database under `backend/`; no telemetry.

## License

MIT — see [LICENSE](LICENSE).
