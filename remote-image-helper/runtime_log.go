package main

import (
	"fmt"
	"log"
	"os"
)

// configureRuntimeLog keeps a process-lifetime log open so main can also report startup failures.
func configureRuntimeLog(path string) error {
	output, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("open runtime log: %w", err)
	}
	os.Stdout = output
	os.Stderr = output
	log.SetOutput(output)
	return nil
}
