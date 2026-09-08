package main

import (
	"fmt"
	"html"
	"path"
	"strings"
)

const launchAgentName = "dev.pi.agent-suite.remote-image"

type installationPlan struct {
	BinaryPath     string
	ConfigPath     string
	StartupPath    string
	StartupFile    string
	StartupCommand *commandSpec
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
		}, nil
	case "linux":
		binaryPath := path.Join(home, ".local", "bin", "pi-agent-suite-remote-image")
		configPath := path.Join(home, ".config", "pi-agent-suite", "remote-image.json")
		startupPath := path.Join(home, ".config", "autostart", "pi-agent-suite-remote-image.desktop")
		return installationPlan{
			BinaryPath:  binaryPath,
			ConfigPath:  configPath,
			StartupPath: startupPath,
			StartupFile: desktopEntry(binaryPath, configPath),
		}, nil
	case "windows":
		if localAppData == "" {
			return installationPlan{}, fmt.Errorf("LOCALAPPDATA is required on Windows")
		}
		root := windowsJoin(localAppData, "PiAgentSuite")
		binaryPath := windowsJoin(root, "remote-image.exe")
		configPath := windowsJoin(root, "remote-image.json")
		taskCommand := fmt.Sprintf("\"%s\" --config \"%s\"", binaryPath, configPath)
		return installationPlan{
			BinaryPath: binaryPath,
			ConfigPath: configPath,
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
</dict></plist>
`, launchAgentName, html.EscapeString(binaryPath), html.EscapeString(configPath))
}

func desktopEntry(binaryPath, configPath string) string {
	return fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=Pi Agent Suite Remote Image
Exec="%s" --config "%s"
Terminal=false
X-GNOME-Autostart-enabled=true
`, strings.ReplaceAll(binaryPath, `"`, `\"`), strings.ReplaceAll(configPath, `"`, `\"`))
}

func windowsJoin(base string, elements ...string) string {
	var result strings.Builder
	result.WriteString(strings.TrimRight(base, `\/`))
	for _, element := range elements {
		result.WriteString(`\` + strings.Trim(element, `\/`))
	}
	return result.String()
}
