# Re-establish the independent backup destination:
#   Windows -> SMB (WSL Samba) -> SSHFS -> Tencent Cloud host /srv/dsh-bili-backups
# Safe to re-run. Run as the normal Windows user (no admin required).
$ErrorActionPreference = 'Continue'
$env:WSL_UTF8 = '1'
$wslKey = '/home/keen2206/.ssh/win1.pem'

function WslOut([string]$cmd) {
  $out = & wsl.exe -e bash -lc $cmd 2>$null
  return (($out | Out-String).Trim())
}

Write-Host '[1/4] WSL distro + sshfs mount ...'
$mounted = WslOut 'mountpoint -q /home/keen2206/dsh-bili-backups && echo MOUNTED || echo MISSING'
if ($mounted -notmatch 'MOUNTED') {
  & wsl.exe -u keen2206 -e bash -lc "sshfs ubuntu@42.193.20.17:/srv/dsh-bili-backups /home/keen2206/dsh-bili-backups -o IdentityFile=$wslKey -o StrictHostKeyChecking=accept-new -o reconnect -o ServerAliveInterval=15 -o allow_other" 2>$null | Out-Null
  $mounted = WslOut 'mountpoint -q /home/keen2206/dsh-bili-backups && echo MOUNTED || echo MISSING'
}
if ($mounted -notmatch 'MOUNTED') { throw 'sshfs mount failed' }
Write-Host '  sshfs mount ok'

Write-Host '[2/4] Samba share (WSL) ...'
$sambaUp = WslOut "ss -ltn | grep -q ':445' && echo UP || echo DOWN"
if ($sambaUp -notmatch 'UP') {
  & wsl.exe -u root -e bash /mnt/d/Workespace/xiaofeiyu/.dsh-probe/setup-samba-wsl.sh 2>$null | Out-Host
}
Write-Host '  samba ok'

Write-Host '[3/4] Resolve WSL IP and map SMB share ...'
$ip = ((WslOut 'hostname -I') -split '\s+')[0]
if (-not $ip) { throw 'cannot resolve WSL IP' }
$share = "\\$ip\dsh-bili-backups"
$passFile = Join-Path $PSScriptRoot 'smb-pass.txt'
$pw = (Get-Content $passFile -Raw).Trim()
& cmd.exe /c "net use `"$share`" /user:bili $pw /persistent:no" 2>$null | Out-Null
if (Test-Path $share) {
  Write-Host "  mapped: $share"
} else {
  throw "SMB share not reachable: $share"
}

Write-Host '[4/4] Write/read check ...'
$probe = Join-Path $share '.mount-probe.txt'
Set-Content -Path $probe -Value (Get-Date -Format o) -Encoding ascii
$value = Get-Content $probe -Raw
if (-not $value) { throw 'write/read probe failed' }
& cmd.exe /c "del `"$probe`"" 2>$null | Out-Null
Write-Host '  write/read ok'
Write-Host ''
Write-Host "BACKUP_DESTINATION=$share"
