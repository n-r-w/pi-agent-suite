package main

import (
	"context"
	"fmt"
	"log"
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

func buildSSHCommands(configurations []config, executablePath, configPath string) []commandSpec {
	commands := make([]commandSpec, 0, len(configurations))
	localPort := localImagePort(configurations)
	for _, configuration := range configurations {
		commands = append(commands, buildSSHCommandToPort(configuration, localPort, executablePath, configPath))
	}
	return commands
}

func buildSSHCommand(configuration config, executablePath, configPath string) commandSpec {
	return buildSSHCommandToPort(configuration, configuration.ImagePort, executablePath, configPath)
}

func buildSSHCommandToPort(configuration config, localPort int, executablePath, configPath string) commandSpec {
	remotePort := strconv.Itoa(configuration.ImagePort)
	arguments := []string{
		"-N", "-T",
		"-o", "ExitOnForwardFailure=yes",
		"-o", "ServerAliveInterval=30",
		"-o", "ServerAliveCountMax=3",
		"-R", fmt.Sprintf("127.0.0.1:%s:127.0.0.1:%d", remotePort, localPort),
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
			"PI_AGENT_SUITE_ASKPASS_TARGET="+configuration.SSHTarget,
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
		if err := runner.Run(ctx, command); err != nil && ctx.Err() == nil {
			log.Printf("SSH tunnel failed: %v; reconnecting", err)
		}
		if ctx.Err() != nil || !waitForRetry(ctx) {
			return
		}
	}
}
