package main

import (
	"context"
	"fmt"
	"strconv"
)

type commandSpec struct {
	Name        string
	Args        []string
	Environment []string
}

type commandRunner interface {
	Run(context.Context, commandSpec) error
}

func buildSSHCommand(configuration config, executablePath, configPath string) commandSpec {
	port := strconv.Itoa(configuration.ImagePort)
	arguments := []string{
		"-N", "-T",
		"-o", "ExitOnForwardFailure=yes",
		"-o", "ServerAliveInterval=30",
		"-o", "ServerAliveCountMax=3",
		"-R", fmt.Sprintf("127.0.0.1:%s:127.0.0.1:%s", port, port),
	}
	environment := []string{}
	if configuration.SSHPassword != "" {
		arguments = append(arguments,
			"-o", "PreferredAuthentications=keyboard-interactive,password",
			"-o", "PubkeyAuthentication=no",
		)
		environment = append(environment,
			"SSH_ASKPASS="+executablePath,
			"SSH_ASKPASS_REQUIRE=force",
			"PI_AGENT_SUITE_ASKPASS=1",
			"PI_AGENT_SUITE_IMAGE_CONFIG="+configPath,
		)
	}
	arguments = append(arguments, configuration.SSHTarget)
	return commandSpec{Name: "ssh", Args: arguments, Environment: environment}
}

func runTunnel(
	ctx context.Context,
	runner commandRunner,
	command commandSpec,
	waitForRetry func(context.Context) bool,
) {
	for ctx.Err() == nil {
		_ = runner.Run(ctx, command)
		if ctx.Err() != nil || !waitForRetry(ctx) {
			return
		}
	}
}
