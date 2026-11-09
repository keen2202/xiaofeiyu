# Real local-DSH host probe (Windows PowerShell 5.1 compatible).
# Boots the probe profile with the workspace plugin junction-mounted, then
# exercises the plugin HTTP route through the real DSH web fence.
$ErrorActionPreference = 'Stop'
$probePort = 39779
$probeHome = 'D:\Workespace\xiaofeiyu\.dsh-probe-home'
$out = 'D:\Workespace\xiaofeiyu\.dsh-probe\host-run.log'
$err = 'D:\Workespace\xiaofeiyu\.dsh-probe\host-run.err.log'
$dshCmd = 'D:\DSHdesktop\resources\runtime\cli\bin\dsh.cmd'
Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort $probePort -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

function Invoke-Status {
  param($Uri, $Session)
  try {
    if ($Session) {
      $r = Invoke-WebRequest -Uri $Uri -WebSession $Session -UseBasicParsing
    } else {
      $r = Invoke-WebRequest -Uri $Uri -UseBasicParsing
    }
    return @{ status = [int]$r.StatusCode; body = [string]$r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $stream = $resp.GetResponseStream()
      $reader = New-Object System.IO.StreamReader($stream)
      return @{ status = [int]$resp.StatusCode; body = $reader.ReadToEnd() }
    }
    return @{ status = -1; body = $_.Exception.Message }
  }
}

function Stop-ProbeServer {
  param($ProcId)
  if ($ProcId) {
    & cmd.exe /c "taskkill /PID $ProcId /T /F" *> $null
  }
  Start-Sleep -Seconds 1
  Get-NetTCPConnection -LocalPort $probePort -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
}

$env:ELECTRON_RUN_AS_NODE = '1'
$env:DSH_HOME = $probeHome
$argsLine = "`"$dshCmd`" --profile probe --no-open --port $probePort"
$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $argsLine) `
  -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow -PassThru
Write-Host "PROBE_PID=$($proc.Id)"

try {
  $base = $null
  $deadline = (Get-Date).AddSeconds(150)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    if ($proc.HasExited -and $proc.ExitCode -ne 0 -and -not (Test-Path $out)) { break }
    if (Test-Path $out) {
      $match = Select-String -Path $out -Pattern 'dsh web: (http://\S+)' | Select-Object -First 1
      if ($match) { $base = $match.Matches[0].Groups[1].Value; break }
      if ($proc.HasExited) { Write-Host "PROC_EXITED_EARLY=$($proc.ExitCode)"; break }
    }
  }
  if (-not $base) {
    Write-Host 'NO_BOOT_URL'
    Write-Host '--- stdout ---'
    Get-Content $out -ErrorAction SilentlyContinue | Select-Object -First 60
    Write-Host '--- stderr ---'
    Get-Content $err -ErrorAction SilentlyContinue | Select-Object -First 60
  } else {
    Write-Host "BOOT_URL=$base"
    $resultPath = 'D:\Workespace\xiaofeiyu\.dsh-probe\host-probe-result.json'
    $result = [ordered]@{
      probedAt = (Get-Date).ToString('o')
      dshVersion = $null
      bootUrl = $base
      activationWarnings = @()
      indexStatus = $null
      cookieCount = $null
      authedStatus = $null
      authedBody = $null
      anonStatus = $null
      anonBody = $null
      unknownRouteStatus = $null
      configStatus = $null
      configBody = $null
    }
    $probeOut = 'D:\Workespace\xiaofeiyu\.dsh-probe\probe-out.json'
    if (Test-Path $probeOut) {
      try { $result.dshVersion = (Get-Content $probeOut -Raw | ConvertFrom-Json).dshPackage.version } catch { }
    }

    Start-Sleep -Seconds 3
    $logText = @()
    $logText += Get-Content $out -ErrorAction SilentlyContinue
    $logText += Get-Content $err -ErrorAction SilentlyContinue
    $warnings = $logText | Select-String -Pattern 'did not activate|Error:|Invalid effect|without inject'
    if ($warnings) {
      Write-Host 'ACTIVATION_WARNINGS:'
      $warnings | Select-Object -First 8 | ForEach-Object { Write-Host ('  ' + $_.Line) }
      $result.activationWarnings = @($warnings | Select-Object -First 8 | ForEach-Object { $_.Line })
    } else {
      Write-Host 'ACTIVATION_OK=no warnings in boot log'
    }

    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    try {
      $index = Invoke-WebRequest -Uri $base -WebSession $session -UseBasicParsing
      Write-Host "INDEX_STATUS=$([int]$index.StatusCode) COOKIE_COUNT=$($session.Cookies.Count)"
      $result.indexStatus = [int]$index.StatusCode
      $result.cookieCount = $session.Cookies.Count
    } catch {
      Write-Host "INDEX_ERROR=$($_.Exception.Message)"
    }

    $route = "http://127.0.0.1:$probePort/dsh-bili-unified/api/status"
    $authed = Invoke-Status -Uri $route -Session $session
    Write-Host "AUTHED_STATUS=$($authed.status)"
    Write-Host ("AUTHED_BODY=" + $authed.body.Substring(0, [Math]::Min(1200, $authed.body.Length)))
    $result.authedStatus = $authed.status
    $result.authedBody = $authed.body

    $anon = Invoke-Status -Uri $route
    Write-Host "ANON_STATUS=$($anon.status)"
    Write-Host ("ANON_BODY=" + $anon.body.Substring(0, [Math]::Min(400, $anon.body.Length)))
    $result.anonStatus = $anon.status
    $result.anonBody = $anon.body

    $unknown = Invoke-Status -Uri "http://127.0.0.1:$probePort/dsh-bili-unified/api/nope" -Session $session
    Write-Host "UNKNOWN_ROUTE_STATUS=$($unknown.status)"
    Write-Host ("UNKNOWN_ROUTE_BODY=" + $unknown.body.Substring(0, [Math]::Min(400, $unknown.body.Length)))
    $result.unknownRouteStatus = $unknown.status

    $config = Invoke-Status -Uri "http://127.0.0.1:$probePort/dsh-bili-unified/api/config" -Session $session
    Write-Host "CONFIG_STATUS=$($config.status)"
    Write-Host ("CONFIG_BODY=" + $config.body.Substring(0, [Math]::Min(600, $config.body.Length)))
    $result.configStatus = $config.status
    $result.configBody = $config.body

    $result | ConvertTo-Json -Depth 6 | Set-Content $resultPath -Encoding UTF8
    Write-Host "PROBE_RESULT=$resultPath"
  }
} finally {
  Stop-ProbeServer -ProcId $proc.Id
  Write-Host 'PROBE_DONE'
}
