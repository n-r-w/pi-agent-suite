package main

import (
	"encoding/json/v2"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestInstallTargetPreservesExistingServers(t *testing.T) {
	// Purpose: installing another remote server must preserve all existing server connections.
	// Input and expected output: a legacy one-server config plus a new target is saved as a two-target config.
	// Edge case: the old single-server JSON format is migrated during installation.
	// Dependencies: files and service-manager commands are isolated fixtures and fakes.
	dir := t.TempDir()
	source := filepath.Join(dir, "download")
	plan := installationPlan{BinaryPath: filepath.Join(dir, "helper"), ConfigPath: filepath.Join(dir, "config.json")}
	if err := os.WriteFile(source, []byte("new binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plan.ConfigPath, []byte(`{"sshTarget":"old","imagePort":18775}`), 0o600); err != nil {
		t.Fatal(err)
	}
	commands := setupCommands{
		run:     func(commandSpec) error { return nil },
		capture: func(commandSpec) ([]byte, error) { return nil, nil },
	}
	if err := plan.installTarget(source, config{SSHTarget: "new", ImagePort: 19000}, "linux", commands); err != nil {
		t.Fatal(err)
	}
	got, err := loadConfigs(plan.ConfigPath, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	want := []config{{SSHTarget: "old", ImagePort: 18775}, {SSHTarget: "new", ImagePort: 19000}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("configs = %#v, want %#v", got, want)
	}
}

func TestRemoveTargetPreservesAndRestartsRemainingServers(t *testing.T) {
	// Purpose: removing one server must preserve and restart every remaining server connection.
	// Input and expected output: a two-server config becomes a one-server config and reports one remaining target.
	// Edge case: the downloaded helper replaces the installed version during the restart.
	// Dependencies: files and service-manager commands are isolated fixtures and fakes.
	dir := t.TempDir()
	source := filepath.Join(dir, "download")
	plan := installationPlan{BinaryPath: filepath.Join(dir, "helper"), ConfigPath: filepath.Join(dir, "config.json")}
	if err := os.WriteFile(source, []byte("new binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plan.BinaryPath, []byte("old binary"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeConfigs(plan.ConfigPath, []config{{SSHTarget: "first", ImagePort: 18775}, {SSHTarget: "second", ImagePort: 19000}}); err != nil {
		t.Fatal(err)
	}
	commands := setupCommands{
		run:     func(commandSpec) error { return nil },
		capture: func(commandSpec) ([]byte, error) { return nil, nil },
	}
	remaining, err := plan.removeTarget(source, "first", "linux", commands)
	if err != nil {
		t.Fatal(err)
	}
	if remaining != 1 {
		t.Fatalf("remaining = %d, want 1", remaining)
	}
	got, err := loadConfigs(plan.ConfigPath, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	want := []config{{SSHTarget: "second", ImagePort: 19000}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("configs = %#v, want %#v", got, want)
	}
}

func TestUninstallRemovesHelperConfigurationAndStartup(t *testing.T) {
	// Purpose: removing the last server must completely remove the local helper installation.
	// Input and expected output: installed binary, config, and startup files are deleted after service shutdown.
	// Edge case: Linux startup is disabled before its unit file is deleted.
	// Dependencies: files and service-manager commands are isolated fixtures and fakes.
	dir := t.TempDir()
	plan := installationPlan{
		BinaryPath:  filepath.Join(dir, "helper"),
		ConfigPath:  filepath.Join(dir, "config.json"),
		StartupPath: filepath.Join(dir, linuxServiceName),
		LogPath:     filepath.Join(dir, "remote-image.log"),
	}
	files := []string{plan.BinaryPath, plan.ConfigPath, plan.StartupPath, plan.LogPath}
	for _, file := range files {
		if err := os.WriteFile(file, []byte("fixture"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	var calls []commandSpec
	commands := setupCommands{
		run: func(command commandSpec) error {
			calls = append(calls, command)
			return nil
		},
		capture: func(commandSpec) ([]byte, error) {
			return []byte(linuxServiceName + " loaded active running Helper\n"), nil
		},
	}
	if err := plan.uninstall("linux", commands); err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if _, err := os.Stat(file); !os.IsNotExist(err) {
			t.Fatalf("file %q still exists or stat failed: %v", file, err)
		}
	}
	if !hasCommand(calls, "systemctl", "--user", "disable", linuxServiceName) {
		t.Fatalf("commands = %#v, want systemctl disable", calls)
	}
}

func TestUninstallUsesPlatformRegistrationManager(t *testing.T) {
	// Purpose: final removal must unregister autostart on macOS and Windows as well as Linux.
	// Input and expected output: each platform removes all installation files, and Windows deletes its scheduled task.
	// Edge case: the platform manager reports no running helper before removal.
	// Dependencies: files and service-manager commands are isolated fixtures and fakes.
	for _, goos := range []string{"darwin", "windows"} {
		t.Run(goos, func(t *testing.T) {
			dir := t.TempDir()
			plan := installationPlan{
				BinaryPath:  filepath.Join(dir, "helper"),
				ConfigPath:  filepath.Join(dir, "config.json"),
				StartupPath: filepath.Join(dir, "startup"),
				LogPath:     filepath.Join(dir, "runtime.log"),
			}
			files := []string{plan.BinaryPath, plan.ConfigPath, plan.StartupPath, plan.LogPath}
			for _, file := range files {
				if err := os.WriteFile(file, []byte("fixture"), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			var calls []commandSpec
			commands := setupCommands{
				run: func(command commandSpec) error {
					calls = append(calls, command)
					return nil
				},
				capture: func(commandSpec) ([]byte, error) {
					if goos == "windows" {
						return json.Marshal(windowsServiceState{})
					}
					return nil, nil
				},
			}
			if err := plan.uninstall(goos, commands); err != nil {
				t.Fatal(err)
			}
			for _, file := range files {
				if _, err := os.Stat(file); !os.IsNotExist(err) {
					t.Fatalf("file %q still exists or stat failed: %v", file, err)
				}
			}
			if goos == "windows" && !hasCommand(calls, "schtasks", "/Delete", "/F", "/TN", windowsTaskName) {
				t.Fatalf("commands = %#v, want schtasks delete", calls)
			}
		})
	}
}

func hasCommand(commands []commandSpec, name string, arguments ...string) bool {
	for _, command := range commands {
		if command.Name == name && reflect.DeepEqual(command.Args, arguments) {
			return true
		}
	}
	return false
}

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
						var saved storedConfig
						if err := json.Unmarshal(data, &saved); err != nil {
							t.Fatal(err)
						}
						if len(saved.Targets) != 1 || saved.Targets[0].SSHTarget != "new-target" {
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
			if err := plan.installConfigs(source, []config{{SSHTarget: "new-target", ImagePort: 18775}}, goos, commands); err != nil {
				t.Fatal(err)
			}
			checkBinary("new binary")
		})
	}
}
