use std::time::Duration;

use tokio::net::UnixStream;
use tonic::transport::{Channel, Endpoint, Uri};
use tonic::Request;
use tower::service_fn;

pub mod helloworld {
    tonic::include_proto!("helloworld");
}

use helloworld::greeter_client::GreeterClient;
use helloworld::HelloRequest;

async fn connect_via_unix_socket(path: &str) -> Result<Channel, Box<dyn std::error::Error>> {
    let endpoint = Endpoint::try_from("http://[::]:50051")?;
    let channel = endpoint
        .connect_with_connector(service_fn(move |_: Uri| {
            let path = path.to_owned();
            async move { UnixStream::connect(path).await }
        }))
        .await?;
    Ok(channel)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let socket_path = "/tmp/helloworld.sock";
    let mut client = GreeterClient::new(connect_via_unix_socket(socket_path).await?);

    let request = Request::new(HelloRequest {
        name: "world".into(),
    });

    let response =
        tokio::time::timeout(Duration::from_secs(1), client.say_hello(request)).await??;
    println!("Greeting: {}", response.into_inner().message);

    Ok(())
}
