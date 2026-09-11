package main

import (
	"fmt"
	"html"
	"os"
	"path"
	"strconv"
	"strings"
)

const launchAgentName = "dev.pi.agent-suite.remote-image"

type installationPlan struct {
	BinaryPath     string
	ConfigPath     string
	StartupPath    string
	StartupFile    string
	StartupCommand *commandSpec
	LogPath        string
}

func (plan installationPlan) installTarget(source string, added config, goos string, commands setupCommands) error {
	configurations := []config{}
	if _, err := os.Stat(plan.ConfigPath); err == nil {
		loaded, loadErr := loadConfigs(plan.ConfigPath, func(string) string { return "" })
		if loadErr != nil {
			return loadErr
		}
		configurations = loaded
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("inspect config: %w", err)
	}
	return plan.installConfigs(source, mergeConfig(configurations, added), goos, commands)
}

func (plan installationPlan) removeTarget(source, target, goos string, commands setupCommands) (int, error) {
	configurations, err := loadConfigs(plan.ConfigPath, func(string) string { return "" })
	if err != nil {
		return 0, err
	}
	remaining, removed := removeConfig(configurations, target)
	if !removed {
		return len(configurations), fmt.Errorf("SSH target %q is not configured", target)
	}
	if len(remaining) == 0 {
		if err := plan.uninstall(goos, commands); err != nil {
			return 0, err
		}
		return 0, nil
	}
	if err := plan.installConfigs(source, remaining, goos, commands); err != nil {
		return len(configurations), err
	}
	return len(remaining), nil
}

func (plan installationPlan) uninstall(goos string, commands setupCommands) error {
	if err := stopStartup(goos, plan, commands); err != nil {
		return err
	}
	switch goos {
	case "linux":
		if err := commands.run(commandSpec{Name: "systemctl", Args: []string{"--user", "disable", linuxServiceName}}); err != nil {
			return fmt.Errorf("disable systemd user service: %w", err)
		}
	case "windows":
		if err := commands.run(commandSpec{Name: "schtasks", Args: []string{"/Delete", "/F", "/TN", windowsTaskName}}); err != nil {
			return fmt.Errorf("delete Windows logon task: %w", err)
		}
	}
	for _, file := range []string{plan.StartupPath, plan.ConfigPath, plan.LogPath, plan.BinaryPath} {
		if file == "" {
			continue
		}
		if err := os.Remove(file); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("remove %s: %w", file, err)
		}
	}
	if goos == "linux" {
		if err := commands.run(commandSpec{Name: "systemctl", Args: []string{"--user", "daemon-reload"}}); err != nil {
			return fmt.Errorf("reload systemd user units: %w", err)
		}
	}
	return nil
}

// installConfigs applies one plan only after the old platform-managed process has stopped.
func (plan installationPlan) installConfigs(source string, configurations []config, goos string, commands setupCommands) error {
	if err := checkExecutableSource(source, plan.BinaryPath); err != nil {
		return err
	}
	return (installationSteps{
		stop:   func() error { return stopStartup(goos, plan, commands) },
		binary: func() error { return copyExecutable(source, plan.BinaryPath) },
		config: func() error { return writeConfigs(plan.ConfigPath, configurations) },
		startup: func() error {
			if plan.StartupPath == "" {
				return nil
			}
			if err := writePrivateFile(plan.StartupPath, []byte(plan.StartupFile)); err != nil {
				return fmt.Errorf("write startup file: %w", err)
			}
			return nil
		},
		start: func() error { return startStartup(goos, plan, commands) },
	}).run()
}

func buildInstallationPlan(goos, home, localAppData string) (installationPlan, error) {
	switch goos {
	case "darwin":
		binaryPath := path.Join(home, ".local", "bin", "pi-agent-suite-remote-image")
		configPath := path.Join(home, "Library", "Application Support", "pi-agent-suite", "remote-image.json")
		startupPath := path.Join(home, "Library", "LaunchAgents", launchAgentName+".plist")
		return installationPlan{
			BinaryPath:  binaryPath,
			ConfigPath:  configPath,
			StartupPath: startupPath,
			StartupFile: launchAgent(binaryPath, configPath),
			LogPath:     configPath + ".log",
		}, nil
	case "linux":
		binaryPath := path.Join(home, ".local", "bin", "pi-agent-suite-remote-image")
		configPath := path.Join(home, ".config", "pi-agent-suite", "remote-image.json")
		startupPath := path.Join(home, ".config", "systemd", "user", linuxServiceName)
		return installationPlan{
			BinaryPath:  binaryPath,
			ConfigPath:  configPath,
			StartupPath: startupPath,
			StartupFile: systemdUnit(binaryPath, configPath),
		}, nil
	case "windows":
		if localAppData == "" {
			return installationPlan{}, fmt.Errorf("LOCALAPPDATA is required on Windows")
		}
		root := windowsJoin(localAppData, "PiAgentSuite")
		binaryPath := windowsJoin(root, "remote-image.exe")
		configPath := windowsJoin(root, "remote-image.json")
		taskCommand := fmt.Sprintf("\"%s\" --config \"%s\" --log \"%s\"", binaryPath, configPath, configPath+".log")
		return installationPlan{
			BinaryPath: binaryPath,
			ConfigPath: configPath,
			LogPath:    configPath + ".log",
			StartupCommand: &commandSpec{
				Name: "schtasks",
				Args: []string{"/Create", "/F", "/SC", "ONLOGON", "/IT", "/TN", "PiAgentSuiteRemoteImage", "/TR", taskCommand},
			},
		}, nil
	default:
		return installationPlan{}, fmt.Errorf("unsupported platform %q", goos)
	}
}

func launchAgent(binaryPath, configPath string) string {
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>%s</string>
<key>ProgramArguments</key><array><string>%s</string><string>--config</string><string>%s</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>%s</string>
<key>StandardErrorPath</key><string>%s</string>
</dict></plist>
`, launchAgentName, html.EscapeString(binaryPath), html.EscapeString(configPath), html.EscapeString(configPath+".log"), html.EscapeString(configPath+".log"))
}

func systemdUnit(binaryPath, configPath string) string {
	return fmt.Sprintf(`[Unit]
Description=Pi Agent Suite Remote Image
PartOf=graphical-session.target
After=graphical-session-pre.target

[Service]
Type=exec
ExecStart=%s --config %s
Restart=on-failure
RestartSec=2
KillMode=control-group
TimeoutStopSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=graphical-session.target
`, systemdArgument(binaryPath), systemdArgument(configPath))
}

// systemdArgument escapes argument quoting, specifiers, and environment expansion.
func systemdArgument(value string) string {
	return strconv.Quote(strings.NewReplacer("%", "%%", "$", "$$").Replace(value))
}

func windowsJoin(base string, elements ...string) string {
	var result strings.Builder
	result.WriteString(strings.TrimRight(base, `\/`))
	for _, element := range elements {
		result.WriteString(`\` + strings.Trim(element, `\/`))
	}
	return result.String()
}
