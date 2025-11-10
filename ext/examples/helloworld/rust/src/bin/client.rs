use tokio::net::UnixStream;
use tonic::transport::{
    Channel,
    Endpoint,
    Uri,
};
use tower::service_fn;

pub mod helloworld
{
    tonic::include_proto!("helloworld");
}

use helloworld::{
    greeter_client::GreeterClient,
    HelloRequest,
};

async fn connect_via_unix_socket(path: impl Into<String>) -> Result<Channel, Box<dyn std::error::Error>>
{
    let path = path.into();

    let endpoint = Endpoint::try_from("http://[::]:50051")?;

    let channel = endpoint
        .connect_with_connector(service_fn(move |_: Uri|
        {
            let path = path.clone();

            async move
            {
                UnixStream::connect(path).await
            }
        }))
        .await?;

    Ok(channel)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>>
{
    // Must match the server's "Server listening on /tmp/helloworld.sock"
    let channel = connect_via_unix_socket("/tmp/helloworld.sock").await?;

    let mut client = GreeterClient::new(channel);

    let request = tonic::Request::new(
        HelloRequest
        {
            name: "Codex".to_string(),
        }
    );

    let response = client.say_hello(request).await?;

    println!("Server replied: {}", response.into_inner().message);

    Ok(())
}

