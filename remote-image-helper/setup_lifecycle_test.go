package main

import (
	"errors"
	"reflect"
	"testing"
)

func TestInstallationStopsBeforeReplacingFiles(t *testing.T) {
	// Purpose: every platform must finish stopping before replacing a running executable.
	// Input and expected output: successful steps run stop, binary, config, startup, start in order.
	// Edge case: the first installation uses the same sequence with a no-op platform stop.
	// Dependencies: every operation is an isolated fake.
	var calls []string
	step := func(name string) func() error { return func() error { calls = append(calls, name); return nil } }
	err := (installationSteps{stop: step("stop"), binary: step("binary"), config: step("config"), startup: step("startup"), start: step("start")}).run()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"stop", "binary", "config", "startup", "start"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("steps = %v, want %v", calls, want)
	}
}

func TestInstallationStopsAtEachFailure(t *testing.T) {
	// Purpose: a failed stop or replacement must not proceed to later installation steps.
	// Input and expected output: each failed step retains its error and ends the sequence.
	// Edge cases: stop failure leaves files untouched; start failure cannot report success.
	// Dependencies: all steps use deterministic fakes.
	names := []string{"stop", "binary", "config", "startup", "start"}
	for i, failed := range names {
		t.Run(failed, func(t *testing.T) {
			var calls []string
			failure := errors.New("fixture failure")
			step := func(name string) func() error {
				return func() error {
					calls = append(calls, name)
					if name == failed {
						return failure
					}
					return nil
				}
			}
			err := (installationSteps{stop: step("stop"), binary: step("binary"), config: step("config"), startup: step("startup"), start: step("start")}).run()
			if !errors.Is(err, failure) {
				t.Fatalf("error = %v, want %v", err, failure)
			}
			if !reflect.DeepEqual(calls, names[:i+1]) {
				t.Fatalf("steps = %v, want %v", calls, names[:i+1])
			}
		})
	}
}
