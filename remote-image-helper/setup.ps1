param(
    [ValidateSet("Add", "Remove")]
    [string]$Action = "Add",
    [string]$SshTarget = $env:PI_AGENT_SUITE_SSH_TARGET,
    [string]$SshPassword = $env:PI_AGENT_SUITE_SSH_PASSWORD,
    [int]$ImagePort = 18775,
    [string]$Version = "latest"
)

$ErrorActionPreference = "Stop"
$repository = "n-r-w/pi-agent-suite"

if ([string]::IsNullOrWhiteSpace($SshTarget)) {
    throw "SshTarget or PI_AGENT_SUITE_SSH_TARGET is required"
}

switch ($env:PROCESSOR_ARCHITECTURE) {
    "AMD64" { $architecture = "amd64" }
    "ARM64" { $architecture = "arm64" }
    default { throw "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE" }
}

$asset = "pi-agent-suite-remote-image-windows-$architecture.exe"
if ($Version -eq "latest") {
    $url = "https://github.com/$repository/releases/latest/download/$asset"
} else {
    $tag = if ($Version.StartsWith("v")) { $Version } else { "v$Version" }
    $url = "https://github.com/$repository/releases/download/$tag/$asset"
}

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
try {
    $helper = Join-Path $temporaryDirectory $asset
    Invoke-WebRequest -Uri $url -OutFile $helper
    if ($Action -eq "Remove") {
        & $helper remove $SshTarget
    } else {
        $env:PI_AGENT_SUITE_SSH_TARGET = $SshTarget
        $env:PI_AGENT_SUITE_SSH_PASSWORD = $SshPassword
        $env:PI_AGENT_SUITE_IMAGE_PORT = $ImagePort.ToString()
        & $helper install
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Remote image helper setup failed with exit code $LASTEXITCODE"
    }
} finally {
    Remove-Item -Recurse -Force $temporaryDirectory -ErrorAction SilentlyContinue
}
