# Real-DSH + OneBot stub integration probe (Windows PowerShell 5.1 compatible).
# Boots the probe profile with the plugin's optional OneBot v11 host configured
# against the local stub, then pushes one inbound QQ event through the real DSH
# web fence and checks ingestion/dedupe after shutdown. The stub is NOT QQ.
$ErrorActionPreference = 'Stop'
$probePort = 39780
$probeHome = 'D:\Workespace\xiaofeiyu\.dsh-probe-home'
$stubHttp = 'http://127.0.0.1:13000'
$out = 'D:\Workespace\xiaofeiyu\.dsh-probe\qq-dsh-run.log'
$err = 'D:\Workespace\xiaofeiyu\.dsh-probe\qq-dsh-run.err.log'
$dshCmd = 'D:\DSHdesktop\resources\runtime\cli\bin\dsh.cmd'
$probeDataDir = 'D:\Workespace\xiaofeiyu\.dsh-probe-home\dsh-bili-unified'
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
    if (Test-Path $out) {
      $match = Select-String -Path $out -Pattern 'dsh web: (http://\S+)' | Select-Object -First 1
      if ($match) { $base = $match.Matches[0].Groups[1].Value; break }
      if ($proc.HasExited) { Write-Host "PROC_EXITED_EARLY=$($proc.ExitCode)"; break }
    }
  }
  if (-not $base) {
    Write-Host 'NO_BOOT_URL'
    Get-Content $out, $err -ErrorAction SilentlyContinue | Select-Object -First 60
    return
  }
  Write-Host "BOOT_URL=$base"

  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $index = Invoke-WebRequest -Uri $base -WebSession $session -UseBasicParsing
  Write-Host "INDEX_STATUS=$([int]$index.StatusCode) COOKIE_COUNT=$($session.Cookies.Count)"

  $route = "http://127.0.0.1:$probePort/dsh-bili-unified/api/status"
  $status = Invoke-Status -Uri $route -Session $session
  Write-Host "STATUS_HTTP=$($status.status)"
  $parsed = $status.body | ConvertFrom-Json
  $im = $parsed.result.components.im
  Write-Host ("IM_COMPONENT=" + ($im | ConvertTo-Json -Depth 6 -Compress))
  $parsed.result | ConvertTo-Json -Depth 8 | Set-Content 'D:\Workespace\xiaofeiyu\.dsh-probe\qq-dsh-status.json' -Encoding UTF8

  $event = @{
    post_type = 'message'; message_type = 'private'; self_id = 123456789; user_id = 20002
    message_id = 5002; time = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    message = @(@{ type = 'text'; data = @{ text = '{"action":"task.list","input":{},"mode":"dry"}' } })
  } | ConvertTo-Json -Depth 6
  $emit1 = Invoke-RestMethod -Uri "$stubHttp/__emit" -Method Post -ContentType 'application/json' -Body $event
  Write-Host "EMIT1_DELIVERED=$($emit1.delivered)"
  Start-Sleep -Seconds 2
  # Same event id again: dedupe must not execute twice.
  $emit2 = Invoke-RestMethod -Uri "$stubHttp/__emit" -Method Post -ContentType 'application/json' -Body $event
  Write-Host "EMIT2_DELIVERED=$($emit2.delivered)"
  Start-Sleep -Seconds 2

  $statusAfter = Invoke-Status -Uri $route -Session $session
  $parsedAfter = $statusAfter.body | ConvertFrom-Json
  Write-Host ("COUNTS_AFTER=" + ($parsedAfter.result.counts | ConvertTo-Json -Compress))
} finally {
  & cmd.exe /c "taskkill /PID $($proc.Id) /T /F" *> $null
  Start-Sleep -Seconds 2
  Get-NetTCPConnection -LocalPort $probePort -State Listen -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
  Write-Host '=== im status after shutdown ==='
  & node 'D:\Workespace\xiaofeiyu\cli.mjs' im status --data-dir $probeDataDir --config "$probeDataDir\config.json" 2>&1 | Select-Object -First 80
  Write-Host '=== backup status (probe) ==='
  & node 'D:\Workespace\xiaofeiyu\cli.mjs' backup status --data-dir $probeDataDir 2>&1 | Select-Object -First 20
  Write-Host '=== stub log tail ==='
  Get-Content 'D:\Workespace\xiaofeiyu\.dsh-probe\onebot-stub.log' -Tail 12 -ErrorAction SilentlyContinue
  Write-Host 'QQ_DSH_PROBE_DONE'
}
