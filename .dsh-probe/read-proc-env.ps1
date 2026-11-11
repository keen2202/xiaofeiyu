# Read another process's environment block (same-user, non-elevated) and report selected keys.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File read-proc-env.ps1 -ProcessId <pid> [-Keys ONEBOT_ACCESS_TOKEN,NAPCAT_...,...]
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [string]$Keys = 'ONEBOT_ACCESS_TOKEN',
  [string]$Match = ''
)
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ProcEnvReaderX {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int read);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr R3; }
  public static string GetEnv(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid);
    if (h == IntPtr.Zero) return "OPEN_FAILED:" + Marshal.GetLastWin32Error();
    try {
      PBI pbi = new PBI(); int ret;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return "NTQ_FAILED";
      byte[] b = new byte[8]; int read;
      if (!ReadProcessMemory(h, pbi.Peb + 0x20, b, 8, out read)) return "PEB_FAILED";
      IntPtr pp = (IntPtr)BitConverter.ToInt64(b, 0);
      if (!ReadProcessMemory(h, pp + 0x80, b, 8, out read)) return "PARAMS_FAILED";
      IntPtr env = (IntPtr)BitConverter.ToInt64(b, 0);
      int len = 1 << 16;
      byte[] sizeBuf = new byte[8];
      if (ReadProcessMemory(h, pp + 0x3F0, sizeBuf, 8, out read)) { int v = BitConverter.ToInt32(sizeBuf, 0); if (v > 0 && v < (1 << 20)) len = v; }
      byte[] buf = new byte[len];
      if (!ReadProcessMemory(h, env, buf, len, out read)) return "ENV_READ_FAILED";
      return Encoding.Unicode.GetString(buf, 0, read).Replace("\0", "\n");
    } finally { CloseHandle(h); }
  }
}
'@
Add-Type -TypeDefinition $src -ErrorAction Stop
$text = [ProcEnvReaderX]::GetEnv($ProcessId)
if ($text -notmatch '=') { throw "cannot read env: $text" }
$lines = $text -split "`n"
foreach ($k in ($Keys -split ',')) {
  $hit = $lines | Where-Object { $_ -match ("^" + [regex]::Escape($k) + "=") } | Select-Object -First 1
  if ($hit) { Write-Output ("{0}=<set, {1} chars>" -f $k, ($hit -replace ("^" + [regex]::Escape($k) + "="), '').Length) }
  else { Write-Output ("{0}=<missing>" -f $k) }
}
foreach ($m in ($Match -split ',')) {
  if (-not $m) { continue }
  $lines | Where-Object { $_ -match $m } | ForEach-Object { Write-Output ("MATCH: " + ($_ -replace '=.*$', '=<set>')) }
}
