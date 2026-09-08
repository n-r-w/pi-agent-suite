package main

import (
	"errors"
	"reflect"
	"testing"
)

func TestActivateLaunchAgentChecksRegistration(t *testing.T) {
	// Purpose: first installation registers directly; reinstall stops the registered service first.
	// Input and expected output: full launchctl listings select bootstrap alone or bootout then bootstrap.
	// Edge cases: a registered but stopped service has PID "-"; similar labels do not match.
	// Dependencies: command execution and service listings use isolated fakes.
	for _, tc := range []struct {
		name       string
		listing    string
		registered bool
	}{
		{"first install", "PID\tStatus\tLabel\n-\t0\tother.agent\n", false},
		{"similar label", "-\t0\t" + launchAgentName + ".other\n", false},
		{"running", "123\t0\t" + launchAgentName + "\n", true},
		{"stopped", "-\t1\t" + launchAgentName + "\n", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls []commandSpec
			stopped := false
			err := activateLaunchAgent("gui/501", "/fixture/agent.plist", func(command commandSpec) error {
				calls = append(calls, command)
				stopped = command.Args[0] == "bootout"
				return nil
			}, func() ([]byte, error) {
				if stopped {
					return nil, nil
				}
				return []byte(tc.listing), nil
			})
			if err != nil {
				t.Fatal(err)
			}
			var want []commandSpec
			if tc.registered {
				want = append(want, commandSpec{Name: "launchctl", Args: []string{"bootout", "gui/501/" + launchAgentName}})
			}
			want = append(want, commandSpec{Name: "launchctl", Args: []string{"bootstrap", "gui/501", "/fixture/agent.plist"}})
			if !reflect.DeepEqual(calls, want) {
				t.Fatalf("commands = %#v, want %#v", calls, want)
			}
		})
	}
}

func TestActivateLaunchAgentReturnsFailures(t *testing.T) {
	// Purpose: genuine errors must stop installation and retain their cause.
	// Input and expected output: failure of listing, stopping, or registration returns the original error.
	// Edge case: a listing failure must not be treated as an absent service.
	// Dependencies: all commands use fakes.
	for _, stage := range []string{"list", "bootout", "bootstrap"} {
		t.Run(stage, func(t *testing.T) {
			failure := errors.New("fixture failure")
			var calls []string
			stopped := false
			err := activateLaunchAgent("gui/501", "/fixture/agent.plist", func(command commandSpec) error {
				calls = append(calls, command.Args[0])
				if command.Args[0] == stage {
					return failure
				}
				stopped = command.Args[0] == "bootout"
				return nil
			}, func() ([]byte, error) {
				calls = append(calls, "list")
				if stage == "list" {
					return nil, failure
				}
				if stopped {
					return nil, nil
				}
				return []byte("-\t0\t" + launchAgentName + "\n"), nil
			})
			if !errors.Is(err, failure) {
				t.Fatalf("error = %v, want %v", err, failure)
			}
			if calls[len(calls)-1] != stage {
				t.Fatalf("continued after %s failure: %v", stage, calls)
			}
		})
	}
}

func TestActivateLaunchAgentWaitsForRemoval(t *testing.T) {
	// Purpose: bootstrap must wait for asynchronous bootout completion.
	// Input and expected output: the service remains in two listings, then disappears before bootstrap.
	// Edge case: bootout returns successfully before the service is removed.
	// Dependencies: launchctl and listings use fakes.
	reads := 0
	err := activateLaunchAgent("gui/501", "/fixture/agent.plist", func(command commandSpec) error {
		if command.Args[0] == "bootstrap" && reads < 3 {
			t.Errorf("bootstrap before removal: %d listings", reads)
		}
		return nil
	}, func() ([]byte, error) {
		reads++
		if reads < 3 {
			return []byte("-\t0\t" + launchAgentName + "\n"), nil
		}
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
