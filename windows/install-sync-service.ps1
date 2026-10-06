<#
Registra o sincronizador como tarefa agendada, iniciando oculto no logon do
usuario atual.

Nao requer administrador (le apenas arquivos do usuario e escuta numa porta
alta). Rodar elevado registraria a tarefa para o usuario errado.
#>

# Caminho do Node informado pelo instalador (ex.: runtime portatil em
# runtime\node, fora do PATH).
param(
    [string]$NodePath,
    # Usuario da tarefa; padrao: o atual. Necessario quando a instalacao roda
    # elevada com outra conta.
    [string]$Usuario
)

$ErrorActionPreference = 'Stop'

# 'SekiroProgressSync' e o nome legado da tarefa, removido na reinstalacao.
# O projeto e a pasta acima de windows\.
$raiz       = Split-Path $PSScriptRoot -Parent
$taskName   = 'TrackeroaoSync'
$taskAntigo = 'SekiroProgressSync'
$mainScript = Join-Path $raiz 'sync\main.js'
# Caminhos dentro do proprio projeto.
$ocultoVbs  = Join-Path $raiz 'sync\oculto.vbs'
$wscript    = Join-Path $env:WINDIR 'System32\wscript.exe'

# --- node ---
# Ordem: parametro, PATH, Program Files e runtime portatil local.
$node = $null
if ($NodePath -and (Test-Path $NodePath)) { $node = $NodePath }
if (-not $node) { $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
if (-not $node) {
    foreach ($c in @((Join-Path $env:ProgramFiles 'nodejs\node.exe'),
                     (Join-Path $raiz 'runtime\node\node.exe'))) {
        if (Test-Path $c) { $node = $c; break }
    }
}
if (-not $node) {
    Write-Host "node.exe nao encontrado. Instale em https://nodejs.org e rode de novo." -ForegroundColor Red
    exit 1
}
Write-Host "node   : $node" -ForegroundColor DarkGray
Write-Host "script : $mainScript" -ForegroundColor DarkGray

if (-not (Test-Path $mainScript)) {
    Write-Host "Nao achei $mainScript" -ForegroundColor Red
    exit 1
}

# node.exe abre um console proprio (-WindowStyle nao se aplica); o oculto.vbs
# o inicia sem janela via wscript.
if (Test-Path $ocultoVbs) {
    $action = New-ScheduledTaskAction -Execute $wscript `
        -Argument "`"$ocultoVbs`" `"$node`" `"$mainScript`"" `
        -WorkingDirectory $raiz
    Write-Host "janela : oculta via wscript (sem dependencia externa)" -ForegroundColor DarkGray
} else {
    $action = New-ScheduledTaskAction -Execute $node `
        -Argument "`"$mainScript`"" `
        -WorkingDirectory $raiz
    Write-Host "janela : oculto.vbs nao encontrado, a janela do node vai aparecer" -ForegroundColor Yellow
}

if (-not $Usuario) { $Usuario = "$env:USERDOMAIN\$env:USERNAME" }
Write-Host "usuario: $Usuario" -ForegroundColor DarkGray
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $Usuario
$principal = New-ScheduledTaskPrincipal -UserId $Usuario -LogonType Interactive
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

# Encerra a instancia anterior para liberar a porta 8777.
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.Contains('main.js') } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "Instancia anterior (PID $($_.ProcessId)) encerrada." -ForegroundColor DarkGray
    }

foreach ($n in @($taskName, $taskAntigo)) {
    Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Description `
    'Serve a pagina de progresso e le o save enquanto o jogo estiver aberto' | Out-Null

Write-Host "Tarefa agendada '$taskName' criada (inicia oculta no login)." -ForegroundColor Green

# Grava abrir.pedido; sem ele o servico encerra ao subir (a menos que
# "Iniciar com o Windows" esteja marcado).
Set-Content -Path (Join-Path $raiz 'sync\abrir.pedido') -Value (Get-Date -Format o) -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3

# --- confere que o servico subiu ---
$porta = 8777
$ok = $false
foreach ($tentativa in 1..5) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$porta/" -TimeoutSec 4 -UseBasicParsing
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { Start-Sleep -Seconds 2 }
}

if (-not $ok) {
    Write-Host "O servidor nao respondeu em localhost:$porta." -ForegroundColor Red
    Write-Host "Veja o log: $(Join-Path $raiz 'sync\trackeroao.log')" -ForegroundColor Yellow
    exit 1
}

Write-Host "Servidor respondendo em localhost:$porta." -ForegroundColor Green

$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress
foreach ($ip in $ips) {
    Write-Host "  celular: http://${ip}:$porta/trackeroao.html" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "A partir de agora sobe sozinho no login. Nao precisa abrir nada." -ForegroundColor Green
Write-Host "Para remover: .\windows\uninstall-sync-service.ps1" -ForegroundColor Yellow
