# Codex gRPC server

The `codex-grpc` crate exposes the Codex CLI over a Unix-domain socket using gRPC.
It translates `RunCommand` requests into local CLI invocations so that external
processes can drive Codex without shelling out directly.

## Usage

```bash
cargo run --bin server -- --socket-path /tmp/codex-grpc.sock
```

Key flags:

- `--socket-path` (env: `CODEX_GRPC_SOCKET`): location of the Unix socket. The
  default is `/tmp/codex-grpc.sock`.
- `--cli-path` (env: `CODEX_GRPC_CLI_BIN`): override the Codex CLI executable to
  invoke. When omitted the server looks for a `codex` binary next to the running
  executable.
- `--concurrency-limit`: optional maximum number of concurrent CLI invocations.

The server listens on the configured socket and handles unary
`CodexCli.RunCommand` RPCs defined in [`proto/codex.proto`](proto/codex.proto).
Each request can specify CLI arguments, environment variables, working

directory, and stdin payload; the response carries the exit status alongside the
combined stdout and stderr buffers.

The server shuts down gracefully when it receives `SIGINT`/Ctrl+C or when the
cancellation token used by embedding code is triggered.
