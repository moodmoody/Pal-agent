# 安装后置：把预置角色铺到 %USERPROFILE%\.pal\personas 并在 config.json 里启用。
# 由 NSIS 的 customInstall 宏调用（installer.nsh）。必须兼容 Windows PowerShell 5.1。
# 设计原则：只补不改。用户已有 config.json 时合并 personas.enabled，其余字段原样保留；
# 解析失败则放弃写配置，绝不覆盖用户文件。

$ErrorActionPreference = 'Continue'

$palHome = Join-Path $env:USERPROFILE '.pal'
$personasDir = Join-Path $palHome 'personas'
$logDir = Join-Path $palHome 'logs'
$logLines = New-Object System.Collections.ArrayList

function Write-Log([string]$msg) {
    [void]$logLines.Add($msg)
}

try {
    Write-Log "palHome=$palHome"

    # ---- 1. 复制角色文件 ----
    New-Item -ItemType Directory -Force -Path $personasDir | Out-Null

    $srcDir = Join-Path $PSScriptRoot 'personas'
    if (-not (Test-Path -LiteralPath $srcDir)) {
        $srcDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'personas'
    }
    Write-Log "srcDir=$srcDir exists=$(Test-Path -LiteralPath $srcDir)"

    $copied = @()
    if (Test-Path -LiteralPath $srcDir) {
        $mdFiles = @(Get-ChildItem -LiteralPath $srcDir -Filter '*.md' -File -ErrorAction SilentlyContinue)
        Write-Log "mdFiles=$($mdFiles.Count)"
        foreach ($f in $mdFiles) {
            $dest = Join-Path $personasDir $f.Name
            # 已存在则跳过：用户可能改过自己的角色设定，升级不该覆盖
            if (-not (Test-Path -LiteralPath $dest)) {
                Copy-Item -LiteralPath $f.FullName -Destination $dest -Force -ErrorAction SilentlyContinue
                if (Test-Path -LiteralPath $dest) { $copied += $f.Name }
            }
        }
    }
    Write-Log "copied=$($copied -join ',')"

    # ---- 2. 启用角色 ----
    $cfgPath = Join-Path $palHome 'config.json'
    $cfg = $null

    if (Test-Path -LiteralPath $cfgPath) {
        try {
            $raw = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8
            if ($raw -and $raw.Trim().Length -gt 0) { $cfg = $raw | ConvertFrom-Json }
        } catch { $cfg = $null }
    }

    $configOk = $false
    # 全新机器没有 config.json：从空对象起，只写 personas 段，其余由 Pal 首次启动补默认值
    if ($null -eq $cfg) { $cfg = New-Object psobject }

    try {
        $names = @($cfg.PSObject.Properties.Name)
        if ($names -notcontains 'personas') {
            $cfg | Add-Member -NotePropertyName personas -NotePropertyValue (New-Object psobject) -Force
        }
        if ($null -eq $cfg.personas) { $cfg.personas = New-Object psobject }

        $pn = @($cfg.personas.PSObject.Properties.Name)
        if ($pn -notcontains 'enabled') {
            $cfg.personas | Add-Member -NotePropertyName enabled -NotePropertyValue (New-Object psobject) -Force
        }
        if ($null -eq $cfg.personas.enabled) { $cfg.personas.enabled = New-Object psobject }

        # 只补缺失的键，不覆盖用户已有的开关（用户主动关掉的角色必须保持关闭）
        foreach ($id in @('general', 'unrestricted', 'xiaomajiang')) {
            $ids = @($cfg.personas.enabled.PSObject.Properties.Name)
            if ($ids -notcontains $id) {
                $cfg.personas.enabled | Add-Member -NotePropertyName $id -NotePropertyValue $true -Force
            }
        }

        $out = $cfg | ConvertTo-Json -Depth 32
        [System.IO.File]::WriteAllText($cfgPath, $out, (New-Object System.Text.UTF8Encoding($false)))
        $configOk = $true
    } catch {
        Write-Log "configError=$($_.Exception.Message)"
        $configOk = $false
    }
    Write-Log "configUpdated=$configOk"
} catch {
    Write-Log "fatal=$($_.Exception.Message)"
}

# ---- 3. 落日志 ----
try {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $all = @("[$stamp] install-personas") + $logLines
    $all | Set-Content -LiteralPath (Join-Path $logDir 'install-personas.log') -Encoding UTF8
} catch { }

exit 0
