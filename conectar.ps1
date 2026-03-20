$r = Invoke-RestMethod -Method GET -Uri "http://localhost:8080/instance/connect/Fari-agent" -Headers @{"apikey"="casafaria2024"}
$base64 = $r.base64 -replace "data:image/png;base64,", ""
[System.IO.File]::WriteAllBytes("$PWD\qr.png", [Convert]::FromBase64String($base64))
Start-Process "qr.png"
Write-Host "QR code aberto! Escaneie com o WhatsApp."
