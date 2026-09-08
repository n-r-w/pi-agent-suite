package main

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"time"
)

// stopStartup completes platform shutdown before installation writes any files.
func stopStartup(goos string, plan installationPlan, commands setupCommands) error {
	switch goos {
	case "darwin":
		return stopLaunchAgent("gui/"+strconv.Itoa(os.Getuid()), commands.run, func() ([]byte, error) {
			return commands.capture(commandSpec{Name: "launchctl", Args: []string{"list"}})
		})
	case "linux":
		if err := commands.run(commandSpec{Name: "systemctl", Args: []string{"--user", "is-active", "graphical-session.target"}}); err != nil {
			return fmt.Errorf("Linux setup requires an active systemd graphical user session: %w", err)
		}
		return stopLinuxService(commands)
	case "windows":
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return stopWindowsService(ctx, plan.BinaryPath, commands.run, func() (windowsServiceState, error) { return queryWindowsService(commands.capture) })
	default:
		return fmt.Errorf("unsupported platform %q", goos)
	}
}

func startStartup(goos string, plan installationPlan, commands setupCommands) error {
	switch goos {
	case "darwin":
		if err := commands.run(commandSpec{Name: "launchctl", Args: []string{"bootstrap", "gui/" + strconv.Itoa(os.Getuid()), plan.StartupPath}}); err != nil {
			return fmt.Errorf("register LaunchAgent: %w", err)
		}
	case "linux":
		if err := commands.run(commandSpec{Name: "systemctl", Args: []string{"--user", "daemon-reload"}}); err != nil {
			return fmt.Errorf("reload systemd user units: %w", err)
		}
		// The installer runs in the graphical session; do not import unrelated shell variables or secrets.
		args := []string{"--user", "import-environment"}
		for _, key := range []string{"DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"} {
			if os.Getenv(key) != "" {
				args = append(args, key)
			}
		}
		if len(args) > 2 {
			if err := commands.run(commandSpec{Name: "systemctl", Args: args}); err != nil {
				return fmt.Errorf("import graphical session environment: %w", err)
			}
		}
		if err := commands.run(commandSpec{Name: "systemctl", Args: []string{"--user", "enable", "--now", linuxServiceName}}); err != nil {
			return fmt.Errorf("enable systemd user service: %w", err)
		}
	case "windows":
		if err := commands.run(*plan.StartupCommand); err != nil {
			return fmt.Errorf("register Windows logon task: %w", err)
		}
		if err := commands.run(commandSpec{Name: "schtasks", Args: []string{"/Run", "/TN", windowsTaskName}}); err != nil {
			return fmt.Errorf("start Windows logon task: %w", err)
		}
	default:
		return fmt.Errorf("unsupported platform %q", goos)
	}
	return nil
}
