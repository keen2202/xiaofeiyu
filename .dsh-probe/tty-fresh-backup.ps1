# TTY helper: create a fresh ledger recovery point on the remote independent medium.
# Use right before an IM outbound test (protection window is 20 minutes).
$ErrorActionPreference = 'Stop'
Set-Location 'D:\Workespace\xiaofeiyu'

Write-Host '=== [0/3] ensure remote backup destination is mounted ==='
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.dsh-probe\setup-remote-backup.ps1'
if ($LASTEXITCODE -ne 0) { throw 'setup-remote-backup failed' }

Write-Host ''
Write-Host '=== [1/3] create a fresh ledger point (TTY challenge) ==='
node cli.mjs backup create --kind ledger --confirm
if ($LASTEXITCODE -ne 0) { throw 'backup create failed' }

Write-Host ''
Write-Host '=== [2/3] protection status ==='
$detail = node cli.mjs backup status
$detail
$detailObj = $detail | ConvertFrom-Json
$protection = (node cli.mjs status | ConvertFrom-Json).backup
Write-Host ''
Write-Host '=== [3/3] concise result ==='
Write-Host ("backup.status = " + $protection.status)
Write-Host ("latest.backupId = " + $detailObj.service.latest.backupId)
Write-Host ("latest.cutAt = " + $detailObj.service.latest.cutAt)
Write-Host ("backup.ageMs = " + $protection.ageMs)
if ($protection.status -ne 'protected') { throw 'backup protection is not protected; copy the output above' }
