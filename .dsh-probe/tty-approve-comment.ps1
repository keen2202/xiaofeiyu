# TTY helper: approve the pending real comment task and dispatch it once.
# Run in a REAL terminal window. The one-time challenge phrase must be typed by you.
# The approval's own nonce (required by --go) is read from .dsh-probe/last-approval.json.
$ErrorActionPreference = 'Stop'
Set-Location 'D:\Workespace\xiaofeiyu'

$ap = Get-Content '.dsh-probe\last-approval.json' -Raw | ConvertFrom-Json
$expires = [datetime]::Parse($ap.expiresAt).ToUniversalTime()
$now = (Get-Date).ToUniversalTime()
Write-Host "approval = $($ap.approvalId)"
Write-Host "task     = $($ap.taskId)"
Write-Host "expires  = $($ap.expiresAt) (UTC now: $($now.ToString('o')))"
if ($now -gt $expires) {
  throw 'approval has expired; tell the DSH agent to re-issue the comment draft approval'
}

node cli.mjs approval decide $ap.approvalId approve --nonce $ap.nonce --confirm --go
if ($LASTEXITCODE -ne 0) { throw 'approval decide failed; copy the error above' }

Write-Host ''
Write-Host '=== task state after approval ==='
node cli.mjs task get $ap.taskId
