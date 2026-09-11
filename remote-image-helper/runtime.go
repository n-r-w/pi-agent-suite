package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.design/x/clipboard"
)

const reconnectDelay = 2 * time.Second

type nativeClipboard struct{}

func (nativeClipboard) ReadImage(ctx context.Context) ([]byte, error) {
	image, err := clipboard.Read(ctx, clipboard.FmtImage)
	return normalizeClipboardImage(image, err)
}

func localImagePort(configurations []config) int {
	return configurations[0].ImagePort
}

func normalizeClipboardImage(image []byte, err error) ([]byte, error) {
	if errors.Is(err, clipboard.ErrNoData) {
		return nil, nil
	}
	return image, err
}

type systemCommandRunner struct{}

func mergeEnvironment(base, overrides []string) []string {
	overriddenKeys := make(map[string]struct{}, len(overrides))
	for _, value := range overrides {
		overriddenKeys[environmentKey(value)] = struct{}{}
	}
	merged := make([]string, 0, len(base)+len(overrides))
	for _, value := range base {
		if _, overridden := overriddenKeys[environmentKey(value)]; !overridden {
			merged = append(merged, value)
		}
	}
	return append(merged, overrides...)
}

func environmentKey(value string) string {
	key, _, _ := strings.Cut(value, "=")
	return key
}

func (systemCommandRunner) Run(ctx context.Context, specification commandSpec) error {
	command := exec.CommandContext(ctx, specification.Name, specification.Args...)
	command.Env = mergeEnvironment(os.Environ(), specification.Environment)
	command.Stdin = nil
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	return command.Run()
}

func run(ctx context.Context, configPath, executablePath string) error {
	configurations, err := loadConfigs(configPath, os.Getenv)
	if err != nil {
		return err
	}
	if err := clipboard.Init(); err != nil {
		return fmt.Errorf("initialize clipboard: %w", err)
	}

	server := &http.Server{
		Addr:              "127.0.0.1:" + strconv.Itoa(localImagePort(configurations)),
		Handler:           newImageHandler(nativeClipboard{}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	listener, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return fmt.Errorf("listen for clipboard images: %w", err)
	}
	return runServices(ctx, func() error {
		err := server.Serve(listener)
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}, func(ctx context.Context) error {
		if err := server.Shutdown(ctx); err != nil {
			return errors.Join(err, server.Close())
		}
		return nil
	}, func(ctx context.Context) {
		commands := buildSSHCommands(configurations, executablePath, configPath)
		var tunnels sync.WaitGroup
		for _, command := range commands {
			tunnels.Go(func() {
				runTunnel(ctx, systemCommandRunner{}, command, waitForReconnect)
			})
		}
		tunnels.Wait()
	})
}

func waitForReconnect(ctx context.Context) bool {
	timer := time.NewTimer(reconnectDelay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
