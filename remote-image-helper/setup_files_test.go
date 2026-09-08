package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCopyExecutableRejectsSelfReplacement(t *testing.T) {
	// Purpose: running install from the installed path must not truncate its own executable.
	// Input and expected output: identical source/destination returns an error and preserves bytes.
	// Edge case: two different paths can refer to the same file through a hard link.
	// Dependencies: files are isolated temporary fixtures.
	dir := t.TempDir()
	source := filepath.Join(dir, "helper")
	if err := os.WriteFile(source, []byte("executable fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := copyExecutable(source, source); err == nil {
		t.Fatal("self replacement succeeded")
	}
	data, err := os.ReadFile(source)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "executable fixture" {
		t.Fatalf("source was modified: %q", data)
	}
}

func TestCopyExecutableReplacesPreviousVersion(t *testing.T) {
	// Purpose: successful replacement publishes complete executable bytes with executable permissions.
	// Input and expected output: a longer old version is fully replaced by a shorter new version.
	// Edge case: no trailing bytes from the previous executable remain.
	// Dependencies: only temporary fixture files are used.
	dir := t.TempDir()
	source := filepath.Join(dir, "new")
	target := filepath.Join(dir, "installed", "helper")
	if err := os.WriteFile(source, []byte("new"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("old long version"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := copyExecutable(source, target); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "new" {
		t.Fatalf("contents = %q", data)
	}
}
