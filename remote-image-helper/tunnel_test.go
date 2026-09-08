package main

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestBuildSSHCommandUsesLoopbackReverseForward(t *testing.T) {
	// Purpose: tunnel traffic must stay on loopback and use system OpenSSH.
	// Input and expected output: a target and port produce the approved reverse-forward arguments.
	// Edge case: key-based authentication adds no askpass environment.
	// Dependencies: none.
	config := config{SSHTarget: "user@example.test", ImagePort: 18775}
	got := buildSSHCommand(config, "/opt/helper", "/tmp/config.json")
	wantArgs := []string{
		"-N", "-T",
		"-o", "ExitOnForwardFailure=yes",
		"-o", "ServerAliveInterval=30",
		"-o", "ServerAliveCountMax=3",
		"-R", "127.0.0.1:18775:127.0.0.1:18775",
		"user@example.test",
	}
	if got.Name != "ssh" || !reflect.DeepEqual(got.Args, wantArgs) {
		t.Fatalf("command = %#v, want ssh %#v", got, wantArgs)
	}
	if len(got.Environment) != 0 {
		t.Fatalf("environment = %v, want empty", got.Environment)
	}
}

func TestBuildSSHCommandConfiguresPasswordAskpass(t *testing.T) {
	// Purpose: saved SSH passwords must be supplied only to password-capable authentication.
	// Input and expected output: a configured password adds askpass environment and disables public-key prompts.
	// Edge case: the password itself is absent from SSH arguments.
	// Dependencies: none.
	config := config{SSHTarget: "server", SSHPassword: "secret", ImagePort: 18775}
	got := buildSSHCommand(config, "/opt/helper", "/tmp/config.json")
	wantEnvironment := []string{
		"SSH_ASKPASS=/opt/helper",
		"SSH_ASKPASS_REQUIRE=force",
		"PI_AGENT_SUITE_ASKPASS=1",
		"PI_AGENT_SUITE_IMAGE_CONFIG=/tmp/config.json",
	}
	if !reflect.DeepEqual(got.Environment, wantEnvironment) {
		t.Fatalf("environment = %v, want %v", got.Environment, wantEnvironment)
	}
	wantPasswordArgs := []string{
		"-o", "PreferredAuthentications=keyboard-interactive,password",
		"-o", "PubkeyAuthentication=no",
	}
	if !containsSequence(got.Args, wantPasswordArgs) {
		t.Fatalf("args = %v, want sequence %v", got.Args, wantPasswordArgs)
	}
	for _, arg := range got.Args {
		if arg == config.SSHPassword {
			t.Fatal("password leaked into SSH arguments")
		}
	}
}

type fakeCommandRunner struct {
	calls  int
	cancel context.CancelFunc
}

func (f *fakeCommandRunner) Run(context.Context, commandSpec) error {
	f.calls++
	if f.calls == 2 {
		f.cancel()
	}
	return errors.New("ssh exited")
}

func TestMergeEnvironmentOverridesExistingValues(t *testing.T) {
	// Purpose: helper-controlled askpass values must override inherited process values.
	// Input and expected output: duplicate keys are replaced while unrelated values remain.
	// Edge case: values can contain equals signs.
	// Dependencies: none.
	got := mergeEnvironment(
		[]string{"PATH=/bin", "SSH_ASKPASS=/old", "TOKEN=a=b"},
		[]string{"SSH_ASKPASS=/helper", "NEW=value"},
	)
	want := []string{"PATH=/bin", "TOKEN=a=b", "SSH_ASKPASS=/helper", "NEW=value"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("environment = %v, want %v", got, want)
	}
}

func TestRunTunnelReconnectsAfterSSHExit(t *testing.T) {
	// Purpose: helper operation must recover from network or SSH process loss.
	// Input and expected output: two failed SSH runs occur before context cancellation stops the loop.
	// Edge case: cancellation prevents another reconnect.
	// Dependencies: process execution and retry delay use deterministic fakes.
	ctx, cancel := context.WithCancel(context.Background())
	runner := &fakeCommandRunner{cancel: cancel}
	runTunnel(ctx, runner, commandSpec{Name: "ssh"}, func(context.Context) bool { return true })
	if runner.calls != 2 {
		t.Fatalf("runs = %d, want 2", runner.calls)
	}
}

func containsSequence(values, sequence []string) bool {
	for i := 0; i+len(sequence) <= len(values); i++ {
		if reflect.DeepEqual(values[i:i+len(sequence)], sequence) {
			return true
		}
	}
	return false
}
