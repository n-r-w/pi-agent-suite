package main

import (
	"context"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
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
	if err := copyExecutable(sourceExecutable, plan.BinaryPath); err != nil {
		return installationPlan{}, err
	}
	if err := writeConfig(plan.ConfigPath, configuration); err != nil {
		return installationPlan{}, err
	}
	if plan.StartupPath != "" {
		if err := writePrivateFile(plan.StartupPath, []byte(plan.StartupFile)); err != nil {
			return installationPlan{}, fmt.Errorf("write startup file: %w", err)
		}
	}
	if err := activateStartup(plan); err != nil {
		return installationPlan{}, err
	}
	return plan, nil
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

func writeConfig(path string, configuration config) error {
	contents, err := json.Marshal(&configuration, jsontext.WithIndent("  "))
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

func activateStartup(plan installationPlan) error {
	if plan.StartupCommand != nil {
		if err := runSetupCommand(*plan.StartupCommand); err != nil {
			return fmt.Errorf("register Windows logon task: %w", err)
		}
		return runSetupCommand(commandSpec{Name: "schtasks", Args: []string{"/Run", "/TN", "PiAgentSuiteRemoteImage"}})
	}
	if runtime.GOOS == "darwin" {
		domain := "gui/" + strconv.Itoa(os.Getuid())
		return activateLaunchAgent(domain, plan.StartupPath, runSetupCommand, listLaunchAgents)
	}
	command := exec.Command(plan.BinaryPath, "--config", plan.ConfigPath)
	command.Stdin = nil
	command.Stdout = nil
	command.Stderr = nil
	if err := command.Start(); err != nil {
		return fmt.Errorf("start helper: %w", err)
	}
	return command.Process.Release()
}

func runSetupCommand(specification commandSpec) error {
	return systemCommandRunner{}.Run(context.Background(), specification)
}
