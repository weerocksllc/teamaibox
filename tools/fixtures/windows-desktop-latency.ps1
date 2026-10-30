# Disposable in-memory UI for the authorized Windows development guest.
# No credentials, network, registry changes, installation, or saved files.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$window = New-Object System.Windows.Forms.Form
$window.Text = 'Team AI Box response test - press 1 to 8; Alt+F4 exits'
$window.WindowState = 'Maximized'
$window.KeyPreview = $true
$window.BackColor = [System.Drawing.Color]::FromArgb(31,231,65)
$window.Add_KeyDown({
  $number = [int]$_.KeyCode - [int][System.Windows.Forms.Keys]::D0
  if ($number -ge 1 -and $number -le 8) {
    $this.BackColor = [System.Drawing.Color]::FromArgb(32*$number-1,255-24*$number,64+$number)
    $this.Refresh()
  }
})
[System.Windows.Forms.Application]::Run($window)
