$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut("F:\Fotat HR.lnk")
$sc.TargetPath = "F:\fotat-hr\start-fotat-hr.bat"
$sc.WorkingDirectory = "F:\fotat-hr"
$sc.IconLocation = "F:\fotat-hr\app.ico"
$sc.Save()
