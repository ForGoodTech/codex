use std::path::Path;

use tokio::net::UnixListener;
use tokio_stream::wrappers::UnixListenerStream;
use tonic::{transport::Server, Request, Response, Status};

pub mod helloworld {
    tonic::include_proto!("helloworld");
}

use helloworld::greeter_server::{Greeter, GreeterServer};
use helloworld::{HelloReply, HelloRequest};

const SOCKET_PATH: &str = "/tmp/helloworld.sock";

#[derive(Default)]
struct MyGreeter;

#[tonic::async_trait]
impl Greeter for MyGreeter {
    async fn say_hello(
        &self,
        request: Request<HelloRequest>,
    ) -> Result<Response<HelloReply>, Status> {
        let name = request.into_inner().name;
        let reply = HelloReply {
            message: format!("Hello {}", name),
        };
        Ok(Response::new(reply))
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if Path::new(SOCKET_PATH).exists() {
        std::fs::remove_file(SOCKET_PATH)?;
    }

    let listener = UnixListener::bind(SOCKET_PATH)?;
    let incoming = UnixListenerStream::new(listener);

    println!("Server listening on UDS: {}", SOCKET_PATH);

    Server::builder()
        .add_service(GreeterServer::new(MyGreeter::default()))
        .serve_with_incoming(incoming)
        .await?;

    Ok(())
}
