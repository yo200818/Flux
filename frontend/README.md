# PocketDeck Client

This folder contains the shared React, TypeScript, and Vite client used by the
Windows Tauri 2 application and the standalone browser build. The client
supports configuration editing, profile/page selection, grid layout, and
allowlisted backend actions. The browser client requires a previously paired
`web` device credential and cannot execute Windows-only actions.

## Frontend workflow

Run these commands from this folder:

```powershell
npm install
npm run dev
npm run dev:web
npm run lint
npm test
npm run build
npm run build:web
```

`npm run dev` serves the Tauri development UI on port 1420. Keep the backend
running in a separate terminal for development; Tauri owns the backend only
in packaged Windows builds. `npm run dev:web` serves the browser UI at
`http://127.0.0.1:5173`. Both clients use `http://127.0.0.1:8000` by default.
Set `VITE_API_BASE_URL` in `.env.local` to use another backend. The backend
must allow the exact client Origin through `POCKETDECK_CORS_ORIGINS`.

The browser authorization form accepts an already-paired web-device
credential. It is kept in memory only and cleared when the page reloads or
the user disconnects. Pairing approval remains an administrator operation;
there is no browser pairing-approval UI.

## Windows packaged application

Packaged Windows builds include a self-contained FastAPI executable and its
runtime files. Build them with PyInstaller in the backend virtual environment:

```powershell
backend\.venv\Scripts\python.exe -m pip install -r backend\requirements-build.txt
```

Run that install command from the repository root when preparing build
dependencies. From this folder, `npm run tauri build` runs the Windows backend
build and frontend build before producing the Tauri package. Python is not
required on end-user machines.

## Windows desktop prerequisites

Tauri desktop builds require Rust with the MSVC toolchain, Microsoft C++
Build Tools with the C++ build workload and a Windows SDK, and the Microsoft
Edge WebView2 Runtime. See the official
[Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows)
for current setup instructions.
