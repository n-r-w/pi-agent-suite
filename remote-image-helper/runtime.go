package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"golang.design/x/clipboard"
)

const reconnectDelay = 2 * time.Second

type nativeClipboard struct{}

func (nativeClipboard) ReadImage(ctx context.Context) ([]byte, error) {
	image, err := clipboard.Read(ctx, clipboard.FmtImage)
	return normalizeClipboardImage(image, err)
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
	configuration, err := loadConfig(configPath, os.Getenv)
	if err != nil {
		return err
	}
	if err := clipboard.Init(); err != nil {
		return fmt.Errorf("initialize clipboard: %w", err)
	}

	server := &http.Server{
		Addr:              "127.0.0.1:" + strconv.Itoa(configuration.ImagePort),
		Handler:           newImageHandler(nativeClipboard{}),
		ReadHeaderTimeout: 5 * time.Second,
	}
	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- server.ListenAndServe()
	}()
	go runTunnel(
		ctx,
		systemCommandRunner{},
		buildSSHCommand(configuration, executablePath, configPath),
		waitForReconnect,
	)

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	case err := <-serverErrors:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve clipboard image: %w", err)
	}
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
