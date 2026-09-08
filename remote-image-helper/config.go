package main

import (
	"encoding/json/v2"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
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
	SSHTarget   string `json:"sshTarget"`
	SSHPassword string `json:"sshPassword,omitempty"`
	ImagePort   *int   `json:"imagePort"`
}

func loadConfig(path string, getenv func(string) string) (config, error) {
	contents, err := os.ReadFile(path)
	if err != nil {
		return config{}, fmt.Errorf("read config: %w", err)
	}
	var stored storedConfig
	if err := json.Unmarshal(contents, &stored); err != nil {
		return config{}, fmt.Errorf("parse config: %w", err)
	}

	configuration := config{
		SSHTarget:   stored.SSHTarget,
		SSHPassword: stored.SSHPassword,
		ImagePort:   defaultImagePort,
	}
	if stored.ImagePort != nil {
		configuration.ImagePort = *stored.ImagePort
	}
	if value := getenv("PI_AGENT_SUITE_SSH_TARGET"); value != "" {
		configuration.SSHTarget = value
	}
	if value := getenv("PI_AGENT_SUITE_SSH_PASSWORD"); value != "" {
		configuration.SSHPassword = value
	}
	if value := getenv("PI_AGENT_SUITE_IMAGE_PORT"); value != "" {
		port, parseErr := strconv.Atoi(value)
		if parseErr != nil {
			return config{}, errors.New("PI_AGENT_SUITE_IMAGE_PORT must be an integer from 1 to 65535")
		}
		configuration.ImagePort = port
	}
	if strings.TrimSpace(configuration.SSHTarget) == "" {
		return config{}, errors.New("PI_AGENT_SUITE_SSH_TARGET is required")
	}
	if configuration.ImagePort < minimumPort || configuration.ImagePort > maximumPort {
		return config{}, errors.New("PI_AGENT_SUITE_IMAGE_PORT must be an integer from 1 to 65535")
	}
	return configuration, nil
}

func runAskpass(configPath string, output io.Writer) error {
	configuration, err := loadConfig(configPath, os.Getenv)
	if err != nil {
		return err
	}
	if configuration.SSHPassword == "" {
		return errors.New("PI_AGENT_SUITE_SSH_PASSWORD is not configured")
	}
	_, err = fmt.Fprintln(output, configuration.SSHPassword)
	return err
}
