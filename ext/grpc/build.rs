fn main() {
    tonic_build::configure()
        .compile(&["proto/codex.proto"], &["proto"])
        .expect("failed to compile protos");
}
