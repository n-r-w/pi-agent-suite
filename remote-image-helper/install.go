package main

import (
	"fmt"
	"html"
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

// install applies one plan only after the old platform-managed process has stopped.
func (plan installationPlan) install(source string, configuration config, goos string, commands setupCommands) error {
	if err := checkExecutableSource(source, plan.BinaryPath); err != nil {
		return err
	}
	return (installationSteps{
		stop:   func() error { return stopStartup(goos, plan, commands) },
		binary: func() error { return copyExecutable(source, plan.BinaryPath) },
		config: func() error { return writeConfig(plan.ConfigPath, configuration) },
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
