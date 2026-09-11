package main

import (
	"context"
	"errors"
	"testing"
)

func TestLocalImagePortUsesOneSharedListener(t *testing.T) {
	// Purpose: adding a server with a different remote port must not require another local listener that can break existing servers.
	// Input and expected output: the first configured target selects the helper's one local listener port.
	// Edge case: later targets use different remote ports.
	// Dependencies: none.
	configurations := []config{{SSHTarget: "first", ImagePort: 18775}, {SSHTarget: "second", ImagePort: 19000}}
	if got := localImagePort(configurations); got != 18775 {
		t.Fatalf("local port = %d, want 18775", got)
	}
}

func TestRuntimeWaitsForTunnelShutdown(t *testing.T) {
	// Purpose: helper exit must not leave SSH running during reinstallation.
	// Input and expected output: cancellation shuts down HTTP and waits until the tunnel acknowledges exit.
	// Edge case: tunnel cleanup takes longer than HTTP shutdown.
	// Dependencies: server and tunnel are channel-controlled fakes.
	ctx, cancel := context.WithCancel(context.Background())
	started := make(chan struct{})
	stopping := make(chan struct{})
	release := make(chan struct{})
	shutdown := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- runServices(ctx, func() error { <-shutdown; return nil }, func(context.Context) error { close(shutdown); return nil }, func(ctx context.Context) { close(started); <-ctx.Done(); close(stopping); <-release })
	}()
	<-started
	cancel()
	<-stopping
	select {
	case err := <-done:
		t.Fatalf("returned before SSH cleanup: %v", err)
	default:
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeCancelsTunnelOnServerFailure(t *testing.T) {
	// Purpose: HTTP failure must stop the SSH process before returning the error.
	// Input and expected output: server error cancels the tunnel and retains its cause.
	// Edge case: tunnel starts concurrently with an immediate server error.
	// Dependencies: runtime services use fakes; no network or clipboard access.
	failure := errors.New("listener failed")
	stopped := false
	err := runServices(context.Background(), func() error { return failure }, func(context.Context) error { return nil }, func(ctx context.Context) { <-ctx.Done(); stopped = true })
	if !errors.Is(err, failure) || !stopped {
		t.Fatalf("error = %v, tunnel stopped = %v", err, stopped)
	}
}
