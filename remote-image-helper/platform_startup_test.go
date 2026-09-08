package main

import (
	"errors"
	"reflect"
	"testing"
)

func TestPlatformStartupUsesManagers(t *testing.T) {
	// Purpose: startup must use the configured service manager instead of detaching an untracked process.
	// Input and expected output: macOS bootstraps, Windows registers and runs, Linux reloads and enables the service.
	// Edge case: first installation uses no stop commands during this phase.
	// Dependencies: every system command uses a fake; paths are fixtures.
	for _, platform := range []string{"darwin", "linux", "windows"} {
		t.Run(platform, func(t *testing.T) {
			plan, err := buildInstallationPlan(platform, "/fixture/home", `C:\fixture`)
			if err != nil {
				t.Fatal(err)
			}
			var calls []commandSpec
			err = startStartup(platform, plan, setupCommands{run: func(c commandSpec) error { calls = append(calls, c); return nil }})
			if err != nil {
				t.Fatal(err)
			}
			if len(calls) == 0 {
				t.Fatal("no service manager commands")
			}
			last := calls[len(calls)-1]
			switch platform {
			case "darwin":
				if last.Name != "launchctl" || last.Args[0] != "bootstrap" {
					t.Fatalf("last command = %#v", last)
				}
			case "windows":
				if !reflect.DeepEqual(calls, []commandSpec{*plan.StartupCommand, {Name: "schtasks", Args: []string{"/Run", "/TN", windowsTaskName}}}) {
					t.Fatalf("commands = %#v", calls)
				}
			case "linux":
				if calls[0].Name != "systemctl" || !reflect.DeepEqual(calls[0].Args, []string{"--user", "daemon-reload"}) {
					t.Fatalf("first command = %#v", calls[0])
				}
				if !reflect.DeepEqual(last.Args, []string{"--user", "enable", "--now", linuxServiceName}) {
					t.Fatalf("last command = %#v", last)
				}
			}
		})
	}
}

func TestPlatformStartupPreservesErrors(t *testing.T) {
	// Purpose: manager failures must prevent reporting a successful installation.
	// Input and expected output: the first failed startup command returns its original error.
	// Edge case: all three platform paths have the same failure contract.
	// Dependencies: command execution uses a fake.
	for _, platform := range []string{"darwin", "linux", "windows"} {
		plan, err := buildInstallationPlan(platform, "/fixture/home", `C:\fixture`)
		if err != nil {
			t.Fatal(err)
		}
		failure := errors.New("fixture failure")
		calls := 0
		err = startStartup(platform, plan, setupCommands{run: func(commandSpec) error { calls++; return failure }})
		if !errors.Is(err, failure) || calls != 1 {
			t.Fatalf("%s: error = %v, calls = %d", platform, err, calls)
		}
	}
}
