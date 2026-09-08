package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"runtime"
	"syscall"
)

func main() {
	if err := execute(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func execute() error {
	if os.Getenv("PI_AGENT_SUITE_ASKPASS") == "1" {
		return runAskpass(os.Getenv("PI_AGENT_SUITE_IMAGE_CONFIG"), os.Stdout)
	}

	configPath := flag.String("config", "", "path to the remote image helper configuration")
	logPath := flag.String("log", "", "append runtime and SSH diagnostics to this file")
	flag.Parse()
	if *logPath != "" {
		if err := configureRuntimeLog(*logPath); err != nil {
			return err
		}
	}
	if flag.NArg() > 0 && flag.Arg(0) == "install" {
		configuration, err := configFromEnvironment(os.Getenv)
		if err != nil {
			return err
		}
		executablePath, err := os.Executable()
		if err != nil {
			return fmt.Errorf("find helper executable: %w", err)
		}
		plan, err := installHelper(executablePath, configuration)
		if err != nil {
			return err
		}
		fmt.Printf("Installed remote image helper. Configure remote pi with PI_AGENT_SUITE_MODE=remote and PI_AGENT_SUITE_IMAGE_PORT=%d.\n", configuration.ImagePort)
		fmt.Printf("Saved local configuration to %s.\n", plan.ConfigPath)
		if plan.LogPath != "" {
			fmt.Printf("Runtime and SSH diagnostics: %s\n", plan.LogPath)
		} else {
			fmt.Printf("Runtime and SSH diagnostics: journalctl --user -u %s\n", linuxServiceName)
		}
		return nil
	}

	resolvedConfigPath := *configPath
	if resolvedConfigPath == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("find user home: %w", err)
		}
		plan, err := buildInstallationPlan(runtime.GOOS, home, os.Getenv("LOCALAPPDATA"))
		if err != nil {
			return err
		}
		resolvedConfigPath = plan.ConfigPath
	}
	executablePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("find helper executable: %w", err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return run(ctx, resolvedConfigPath, executablePath)
}
