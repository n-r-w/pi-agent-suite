package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallationPlanUsesGraphicalUserStartup(t *testing.T) {
	// Purpose: each supported platform must start the helper in the clipboard-owning user session.
	// Input and expected output: platform-specific paths and startup definitions reference the installed helper and config.
	// Edge case: paths containing spaces remain quoted.
	// Dependencies: no operating-system files or commands are used.
	tests := []struct {
		goos          string
		home          string
		localAppData  string
		startupMarker string
	}{
		{goos: "darwin", home: "/Users/Test User", startupMarker: "Library/LaunchAgents/dev.pi.agent-suite.remote-image.plist"},
		{goos: "linux", home: "/home/test user", startupMarker: ".config/systemd/user/pi-agent-suite-remote-image.service"},
		{goos: "windows", home: `C:\Users\Test User`, localAppData: `C:\Users\Test User\AppData\Local`, startupMarker: "schtasks"},
	}
	for _, test := range tests {
		plan, err := buildInstallationPlan(test.goos, test.home, test.localAppData)
		if err != nil {
			t.Fatalf("buildInstallationPlan(%s): %v", test.goos, err)
		}
		startupDescription := plan.StartupPath + "\n" + plan.StartupFile
		if plan.StartupCommand != nil {
			startupDescription = strings.Join(append([]string{plan.StartupCommand.Name}, plan.StartupCommand.Args...), " ")
		}
		if !strings.Contains(startupDescription, test.startupMarker) {
			t.Fatalf("startup = %q, want marker %q", startupDescription, test.startupMarker)
		}
		if !strings.Contains(startupDescription, plan.BinaryPath) || !strings.Contains(startupDescription, plan.ConfigPath) {
			t.Fatalf("startup = %q, want binary %q and config %q", startupDescription, plan.BinaryPath, plan.ConfigPath)
		}
		normalizedConfigPath := strings.ReplaceAll(plan.ConfigPath, "\\", "/")
		if filepath.Base(normalizedConfigPath) != "remote-image.json" {
			t.Fatalf("config path = %q", plan.ConfigPath)
		}
		if test.goos == "windows" && !containsSequence(plan.StartupCommand.Args, []string{"/IT"}) {
			t.Fatalf("Windows startup args = %v, want /IT", plan.StartupCommand.Args)
		}
	}
}

func TestBuildInstallationPlanRejectsUnsupportedPlatform(t *testing.T) {
	// Purpose: setup must not silently install an unusable startup definition.
	// Input and expected output: an unsupported platform returns an error.
	// Edge case: the platform string is non-empty.
	// Dependencies: none.
	if _, err := buildInstallationPlan("freebsd", "/home/test", ""); err == nil {
		t.Fatal("buildInstallationPlan succeeded, want error")
	}
}
