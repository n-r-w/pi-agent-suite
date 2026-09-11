package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestLoadConfigsAppliesEnvironmentOverrides(t *testing.T) {
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
	got, err := loadConfigs(path, func(key string) string { return environment[key] })
	if err != nil {
		t.Fatal(err)
	}
	want := []config{{SSHTarget: "override", SSHPassword: "secret", ImagePort: 19000}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("configs = %#v, want %#v", got, want)
	}
}

func TestLoadConfigsReadsMultipleServersAndLegacyConfig(t *testing.T) {
	// Purpose: one helper configuration must preserve every configured remote server and migrate the old format.
	// Input and expected output: a two-target file returns both targets, and a legacy file returns one target.
	// Edge case: the multi-target format ignores the legacy runtime target override; the legacy file has no password.
	// Dependencies: configuration files are isolated test fixtures.
	dir := t.TempDir()
	multiPath := filepath.Join(dir, "multi.json")
	if err := os.WriteFile(multiPath, []byte(`{"targets":[{"sshTarget":"first","imagePort":18775},{"sshTarget":"second","sshPassword":"secret","imagePort":19000}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := loadConfigs(multiPath, func(key string) string {
		if key == "PI_AGENT_SUITE_SSH_TARGET" {
			return "legacy-runtime-override"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []config{{SSHTarget: "first", ImagePort: 18775}, {SSHTarget: "second", SSHPassword: "secret", ImagePort: 19000}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("configs = %#v, want %#v", got, want)
	}

	legacyPath := filepath.Join(dir, "legacy.json")
	if err := os.WriteFile(legacyPath, []byte(`{"sshTarget":"legacy","imagePort":18775}`), 0o600); err != nil {
		t.Fatal(err)
	}
	got, err = loadConfigs(legacyPath, func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	want = []config{{SSHTarget: "legacy", ImagePort: 18775}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("legacy configs = %#v, want %#v", got, want)
	}
}

func TestMergeConfigPreservesServersAndUpdatesExactTarget(t *testing.T) {
	// Purpose: adding a server must not break existing servers, while reinstalling one server must update that entry.
	// Input and expected output: a new target is appended and an exact duplicate replaces its saved settings in place.
	// Edge case: the SSH target string is the stable server identity.
	// Dependencies: none.
	existing := []config{{SSHTarget: "first", ImagePort: 18775}, {SSHTarget: "second", ImagePort: 19000}}
	got := mergeConfig(existing, config{SSHTarget: "third", ImagePort: 20000})
	want := []config{{SSHTarget: "first", ImagePort: 18775}, {SSHTarget: "second", ImagePort: 19000}, {SSHTarget: "third", ImagePort: 20000}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("added configs = %#v, want %#v", got, want)
	}
	got = mergeConfig(existing, config{SSHTarget: "second", SSHPassword: "new-secret", ImagePort: 21000})
	want = []config{{SSHTarget: "first", ImagePort: 18775}, {SSHTarget: "second", SSHPassword: "new-secret", ImagePort: 21000}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("updated configs = %#v, want %#v", got, want)
	}
}

func TestRemoveConfigRemovesOnlyExactTarget(t *testing.T) {
	// Purpose: removal must leave all unrelated remote servers configured.
	// Input and expected output: removing one exact SSH target returns the other target and reports success.
	// Edge case: an unknown target leaves the list unchanged and reports failure.
	// Dependencies: none.
	existing := []config{{SSHTarget: "first", ImagePort: 18775}, {SSHTarget: "second", ImagePort: 19000}}
	got, removed := removeConfig(existing, "first")
	if !removed || !reflect.DeepEqual(got, []config{{SSHTarget: "second", ImagePort: 19000}}) {
		t.Fatalf("remove = %#v, %t", got, removed)
	}
	got, removed = removeConfig(existing, "missing")
	if removed || !reflect.DeepEqual(got, existing) {
		t.Fatalf("missing remove = %#v, %t", got, removed)
	}
}

func TestLoadConfigsRejectsInvalidSettings(t *testing.T) {
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
		if _, err := loadConfigs(path, func(string) string { return "" }); err == nil {
			t.Fatalf("loadConfigs(%s) succeeded, want error", contents)
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
	if err := writeConfigs(path, []config{{SSHTarget: "server", SSHPassword: "secret", ImagePort: 18775}}); err != nil {
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

func TestAskpassSelectsPasswordForTunnelTarget(t *testing.T) {
	// Purpose: concurrent SSH tunnels must receive only the password saved for their own target.
	// Input and expected output: selecting the second target prints the second target password.
	// Edge case: both targets use password authentication at the same time.
	// Dependencies: the configuration file is an isolated fixture and the selector is a test environment value.
	path := filepath.Join(t.TempDir(), "config.json")
	configurations := []config{{SSHTarget: "first", SSHPassword: "first-secret", ImagePort: 18775}, {SSHTarget: "second", SSHPassword: "second-secret", ImagePort: 19000}}
	if err := writeConfigs(path, configurations); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PI_AGENT_SUITE_ASKPASS_TARGET", "second")
	var output stringWriter
	if err := runAskpass(path, &output); err != nil {
		t.Fatal(err)
	}
	if output.value != "second-secret\n" {
		t.Fatalf("askpass output = %q", output.value)
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
