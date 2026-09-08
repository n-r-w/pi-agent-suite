package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// activateLaunchAgent stops only registered services and retains command failures.
func activateLaunchAgent(domain, path string, run func(commandSpec) error, list func() ([]byte, error)) error {
	listing, err := list()
	if err != nil {
		return fmt.Errorf("list LaunchAgents: %w", err)
	}
	if launchAgentRegistered(string(listing)) {
		if err := run(commandSpec{Name: "launchctl", Args: []string{"bootout", domain + "/" + launchAgentName}}); err != nil {
			return fmt.Errorf("stop LaunchAgent: %w", err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := waitForLaunchAgentRemoval(ctx, list); err != nil {
			return err
		}
	}
	if err := run(commandSpec{Name: "launchctl", Args: []string{"bootstrap", domain, path}}); err != nil {
		return fmt.Errorf("register LaunchAgent: %w", err)
	}
	return nil
}

// waitForLaunchAgentRemoval waits for launchd to finish asynchronous service removal.
func waitForLaunchAgentRemoval(ctx context.Context, list func() ([]byte, error)) error {
	for {
		listing, err := list()
		if err != nil {
			return fmt.Errorf("check LaunchAgent removal: %w", err)
		}
		if !launchAgentRegistered(string(listing)) {
			return nil
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("wait for LaunchAgent removal: %w", ctx.Err())
		case <-timer.C:
		}
	}
}

// launchAgentRegistered includes registered services without a running process.
func launchAgentRegistered(listing string) bool {
	for _, line := range strings.Split(listing, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 3 && fields[2] == launchAgentName {
			return true
		}
	}
	return false
}

// listLaunchAgents reads the current user's service list without issuing a failing lookup for an absent label.
func listLaunchAgents() ([]byte, error) {
	command := exec.Command("launchctl", "list")
	command.Stderr = os.Stderr
	return command.Output()
}
