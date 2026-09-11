package main

import (
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

const (
	defaultImagePort = 18775
	minimumPort      = 1
	maximumPort      = 65535
)

type config struct {
	SSHTarget   string `json:"sshTarget"`
	SSHPassword string `json:"sshPassword,omitempty"`
	ImagePort   int    `json:"imagePort"`
}

type storedConfig struct {
	Targets     []config `json:"targets,omitempty"`
	SSHTarget   string   `json:"sshTarget,omitempty"`
	SSHPassword string   `json:"sshPassword,omitempty"`
	ImagePort   *int     `json:"imagePort,omitempty"`
}

func loadConfigs(path string, getenv func(string) string) ([]config, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	var stored storedConfig
	if err := json.Unmarshal(contents, &stored); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	legacyFormat := len(stored.Targets) == 0
	configurations := stored.Targets
	if legacyFormat && stored.SSHTarget != "" {
		port := defaultImagePort
		if stored.ImagePort != nil {
			port = *stored.ImagePort
		}
		configurations = []config{{SSHTarget: stored.SSHTarget, SSHPassword: stored.SSHPassword, ImagePort: port}}
	}
	if legacyFormat && getenv("PI_AGENT_SUITE_SSH_TARGET") != "" {
		configuration, configErr := configFromEnvironment(getenv)
		if configErr != nil {
			return nil, configErr
		}
		configurations = []config{configuration}
	}
	if len(configurations) == 0 {
		return nil, errors.New("remote image configuration has no SSH targets")
	}
	for index := range configurations {
		if configurations[index].ImagePort == 0 {
			configurations[index].ImagePort = defaultImagePort
		}
		if err := validateConfig(configurations[index]); err != nil {
			return nil, err
		}
	}
	return configurations, nil
}

func mergeConfig(configurations []config, added config) []config {
	merged := append([]config(nil), configurations...)
	for index := range merged {
		if merged[index].SSHTarget == added.SSHTarget {
			merged[index] = added
			return merged
		}
	}
	return append(merged, added)
}

func removeConfig(configurations []config, target string) ([]config, bool) {
	remaining := make([]config, 0, len(configurations))
	removed := false
	for _, configuration := range configurations {
		if configuration.SSHTarget == target {
			removed = true
			continue
		}
		remaining = append(remaining, configuration)
	}
	if !removed {
		return configurations, false
	}
	return remaining, true
}

func validateConfig(configuration config) error {
	if strings.TrimSpace(configuration.SSHTarget) == "" {
		return errors.New("PI_AGENT_SUITE_SSH_TARGET is required")
	}
	if configuration.ImagePort < minimumPort || configuration.ImagePort > maximumPort {
		return errors.New("PI_AGENT_SUITE_IMAGE_PORT must be an integer from 1 to 65535")
	}
	return nil
}

func runAskpass(configPath string, output io.Writer) error {
	configurations, err := loadConfigs(configPath, func(string) string { return "" })
	if err != nil {
		return err
	}
	target := os.Getenv("PI_AGENT_SUITE_ASKPASS_TARGET")
	if target == "" && len(configurations) == 1 {
		target = configurations[0].SSHTarget
	}
	for _, configuration := range configurations {
		if configuration.SSHTarget != target {
			continue
		}
		if configuration.SSHPassword == "" {
			return errors.New("PI_AGENT_SUITE_SSH_PASSWORD is not configured")
		}
		_, err = fmt.Fprintln(output, configuration.SSHPassword)
		return err
	}
	return fmt.Errorf("SSH target %q is not configured", target)
}
