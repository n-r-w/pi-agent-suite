package main

import (
	"context"
	"encoding/json/v2"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

const linuxServiceName = "pi-agent-suite-remote-image.service"
const windowsTaskName = "PiAgentSuiteRemoteImage"

// setupCommands separates streaming command diagnostics from machine-readable status output.
type setupCommands struct {
	run     func(commandSpec) error
	capture func(commandSpec) ([]byte, error)
}

func stopLinuxService(commands setupCommands) error {
	listing, err := commands.capture(commandSpec{Name: "systemctl", Args: []string{"--user", "list-units", "--all", "--plain", "--no-legend", "--no-pager"}})
	if err != nil {
		return fmt.Errorf("list systemd user units: %w", err)
	}
	for _, line := range strings.Split(string(listing), "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 && fields[0] == linuxServiceName {
			// systemctl stop is synchronous; KillMode=control-group also stops SSH and askpass.
			if err := commands.run(commandSpec{Name: "systemctl", Args: []string{"--user", "stop", linuxServiceName}}); err != nil {
				return fmt.Errorf("stop systemd user service: %w", err)
			}
			return nil
		}
	}
	return nil
}

// captureSetupCommand preserves stderr while collecting structured stdout.
func captureSetupCommand(specification commandSpec) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, specification.Name, specification.Args...)
	command.Env = mergeEnvironment(os.Environ(), specification.Environment)
	command.Stderr = os.Stderr
	return command.Output()
}

// queryWindowsService uses invariant JSON rather than localized schtasks status text.
func queryWindowsService(capture func(commandSpec) ([]byte, error)) (windowsServiceState, error) {
	script := `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$task = @(Get-ScheduledTask | Where-Object { $_.TaskName -eq 'PiAgentSuiteRemoteImage' -and $_.TaskPath -eq '\' })
$processes = @(Get-CimInstance Win32_Process | ForEach-Object {
 [ordered]@{ pid = $_.ProcessId; parentPID = $_.ParentProcessId; path = $_.ExecutablePath; created = [string]$_.CreationDate }
})
[ordered]@{ taskExists = ($task.Count -gt 0); taskRunning = (@($task | Where-Object { $_.State -eq 'Running' }).Count -gt 0); processes = $processes } | ConvertTo-Json -Depth 4 -Compress
`
	output, err := capture(commandSpec{Name: "powershell.exe", Args: []string{"-NoProfile", "-NonInteractive", "-Command", script}})
	if err != nil {
		return windowsServiceState{}, err
	}
	var state windowsServiceState
	if err := json.Unmarshal(output, &state); err != nil {
		return state, fmt.Errorf("decode Windows service status: %w", err)
	}
	return state, nil
}
