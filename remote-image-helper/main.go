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
	if flag.NArg() > 0 {
		executablePath, err := os.Executable()
		if err != nil {
			return fmt.Errorf("find helper executable: %w", err)
		}
		switch flag.Arg(0) {
		case "install":
			configuration, configErr := configFromEnvironment(os.Getenv)
			if configErr != nil {
				return configErr
			}
			plan, installErr := installHelper(executablePath, configuration)
			if installErr != nil {
				return installErr
			}
			fmt.Printf("Installed remote image helper for %s. Configure remote pi with PI_AGENT_SUITE_MODE=remote and PI_AGENT_SUITE_IMAGE_PORT=%d.\n", configuration.SSHTarget, configuration.ImagePort)
			fmt.Printf("Saved local configuration to %s.\n", plan.ConfigPath)
			if plan.LogPath != "" {
				fmt.Printf("Runtime and SSH diagnostics: %s\n", plan.LogPath)
			} else {
				fmt.Printf("Runtime and SSH diagnostics: journalctl --user -u %s\n", linuxServiceName)
			}
			return nil
		case "remove":
			if flag.NArg() != 2 || flag.Arg(1) == "" {
				return fmt.Errorf("usage: remote-image remove <ssh-target>")
			}
			plan, remaining, removeErr := removeHelper(executablePath, flag.Arg(1))
			if removeErr != nil {
				return removeErr
			}
			if remaining == 0 {
				fmt.Printf("Removed %s and uninstalled remote image helper.\n", flag.Arg(1))
			} else {
				fmt.Printf("Removed %s. %d remote server configurations remain in %s.\n", flag.Arg(1), remaining, plan.ConfigPath)
			}
			return nil
		default:
			return fmt.Errorf("unknown command %q", flag.Arg(0))
		}
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
