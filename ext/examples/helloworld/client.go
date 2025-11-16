package main

import (
    "context"
    "fmt"
    "log"
    "time"

    pb "example.com/helloworld/helloworldpb"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

const socketAddr = "/tmp/helloworld.sock"

func main() {
    conn, err := grpc.Dial(
        "unix://"+socketAddr,
        grpc.WithTransportCredentials(insecure.NewCredentials()),
    )
    if err != nil {
        log.Fatalf("did not connect: %v", err)
    }
    defer conn.Close()

    c := pb.NewGreeterClient(conn)

    ctx, cancel := context.WithTimeout(context.Background(), time.Second)
    defer cancel()

    r, err := c.SayHello(ctx, &pb.HelloRequest{
        Name: "World of the Client",
    })
    if err != nil {
        log.Fatalf("could not greet: %v", err)
    }

    fmt.Println("Returned from the Server:", r.Message)
}

