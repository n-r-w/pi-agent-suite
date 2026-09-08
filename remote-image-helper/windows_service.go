package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// windowsProcess includes creation time to distinguish PID reuse during shutdown.
type windowsProcess struct {
	PID       int    `json:"pid"`
	ParentPID int    `json:"parentPID"`
	Path      string `json:"path"`
	Created   string `json:"created"`
}

type windowsServiceState struct {
	TaskExists  bool             `json:"taskExists"`
	TaskRunning bool             `json:"taskRunning"`
	Processes   []windowsProcess `json:"processes"`
}

func (s windowsServiceState) helperTrees(binary string) ([]int, map[int]string) {
	var roots []int
	tracked := make(map[int]string)
	for _, process := range s.Processes {
		if strings.EqualFold(process.Path, binary) {
			roots = append(roots, process.PID)
			tracked[process.PID] = process.Created
		}
	}
	// Include descendants before stopping the parent, since they may later be reparented.
	for changed := true; changed; {
		changed = false
		for _, process := range s.Processes {
			_, parentTracked := tracked[process.ParentPID]
			_, alreadyTracked := tracked[process.PID]
			if parentTracked && !alreadyTracked {
				tracked[process.PID] = process.Created
				changed = true
			}
		}
	}
	return roots, tracked
}

func (s windowsServiceState) stopped(tracked map[int]string) bool {
	if s.TaskRunning {
		return false
	}
	for _, process := range s.Processes {
		if created, exists := tracked[process.PID]; exists && created == process.Created {
			return false
		}
	}
	return true
}

// stopWindowsService prevents task relaunch and waits for both the task and its process trees.
func stopWindowsService(ctx context.Context, binary string, run func(commandSpec) error, query func() (windowsServiceState, error)) error {
	state, err := query()
	if err != nil {
		return fmt.Errorf("query Windows helper: %w", err)
	}
	roots, tracked := state.helperTrees(binary)
	if state.TaskExists {
		if err := run(commandSpec{Name: "schtasks", Args: []string{"/Change", "/TN", windowsTaskName, "/DISABLE"}}); err != nil {
			return fmt.Errorf("disable Windows task: %w", err)
		}
	}
	for _, pid := range roots {
		if err := run(commandSpec{Name: "taskkill", Args: []string{"/PID", strconv.Itoa(pid), "/T", "/F"}}); err != nil {
			return fmt.Errorf("stop Windows helper tree: %w", err)
		}
	}
	for !state.stopped(tracked) {
		if err := waitForServicePoll(ctx); err != nil {
			return fmt.Errorf("wait for Windows helper shutdown: %w", err)
		}
		state, err = query()
		if err != nil {
			return fmt.Errorf("check Windows helper shutdown: %w", err)
		}
	}
	return nil
}

func waitForServicePoll(ctx context.Context) error {
	timer := time.NewTimer(100 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
