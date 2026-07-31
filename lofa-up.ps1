# LOFA 一键起栈 —— 机器重启后把"实机操作 / 审阅"链路拉起来。
#
#   1) Android 模拟器 (AVD lofa_test, headless)
#   2) devview        (8770)  截图 / 控制 / 分辨率切换 /dev/control
#   3) ws-scrcpy      (8781)  H264 实时镜像 + 反控
#   4) dashboard      (8210)  仅检测+提示 —— 它属 omnicompany, 由其自身拉起
#   5) 唤起 LOFA app
#
# 幂等: 已在跑的跳过, 可反复执行。零窗口: 全部 -WindowStyle Hidden 后台起, 不弹控制台。
# 用法:  powershell -ExecutionPolicy Bypass -File lofa-up.ps1     (或双击 lofa-up.cmd)

$ErrorActionPreference = 'SilentlyContinue'

$LOFA   = $PSScriptRoot
$SDK    = "$LOFA\tools\android-sdk"
$ADB    = "$SDK\platform-tools\adb.exe"
$EMU    = "$SDK\emulator\emulator.exe"
$OMNIPY = Join-Path $PSScriptRoot '..\omnicompany\venv\Scripts\python.exe'

$env:ANDROID_HOME     = $SDK
$env:ANDROID_SDK_ROOT = $SDK

function Say($m) { Write-Host "[lofa-up] $m" }

function Test-Port($p) {
  $c = New-Object Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $p); $c.Close(); return $true } catch { return $false }
}

function Stop-UnsafeDevview {
  # devview can tap/type/install through ADB. Retire legacy/manual listeners
  # before starting the canonical loopback-only instance.
  $listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object {
      $_.LocalPort -in @(8770, 8771) -and
      ($_.LocalPort -ne 8770 -or $_.LocalAddress -notin @('127.0.0.1', '::1'))
    }
  foreach ($listener in @($listeners)) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($proc -and ([string]$proc.CommandLine) -match 'tools[\\/]devview[\\/]server\.py') {
      Say "关闭不安全 devview 监听 $($listener.LocalAddress):$($listener.LocalPort) (pid=$($listener.OwningProcess))"
      $null = & taskkill /PID $listener.OwningProcess /T /F 2>&1
    }
  }
}

function Stop-UnsafeWsScrcpy {
  $listeners = Get-NetTCPConnection -State Listen -LocalPort 8781 -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') }
  foreach ($listener in @($listeners)) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($proc -and ([string]$proc.CommandLine) -match 'node(\.exe)?.*index\.js') {
      Say "关闭不安全 ws-scrcpy 监听 $($listener.LocalAddress):8781 (pid=$($listener.OwningProcess))"
      $null = & taskkill /PID $listener.OwningProcess /T /F 2>&1
    }
  }
}

# ── 1) devview (8770) ────────────────────────────────────────────────────────
# Security-critical and independent of emulator readiness, so establish the
# loopback listener before a potentially long AVD boot.
Stop-UnsafeDevview
if (Test-Port 8770) {
  Say 'devview(8770) 已在运行'
} else {
  Say '启动 devview(8770)…'
  Start-Process -FilePath $OMNIPY -WindowStyle Hidden `
    -WorkingDirectory "$LOFA\tools\devview" -ArgumentList @("$LOFA\tools\devview\server.py")
}

# ── 2) 模拟器 ────────────────────────────────────────────────────────────────
$devs = & $ADB devices 2>$null
if ($devs -match 'emulator-\d+\s+device') {
  Say 'emulator 已在运行'
} else {
  Say '启动 AVD lofa_test (headless)…'
  Start-Process -FilePath $EMU -WindowStyle Hidden -ArgumentList @(
    '-avd', 'lofa_test', '-no-window', '-no-audio', '-no-snapshot', '-no-boot-anim', '-gpu', 'angle_indirect')
  Say '等待开机完成 (最多 ~3min)…'
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep 2
    $bc = (& $ADB shell getprop sys.boot_completed 2>$null) -replace '\s', ''
    if ($bc -eq '1') { Say 'emulator 开机完成'; break }
  }
}

# ── 3) ws-scrcpy (8781) ──────────────────────────────────────────────────────
Stop-UnsafeWsScrcpy
if (Test-Port 8781) {
  Say 'ws-scrcpy(8781) 已在运行'
} else {
  Say '启动 ws-scrcpy(8781)…'
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
  $env:WS_SCRCPY_CONFIG = "$LOFA\tools\ws-scrcpy\wsconfig.yaml"
  $env:WS_SCRCPY_HOST = '127.0.0.1'
  $env:PATH = "$SDK\platform-tools;$env:PATH"   # Windows 路径分隔, 不踩 bash 的 E: 冒号坑
  Start-Process -FilePath $node -WindowStyle Hidden `
    -WorkingDirectory "$LOFA\tools\ws-scrcpy\dist" -ArgumentList @('index.js')
}

# ── 4) dashboard (8210, omnicompany; LOFA 强依赖它且必须 0.0.0.0 才能被手机/平板访问) ──
if (Test-Port 8210) {
  Say 'dashboard(8210) 在线'
} else {
  Say '启动 dashboard(8210) on 0.0.0.0(局域网可达)…'
  Start-Process -FilePath $OMNIPY -WindowStyle Hidden -WorkingDirectory (Join-Path $PSScriptRoot '..\omnicompany') `
    -ArgumentList @('-m','uvicorn','omnicompany.dashboard.app:app','--host','0.0.0.0','--port','8210','--log-level','warning')
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep 1; if (Test-Port 8210) { Say 'dashboard 已起'; break } }
}

# ── 5) 唤起 app ──────────────────────────────────────────────────────────────
& $ADB shell monkey -p cc.colorc.lofa -c android.intent.category.LAUNCHER 1 2>$null | Out-Null
Say 'LOFA app 已唤起'

Write-Host ''
Say '完成 ✓'
Say '  实机操作台(镜像 + 分辨率切换 一个台子): http://127.0.0.1:8770/dev/console'
Say '  审阅台看这一个材料即可。'
