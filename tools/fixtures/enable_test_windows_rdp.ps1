$ErrorActionPreference = 'Stop'

$terminalServer = 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server'
Set-ItemProperty -Path $terminalServer -Name fDenyTSConnections -Type DWord -Value 0

$rules = @(
    'RemoteDesktop-UserMode-In-TCP',
    'RemoteDesktop-UserMode-In-UDP'
)
Enable-NetFirewallRule -Name $rules

$productRule = Get-NetFirewallRule -Name 'TeamAIBox-RDP' -ErrorAction SilentlyContinue
if ($null -eq $productRule) {
    New-NetFirewallRule -Name 'TeamAIBox-RDP' -DisplayName 'Team AI Box Remote Desktop' `
        -Direction Inbound -Protocol TCP -LocalPort 3389 -Action Allow -Profile Any | Out-Null
} else {
    Set-NetFirewallRule -Name 'TeamAIBox-RDP' -Enabled True -Action Allow -Profile Any
}
Set-Service -Name TermService -StartupType Automatic
if ((Get-Service -Name TermService).Status -ne 'Running') {
    Start-Service -Name TermService
}
Start-Sleep -Seconds 2

$deny = (Get-ItemProperty -Path $terminalServer -Name fDenyTSConnections).fDenyTSConnections
$service = Get-Service -Name TermService
$firewall = Get-NetFirewallRule -Name $rules
$listener = @(
    [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
        Where-Object { $_.Port -eq 3389 }
)

$interfaces = @(
    [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
        ForEach-Object { $_.Address.ToString() } |
        Where-Object { $_ -notmatch '^127\\.' -and $_ -ne '::1' }
)
$productName = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').ProductName
$result = [pscustomobject]@{
    RdpEnabled = ($deny -eq 0)
    Service = $service.Status.ToString()
    StartupType = $service.StartType.ToString()
    FirewallRules = @($firewall | ForEach-Object { $_.Name })
    ListenerAddresses = @($listener | ForEach-Object { $_.Address.ToString() })
    InterfaceAddresses = $interfaces
    ProductName = $productName
}
$json = $result | ConvertTo-Json -Compress
Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'http://10.0.2.2:18080/result' `
    -ContentType 'application/json' -Body $json | Out-Null

if ($deny -ne 0 -or $service.Status -ne 'Running' -or ($firewall.Enabled -contains 'False') -or $null -eq $listener) {
    throw 'rdp_enable_verification_failed'
}

$json
