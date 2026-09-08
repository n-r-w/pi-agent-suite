package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadConfigAppliesEnvironmentOverrides(t *testing.T) {
	// Purpose: documented environment settings must override persisted setup values.
	// Input and expected output: target, password, and port environment values replace JSON values.
	// Edge case: the password can be omitted from the saved file.
	// Dependencies: the configuration file is an isolated test fixture.
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"sshTarget":"saved","imagePort":18775}`), 0o600); err != nil {
		t.Fatal(err)
	}
	environment := map[string]string{
		"PI_AGENT_SUITE_SSH_TARGET":   "override",
		"PI_AGENT_SUITE_SSH_PASSWORD": "secret",
		"PI_AGENT_SUITE_IMAGE_PORT":   "19000",
	}
	got, err := loadConfig(path, func(key string) string { return environment[key] })
	if err != nil {
		t.Fatal(err)
	}
	want := config{SSHTarget: "override", SSHPassword: "secret", ImagePort: 19000}
	if got != want {
		t.Fatalf("config = %#v, want %#v", got, want)
	}
}

func TestLoadConfigRejectsInvalidSettings(t *testing.T) {
	// Purpose: helper startup must fail before starting an unusable listener or tunnel.
	// Input and expected output: missing target and out-of-range port each return an error.
	// Edge case: port 0 is invalid after defaulting only absent values.
	// Dependencies: each configuration file is an isolated test fixture.
	tests := []string{
		`{"imagePort":18775}`,
		`{"sshTarget":"server","imagePort":65536}`,
	}
	for _, contents := range tests {
		path := filepath.Join(t.TempDir(), "config.json")
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := loadConfig(path, func(string) string { return "" }); err == nil {
			t.Fatalf("loadConfig(%s) succeeded, want error", contents)
		}
	}
}

func TestWriteConfigRestrictsExistingFilePermissions(t *testing.T) {
	// Purpose: a saved SSH password must remain readable only by the current user on Unix.
	// Input and expected output: rewriting an existing public file changes its mode to 0600.
	// Edge case: os.WriteFile alone does not change an existing file mode.
	// Dependencies: the configuration file is an isolated test fixture.
	if os.PathSeparator == '\\' {
		t.Skip("Windows does not use Unix permission bits")
	}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeConfig(path, config{SSHTarget: "server", SSHPassword: "secret", ImagePort: 18775}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode = %o, want 600", got)
	}
}

func TestAskpassPrintsConfiguredPassword(t *testing.T) {
	// Purpose: OpenSSH must receive the saved account password from the helper executable.
	// Input and expected output: askpass mode writes exactly one password line.
	// Edge case: the password never appears in command arguments.
	// Dependencies: output uses an in-memory buffer and config uses a temp file.
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, []byte(`{"sshTarget":"server","sshPassword":"secret","imagePort":18775}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var output stringWriter
	err := runAskpass(path, &output)
	if err != nil {
		t.Fatal(err)
	}
	if output.value != "secret\n" {
		t.Fatalf("output = %q, want password line", output.value)
	}
}

type stringWriter struct{ value string }

func (w *stringWriter) Write(data []byte) (int, error) {
	w.value += string(data)
	return len(data), nil
}
