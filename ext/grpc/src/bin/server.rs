use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio_stream::wrappers::UnixListenerStream;
use tokio_util::sync::CancellationToken;
use tonic::transport::Server;
use tonic::{Request, Response, Status};

pub mod proto {
    tonic::include_proto!("codex");
}

use proto::codex_cli_server::{CodexCli, CodexCliServer};
use proto::{RunCommandRequest, RunCommandResponse};

const DEFAULT_SOCKET_PATH: &str = "/tmp/codex-grpc.sock";
const CLI_ENV_VAR: &str = "CODEX_GRPC_CLI_BIN";

#[derive(Debug, Parser)]
#[command(
    name = "codex-grpc-server",
    about = "Run the Codex gRPC bridge for the CLI",
    version
)]
struct Args {
    /// Path to the Unix-domain socket to listen on.
    #[arg(long = "socket-path", env = "CODEX_GRPC_SOCKET", default_value = DEFAULT_SOCKET_PATH)]
    socket_path: PathBuf,

    /// Override for the Codex CLI executable to run.
    #[arg(long = "cli-path", env = CLI_ENV_VAR)]
    cli_path: Option<PathBuf>,

    /// Maximum number of concurrent CLI invocations to allow.
    #[arg(long = "concurrency-limit")]
    concurrency_limit: Option<usize>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let shutdown_token = CancellationToken::new();
    let signal_token = shutdown_token.clone();

    let signal_task = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            signal_token.cancel();
        }
    });

    let result = run_server(args, shutdown_token.clone()).await;
    shutdown_token.cancel();
    let _ = signal_task.await;
    result
}

async fn run_server(args: Args, shutdown: CancellationToken) -> Result<()> {
    if let Some(parent) = args.socket_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).await.with_context(|| {
                let socket_path = args.socket_path.display();
                format!("failed to create parent directory for {socket_path}")
            })?;
        }
    }

    if args.socket_path.exists() {
        fs::remove_file(&args.socket_path).await.with_context(|| {
            let socket_path = args.socket_path.display();
            format!("failed to remove existing socket at {socket_path}")
        })?;
    }

    let listener = UnixListener::bind(&args.socket_path).with_context(|| {
        let socket_path = args.socket_path.display();
        format!("failed to bind unix socket at {socket_path}")
    })?;
    let _cleanup = SocketCleanup::new(args.socket_path.clone());

    let incoming = UnixListenerStream::new(listener);

    let service = CodexCliService::new(args.cli_path.clone(), args.concurrency_limit);

    Server::builder()
        .add_service(CodexCliServer::new(service))
        .serve_with_incoming_shutdown(incoming, shutdown.cancelled())
        .await
        .context("server error")
}

struct SocketCleanup {
    path: PathBuf,
}

impl SocketCleanup {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        if !self.path.as_os_str().is_empty() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

#[derive(Clone)]
struct CodexCliService {
    cli_path: Option<PathBuf>,
    concurrency: Option<Arc<Semaphore>>,
}

impl CodexCliService {
    fn new(cli_path: Option<PathBuf>, concurrency_limit: Option<usize>) -> Self {
        let concurrency = concurrency_limit.map(|limit| Arc::new(Semaphore::new(limit)));
        Self {
            cli_path,
            concurrency,
        }
    }

    fn resolve_cli_path(&self) -> Result<PathBuf, Status> {
        if let Some(path) = &self.cli_path {
            return Ok(path.clone());
        }

        if let Ok(env_path) = std::env::var(CLI_ENV_VAR) {
            return Ok(PathBuf::from(env_path));
        }

        let exe = std::env::current_exe().map_err(|err| {
            Status::internal(format!("failed to determine current executable: {err}"))
        })?;
        Ok(exe.with_file_name("codex"))
    }
}

#[tonic::async_trait]
impl CodexCli for CodexCliService {
    async fn run_command(
        &self,
        request: Request<RunCommandRequest>,
    ) -> Result<Response<RunCommandResponse>, Status> {
        let _permit = if let Some(semaphore) = &self.concurrency {
            Some(
                semaphore
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| Status::unavailable("server shutting down"))?,
            )
        } else {
            None
        };

        let input = request.into_inner();
        let cli_path = self.resolve_cli_path()?;

        let mut command = Command::new(cli_path.clone());
        command.args(&input.args);
        command.envs(input.env);

        if !input.cwd.is_empty() {
            command.current_dir(PathBuf::from(input.cwd));
        }

        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());

        let mut child = command.spawn().map_err(|err| {
            let display_path = cli_path.display();
            Status::internal(format!("failed to spawn {display_path}: {err}"))
        })?;

        if let Some(mut stdin) = child.stdin.take() {
            if let Err(err) = stdin.write_all(&input.stdin).await {
                return Err(Status::internal(format!("failed to write stdin: {err}")));
            }
            if let Err(err) = stdin.shutdown().await {
                return Err(Status::internal(format!("failed to flush stdin: {err}")));
            }
        }

        let stdout_future = read_stream(child.stdout.take());
        let stderr_future = read_stream(child.stderr.take());
        let wait_future = async {
            child
                .wait()
                .await
                .map_err(|err| Status::internal(format!("failed to wait for process: {err}")))
        };

        let (stdout, stderr, status) = tokio::try_join!(stdout_future, stderr_future, wait_future)?;

        let exit_code = exit_code(&status);

        Ok(Response::new(RunCommandResponse {
            exit_code,
            stdout,
            stderr,
        }))
    }
}

fn exit_code(status: std::process::ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        code
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            if let Some(signal) = status.signal() {
                return 128 + signal;
            }
        }
        -1
    }
}

async fn read_stream<T>(stream: Option<T>) -> Result<Vec<u8>, Status>
where
    T: tokio::io::AsyncRead + Unpin,
{
    let mut stream = if let Some(stream) = stream {
        stream
    } else {
        return Ok(Vec::new());
    };

    let mut buffer = Vec::new();
    stream
        .read_to_end(&mut buffer)
        .await
        .map_err(|err| Status::internal(format!("failed to read stream: {err}")))?;
    Ok(buffer)
}
