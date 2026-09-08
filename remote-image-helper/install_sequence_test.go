package main

import (
	"encoding/json/v2"
	"os"
	"path/filepath"
	"testing"
)

func TestPlatformReinstallReplacesFilesAfterShutdown(t *testing.T) {
	// Purpose: prove production wiring, not only the abstract order of injected steps.
	// Input and expected output: old files remain during platform stop; new files exist before manager startup.
	// Edge cases: macOS and Windows report shutdown through a later status query.
	// Dependencies: files are isolated fixtures; all service commands and status reads are fakes.
	for _, goos := range []string{"darwin", "linux", "windows"} {
		t.Run(goos, func(t *testing.T) {
			dir := t.TempDir()
			source := filepath.Join(dir, "download")
			plan := installationPlan{BinaryPath: filepath.Join(dir, "helper"), ConfigPath: filepath.Join(dir, "config.json"), StartupPath: filepath.Join(dir, "startup"), StartupFile: "startup fixture", StartupCommand: &commandSpec{Name: "schtasks", Args: []string{"/Create"}}}
			for name, contents := range map[string]string{source: "new binary", plan.BinaryPath: "old binary", plan.ConfigPath: "old config", plan.StartupPath: "old startup"} {
				if err := os.WriteFile(name, []byte(contents), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			stopped := false
			observedStopped := false
			checkBinary := func(want string) {
				t.Helper()
				data, err := os.ReadFile(plan.BinaryPath)
				if err != nil {
					t.Fatal(err)
				}
				if string(data) != want {
					t.Fatalf("binary = %q, want %q", data, want)
				}
			}
			commands := setupCommands{
				run: func(c commandSpec) error {
					action := c.Args[0]
					if c.Name == "systemctl" {
						action = c.Args[1]
					}
					switch action {
					case "is-active", "/Change":
						checkBinary("old binary")
					case "bootout", "stop", "/PID":
						checkBinary("old binary")
						stopped = true
						if goos == "linux" {
							observedStopped = true
						}
					default:
						if !observedStopped {
							t.Fatalf("startup before shutdown observation: %#v", c)
						}
						checkBinary("new binary")
						data, err := os.ReadFile(plan.ConfigPath)
						if err != nil {
							t.Fatal(err)
						}
						var saved config
						if err := json.Unmarshal(data, &saved); err != nil {
							t.Fatal(err)
						}
						if saved.SSHTarget != "new-target" {
							t.Fatalf("config = %#v", saved)
						}
					}
					return nil
				},
				capture: func(commandSpec) ([]byte, error) {
					checkBinary("old binary")
					if stopped {
						observedStopped = true
					}
					switch goos {
					case "darwin":
						if stopped {
							return nil, nil
						}
						return []byte("-\t0\t" + launchAgentName + "\n"), nil
					case "linux":
						return []byte(linuxServiceName + " loaded active running Helper\n"), nil
					default:
						state := windowsServiceState{TaskExists: true}
						if !stopped {
							state.TaskRunning = true
							state.Processes = []windowsProcess{{PID: 123, Path: plan.BinaryPath, Created: "fixture"}}
						}
						return json.Marshal(state)
					}
				},
			}
			if err := plan.install(source, config{SSHTarget: "new-target", ImagePort: 18775}, goos, commands); err != nil {
				t.Fatal(err)
			}
			checkBinary("new binary")
		})
	}
}
