package main

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestLinuxStopChecksUnitAndWaitsForSystemctl(t *testing.T) {
	// Purpose: systemctl stop must finish before the installer replaces the executable.
	// Input and expected output: loaded service triggers stop; first installation only queries units.
	// Edge case: unrelated service names must not trigger stopping.
	// Dependencies: systemctl uses fake commands; no real user manager is accessed.
	for _, loaded := range []bool{false, true} {
		var calls []commandSpec
		commands := setupCommands{
			run: func(c commandSpec) error { calls = append(calls, c); return nil },
			capture: func(c commandSpec) ([]byte, error) {
				calls = append(calls, c)
				if loaded {
					return []byte(linuxServiceName + " loaded active running Helper\n"), nil
				}
				return []byte("other.service loaded active running Other\n"), nil
			},
		}
		if err := stopLinuxService(commands); err != nil {
			t.Fatal(err)
		}
		want := []commandSpec{{Name: "systemctl", Args: []string{"--user", "list-units", "--all", "--plain", "--no-legend", "--no-pager"}}}
		if loaded {
			want = append(want, commandSpec{Name: "systemctl", Args: []string{"--user", "stop", linuxServiceName}})
		}
		if !reflect.DeepEqual(calls, want) {
			t.Fatalf("commands = %#v, want %#v", calls, want)
		}
	}
}

func TestLinuxStopReturnsCommandFailures(t *testing.T) {
	// Purpose: manager and stop failures must not be treated as first installation.
	// Input and expected output: either failing command returns its original error.
	// Edge case: an unavailable user manager is not an empty service list.
	// Dependencies: systemctl uses fakes.
	failure := errors.New("systemctl failed")
	for _, queryFails := range []bool{false, true} {
		commands := setupCommands{
			run: func(commandSpec) error { return failure },
			capture: func(commandSpec) ([]byte, error) {
				if queryFails {
					return nil, failure
				}
				return []byte(linuxServiceName + " loaded active running Helper\n"), nil
			},
		}
		if err := stopLinuxService(commands); !errors.Is(err, failure) {
			t.Fatalf("error = %v", err)
		}
	}
}

func TestWindowsStopTerminatesTreeAndWaits(t *testing.T) {
	// Purpose: replacement must wait for the old helper, SSH child, and task to finish.
	// Input and expected output: existing task is disabled, helper tree is killed, and polling waits for child exit.
	// Edge cases: an unrelated process and a reused PID must not delay completion.
	// Dependencies: task commands and process snapshots use isolated fakes.
	reads := 0
	var calls []commandSpec
	snapshots := []windowsServiceState{
		{TaskExists: true, TaskRunning: true, Processes: []windowsProcess{
			{PID: 100, Path: `C:\helper.exe`, Created: "old"},
			{PID: 101, ParentPID: 100, Path: `C:\ssh.exe`, Created: "child"},
		}},
		{TaskExists: true, Processes: []windowsProcess{{PID: 101, Created: "child"}}},
		{TaskExists: true, Processes: []windowsProcess{{PID: 100, Created: "new"}, {PID: 999}}},
	}
	err := stopWindowsService(context.Background(), `C:\helper.exe`, func(c commandSpec) error { calls = append(calls, c); return nil }, func() (windowsServiceState, error) {
		s := snapshots[reads]
		reads++
		return s, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []commandSpec{
		{Name: "schtasks", Args: []string{"/Change", "/TN", windowsTaskName, "/DISABLE"}},
		{Name: "taskkill", Args: []string{"/PID", "100", "/T", "/F"}},
	}
	if !reflect.DeepEqual(calls, want) || reads != 3 {
		t.Fatalf("calls = %#v, reads = %d", calls, reads)
	}
}

func TestWindowsFirstInstallAndErrors(t *testing.T) {
	// Purpose: absent tasks proceed without invalid stop commands; real failures abort installation.
	// Input and expected output: empty state succeeds; failed query or kill returns the original error.
	// Edge case: cancellation while the task remains running returns a timeout/cancellation error.
	// Dependencies: command and state readers are fakes.
	failure := errors.New("fixture failure")
	if err := stopWindowsService(context.Background(), "helper", func(commandSpec) error { t.Fatal("unexpected command"); return nil }, func() (windowsServiceState, error) { return windowsServiceState{}, nil }); err != nil {
		t.Fatal(err)
	}
	if err := stopWindowsService(context.Background(), "helper", func(commandSpec) error { return nil }, func() (windowsServiceState, error) { return windowsServiceState{}, failure }); !errors.Is(err, failure) {
		t.Fatalf("error = %v", err)
	}
	if err := stopWindowsService(context.Background(), "helper", func(commandSpec) error { return failure }, func() (windowsServiceState, error) {
		return windowsServiceState{Processes: []windowsProcess{{PID: 1, Path: "helper"}}}, nil
	}); !errors.Is(err, failure) {
		t.Fatalf("error = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := stopWindowsService(ctx, "helper", func(commandSpec) error { return nil }, func() (windowsServiceState, error) {
		return windowsServiceState{TaskExists: true, TaskRunning: true}, nil
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v", err)
	}
}
