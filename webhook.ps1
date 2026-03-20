param([string]$url)
$body = @{
    webhook = @{
        enabled = $true
        url = "$url/webhook/whatsapp"
        byEvents = $false
        base64 = $false
        events = @("MESSAGES_UPSERT")
    }
} | ConvertTo-Json -Depth 3
Invoke-RestMethod -Method POST -Uri "http://localhost:8080/webhook/set/Fari-agent" -Headers @{"apikey"="casafaria2024"} -ContentType "application/json" -Body $body
