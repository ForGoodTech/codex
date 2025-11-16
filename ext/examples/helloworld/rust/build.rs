fn main() {
    tonic_build::configure()
        .build_server(true)
        .build_client(true)
        .compile(&["../helloworld.proto"], &["../"])
        .expect("failed to compile protos");
}
