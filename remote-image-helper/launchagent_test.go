package main

import (
	"errors"
	"reflect"
	"testing"
)

func TestStopLaunchAgentChecksRegistration(t *testing.T) {
	// Purpose: stop only registered services before file replacement.
	// Input and expected output: absent label needs no stop; exact registered labels invoke bootout.
	// Edge cases: stopped service without PID; a similar label is not our service.
	// Dependencies: launchctl commands and listings use fakes.
	for _, tc := range []struct {
		listing    string
		registered bool
	}{
		{"PID\tStatus\tLabel\n", false},
		{"-\t0\t" + launchAgentName + ".other\n", false},
		{"123\t0\t" + launchAgentName + "\n", true},
		{"-\t1\t" + launchAgentName + "\n", true},
	} {
		var calls []commandSpec
		stopped := false
		err := stopLaunchAgent("gui/501", func(c commandSpec) error { calls = append(calls, c); stopped = true; return nil }, func() ([]byte, error) {
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
			want = []commandSpec{{Name: "launchctl", Args: []string{"bootout", "gui/501/" + launchAgentName}}}
		}
		if !reflect.DeepEqual(calls, want) {
			t.Fatalf("calls = %#v, want %#v", calls, want)
		}
	}
}

func TestStopLaunchAgentWaitsAndRetainsErrors(t *testing.T) {
	// Purpose: returning from bootout is not sufficient evidence that replacement can begin.
	// Input and expected output: two present listings followed by absence complete the stop.
	// Edge cases: query failure and bootout failure retain their cause.
	// Dependencies: command and status readers use fakes.
	reads := 0
	err := stopLaunchAgent("gui/501", func(commandSpec) error { return nil }, func() ([]byte, error) {
		reads++
		if reads < 3 {
			return []byte("-\t0\t" + launchAgentName + "\n"), nil
		}
		return nil, nil
	})
	if err != nil || reads != 3 {
		t.Fatalf("error = %v, reads = %d", err, reads)
	}
	failure := errors.New("fixture failure")
	if err := stopLaunchAgent("gui/501", func(commandSpec) error { return nil }, func() ([]byte, error) { return nil, failure }); !errors.Is(err, failure) {
		t.Fatalf("error = %v", err)
	}
	if err := stopLaunchAgent("gui/501", func(commandSpec) error { return failure }, func() ([]byte, error) { return []byte("-\t0\t" + launchAgentName + "\n"), nil }); !errors.Is(err, failure) {
		t.Fatalf("error = %v", err)
	}
}
