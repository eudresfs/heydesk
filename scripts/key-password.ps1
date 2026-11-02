# Mostra a senha da chave de assinatura, para guardar uma cópia num gerenciador de senhas.
# Sem essa cópia, perder este usuário do Windows (formatação, PC novo) torna a chave
# inutilizável, e o Heydesk instalado deixa de receber atualizações.
# Uso:  powershell -ExecutionPolicy Bypass -File scripts\key-password.ps1
param([string]$Key = "$env:USERPROFILE\.tauri\heydesk.key")
$ErrorActionPreference = "Stop"
if (-not (Test-Path "$Key.pass")) { throw "Senha da chave não encontrada em $Key.pass." }
[System.Net.NetworkCredential]::new("", (Get-Content "$Key.pass" -Raw | ConvertTo-SecureString)).Password
