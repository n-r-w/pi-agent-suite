package main

import (
	"context"
	"errors"
	"time"
)

// runServices joins the SSH worker before the helper process can exit.
func runServices(ctx context.Context, serve func() error, shutdown func(context.Context) error, tunnel func(context.Context)) error {
	tunnelCtx, cancel := context.WithCancel(ctx)
	tunnelDone := make(chan struct{})
	go func() { defer close(tunnelDone); tunnel(tunnelCtx) }()
	defer func() { cancel(); <-tunnelDone }()
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- serve() }()
	var serveErr error
	select {
	case <-ctx.Done():
	case serveErr = <-serveErrors:
	}
	cancel()
	shutdownCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	return errors.Join(serveErr, shutdown(shutdownCtx))
}
