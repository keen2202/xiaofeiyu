# TTY helper: save the owner-verified independent backup policy and create a fresh ledger point.
# Run this in a REAL terminal window (Windows Terminal or PowerShell console), NOT inside the DSH chat.
# Every --confirm step shows a one-time challenge phrase; type it yourself. Do not let any agent answer it.
$ErrorActionPreference = 'Stop'
Set-Location 'D:\Workespace\xiaofeiyu'

Write-Host '=== [0/5] ensure remote backup destination is mounted and reachable ==='
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.dsh-probe\setup-remote-backup.ps1'
if ($LASTEXITCODE -ne 0) { throw 'setup-remote-backup failed; fix the remote mount before continuing' }

Write-Host ''
Write-Host '=== [1/5] save owner-verified independent backup policy (TTY challenge) ==='
node cli.mjs backup policy --file .dsh-probe\backup-policy.remote.json --confirm
if ($LASTEXITCODE -ne 0) { throw 'backup policy save failed' }

Write-Host ''
Write-Host '=== [2/5] create a fresh ledger recovery point (TTY challenge) ==='
node cli.mjs backup create --kind ledger --confirm
if ($LASTEXITCODE -ne 0) { throw 'backup create failed' }

Write-Host ''
Write-Host '=== [3/5] protection status (expect backup.status=protected) ==='
$detail = node cli.mjs backup status
$detail
$detailObj = $detail | ConvertFrom-Json
$protection = (node cli.mjs status | ConvertFrom-Json).backup
Write-Host ''
Write-Host '=== [4/5] concise result ==='
Write-Host ("backup.status = " + $protection.status)
Write-Host ("backup.reason = " + $protection.reason)
Write-Host ("latest.backupId = " + $detailObj.service.latest.backupId)
Write-Host ("latest.cutAt = " + $detailObj.service.latest.cutAt)
Write-Host ("backup.ageMs = " + $protection.ageMs)

if ($protection.status -ne 'protected') {
  throw 'backup protection is not protected; copy the output above before retrying'
}
Write-Host ''
Write-Host '=== [5/5] DONE: copy the concise result and the latest.backupId back to the DSH chat ==='
