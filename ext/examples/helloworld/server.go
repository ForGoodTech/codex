package main

import (
    "context"
    "fmt"
    "log"
    "net"
    "os"

    pb "example.com/helloworld/helloworldpb"
    "google.golang.org/grpc"
)

const socketAddr = "/tmp/helloworld.sock"

type greeterServer struct {
    pb.UnimplementedGreeterServer
}

func (s *greeterServer) SayHello(ctx context.Context, in *pb.HelloRequest) (*pb.HelloReply, error) {
    return &pb.HelloReply{
        Message: "Hello " + in.Name,
    }, nil
}

func main() {
    if _, err := os.Stat(socketAddr); err == nil {
        os.Remove(socketAddr)
    }

    lis, err := net.Listen("unix", socketAddr)
    if err != nil {
        log.Fatalf("failed to listen: %v", err)
    }
    defer lis.Close()

    grpcServer := grpc.NewServer()
    pb.RegisterGreeterServer(grpcServer, &greeterServer{})

    fmt.Println("Server listening on UDS:", socketAddr)

    if err := grpcServer.Serve(lis); err != nil {
        log.Fatalf("failed to serve: %v", err)
    }
}

