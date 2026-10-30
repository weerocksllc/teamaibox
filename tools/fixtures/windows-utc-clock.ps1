# Run inside the Windows guest, not on the Spark host.
# QEMU supplies UTC hardware time. Keep the user's chosen display time zone.
# No account, firewall, RDP, certificate or domain time-source changes.
#Requires -RunAsAdministrator
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$UseAdaptivePolling)
$ErrorActionPreference = 'Stop'
$clockKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\TimeZoneInformation'
if ($UseAdaptivePolling -and -not $CheckOnly) {
    $parameters = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\W32Time\Parameters'
    # Only repair the default standalone guest; preserve custom/domain policy.
    if ((Get-CimInstance Win32_ComputerSystem).PartOfDomain -or
        (Test-Path 'HKLM:\SOFTWARE\Policies\Microsoft\W32Time') -or
        $parameters.Type -ne 'NTP' -or
        $parameters.NtpServer -notmatch '^time\.windows\.com,(0x0?[89]|[89])$') {
        throw 'Custom or domain time policy detected; no clock configuration was changed.'
    }
}
if (-not $CheckOnly) {
    New-ItemProperty $clockKey -Name RealTimeIsUniversal -PropertyType DWord -Value 1 -Force | Out-Null
    Set-Service W32Time -StartupType Automatic
    Start-Service W32Time
    if ($UseAdaptivePolling) {
        # Same server, built-in adaptive polling instead of long SpecialPollInterval.
        & w32tm /config '/manualpeerlist:time.windows.com,0x8' /update
        if ($LASTEXITCODE -ne 0) { throw 'Could not update Windows time polling.' }
        Restart-Service W32Time
    }
    # Keep the pre-existing time server/domain policy. A timeout is not success.
    & w32tm /resync /rediscover
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'Network time synchronization is not confirmed. Check the existing time server; do not disable certificate checks.'
    }
}
[PSCustomObject]@{
    UtcNow = [DateTime]::UtcNow.ToString('o')
    TimeZone = (Get-TimeZone).Id
    HardwareClockIsUtc = (Get-ItemPropertyValue $clockKey -Name RealTimeIsUniversal -ErrorAction SilentlyContinue) -eq 1
    ServiceStatus = (Get-Service W32Time).Status.ToString()
    ServiceStartType = (Get-Service W32Time).StartType.ToString()
}
& w32tm /query /status
