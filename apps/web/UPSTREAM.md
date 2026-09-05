# Upstream provenance

This safe UI subset uses the visual and interaction language of the following
MIT-licensed project as a fixed reference:

- Repository: https://github.com/xing-shuyin/pi-web-ui
- Imported reference commit: `f5b6662f908ba87e92734699d6f3156f8756bf87`
- Commit subject: `feat: global prompt history, directory picker with create folder and UI polish`
- Import date: 2026-09-04

Only the broad chat/stream, lane navigation, tool-card, theme, and responsive
panel ideas were reimplemented. No upstream source file is copied wholesale.

The following upstream surfaces were intentionally deleted from this import:

- terminal and PTY views
- file browsing, file mutation, upload/download, and tree views
- Git/source-control views
- plugin loading, plugin views, and self-update controls
- persistent or browser-managed model credentials
- goal auto-loop and background-process controls
- MCP/DSH/general-purpose tool routing
- server, deployment, Docker, systemd, and launchd machinery

Tyche adds a narrowly scoped model-connection form that is not present in the
imported safe subset. Its provider and model choices are fixed, its API key is
sent only to the loopback control plane, and the connection lives only for the
current authenticated control-plane session. It is cleared on logout, session
expiry, or server restart and cannot configure testnet or production trading.

This app does not persist browser credentials or conversation history. It talks
only to the Tyche loopback control-plane projection API.
