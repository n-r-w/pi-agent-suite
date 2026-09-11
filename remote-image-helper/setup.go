package main

import (
	"context"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

func installHelper(sourceExecutable string, configuration config) (installationPlan, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return installationPlan{}, fmt.Errorf("find user home: %w", err)
	}
	plan, err := buildInstallationPlan(runtime.GOOS, home, os.Getenv("LOCALAPPDATA"))
	if err != nil {
		return installationPlan{}, err
	}
	commands := setupCommands{run: runSetupCommand, capture: captureSetupCommand}
	if err := plan.installTarget(sourceExecutable, configuration, runtime.GOOS, commands); err != nil {
		return installationPlan{}, err
	}
	return plan, nil
}

func removeHelper(sourceExecutable, target string) (installationPlan, int, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return installationPlan{}, 0, fmt.Errorf("find user home: %w", err)
	}
	plan, err := buildInstallationPlan(runtime.GOOS, home, os.Getenv("LOCALAPPDATA"))
	if err != nil {
		return installationPlan{}, 0, err
	}
	commands := setupCommands{run: runSetupCommand, capture: captureSetupCommand}
	remaining, err := plan.removeTarget(sourceExecutable, target, runtime.GOOS, commands)
	if err != nil {
		return installationPlan{}, 0, err
	}
	return plan, remaining, nil
}

func configFromEnvironment(getenv func(string) string) (config, error) {
	port := defaultImagePort
	if value := getenv("PI_AGENT_SUITE_IMAGE_PORT"); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil {
			return config{}, fmt.Errorf("PI_AGENT_SUITE_IMAGE_PORT must be an integer from 1 to 65535")
		}
		port = parsed
	}
	configuration := config{
		SSHTarget:   getenv("PI_AGENT_SUITE_SSH_TARGET"),
		SSHPassword: getenv("PI_AGENT_SUITE_SSH_PASSWORD"),
		ImagePort:   port,
	}
	if configuration.SSHTarget == "" {
		return config{}, fmt.Errorf("PI_AGENT_SUITE_SSH_TARGET is required")
	}
	if port < minimumPort || port > maximumPort {
		return config{}, fmt.Errorf("PI_AGENT_SUITE_IMAGE_PORT must be an integer from 1 to 65535")
	}
	return configuration, nil
}

func copyExecutable(source, destination string) error {
	if err := checkExecutableSource(source, destination); err != nil {
		return err
	}
	input, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("open helper executable: %w", err)
	}
	defer input.Close()
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return fmt.Errorf("create helper directory: %w", err)
	}
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return fmt.Errorf("create installed helper: %w", err)
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		return fmt.Errorf("copy helper executable: %w", copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close installed helper: %w", closeErr)
	}
	return nil
}

// checkExecutableSource prevents an installer from stopping or overwriting itself.
func checkExecutableSource(source, destination string) error {
	input, err := os.Stat(source)
	if err != nil {
		return fmt.Errorf("stat helper source: %w", err)
	}
	output, err := os.Stat(destination)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("stat installed helper: %w", err)
	}
	if os.SameFile(input, output) {
		return fmt.Errorf("run install from the downloaded or built helper, not the installed executable")
	}
	return nil
}

func writeConfigs(path string, configurations []config) error {
	contents, err := json.Marshal(&storedConfig{Targets: configurations}, jsontext.WithIndent("  "))
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	contents = append(contents, '\n')
	if err := writePrivateFile(path, contents); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	return nil
}

func writePrivateFile(path string, contents []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

func runSetupCommand(specification commandSpec) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return systemCommandRunner{}.Run(ctx, specification)
}
