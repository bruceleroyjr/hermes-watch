# PC health snapshot for the "how's my PC doing" voice command (see isPcHealthRequest in
# server.js). Read-only; prints one compact JSON object.
$ErrorActionPreference = 'SilentlyContinue'
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor
$totalGB = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
$freeGB = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
$up = (Get-Date) - $os.LastBootUpTime
$disks = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  [PSCustomObject]@{ drive = $_.DeviceID; sizeGB = [math]::Round($_.Size / 1GB); freeGB = [math]::Round($_.FreeSpace / 1GB, 1); freePct = [math]::Round(100 * $_.FreeSpace / $_.Size) }
}
$top = Get-Process | Where-Object { $_.ProcessName -notin @('svchost', 'Idle', 'System') } | Group-Object ProcessName | ForEach-Object {
  [PSCustomObject]@{ name = $_.Name; count = $_.Count; memMB = [math]::Round(($_.Group | Measure-Object WorkingSet64 -Sum).Sum / 1MB) }
} | Sort-Object memMB -Descending | Select-Object -First 5
# Win32_DiskDrive.Status is the drive's own SMART verdict: OK, or "Pred Fail" when it expects to fail.
# (Get-PhysicalDisk says the same but takes ~2 s to load.)
$drives = Get-CimInstance Win32_DiskDrive | ForEach-Object { [PSCustomObject]@{ name = $_.Model; status = $_.Status } }
# Event 41 = Windows came back without a clean shutdown (power cut, forced off, freeze).
$crashes = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41; StartTime = (Get-Date).AddDays(-30) } | Sort-Object TimeCreated -Descending)
$errors24h = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1, 2; StartTime = (Get-Date).AddHours(-24) }).Count
$reboot =(Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
[PSCustomObject]@{
  cpuModel = ($cpu | Select-Object -First 1).Name.Trim()
  cpuLoadPct = [math]::Round(($cpu | Measure-Object LoadPercentage -Average).Average)
  memTotalGB = $totalGB; memUsedGB = [math]::Round($totalGB - $freeGB, 1); memUsedPct = [math]::Round(100 * ($totalGB - $freeGB) / $totalGB)
  uptime = '{0}d {1}h {2}m' -f $up.Days, $up.Hours, $up.Minutes
  processCount = (Get-Process).Count
  disks = @($disks); drives = @($drives); topMemory = @($top); restartPending = $reboot
  unexpectedShutdowns30d = $crashes.Count
  lastUnexpectedShutdown = $(if ($crashes.Count) { $crashes[0].TimeCreated.ToString('MMM d, h:mm tt') } else { $null })
  systemErrors24h = $errors24h
} | ConvertTo-Json -Depth 3 -Compress
