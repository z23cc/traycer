# `@traycer/host`

Local Traycer host daemon. Speaks the versioned `/rpc` and `/stream`
WebSocket contracts in `@traycer/protocol`.

This is an OSS implementation of the host process the CLI supervises
(`traycer host start` → `--host-data-dir …`). It is not the signed
registry binary.

```sh
bun run --cwd host traycer-host --host-data-dir "$HOME/.traycer/host/oss"
```

Listens on `127.0.0.1` with an ephemeral port, then writes `pid.json`
(same shape the CLI and desktop already read). `GET /activity` returns
`{"busy":false}`.

Default data dir (when `--host-data-dir` is omitted) is
`~/.traycer/host/oss` so a side-by-side run does not overwrite a
registry-installed host under `~/.traycer/host`.
