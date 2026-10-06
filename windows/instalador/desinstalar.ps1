<#
Remove o trackeroao desta maquina, desfazendo o instalar.ps1. Normalmente
executado pelo trackeroao-desinstalador.exe.

Remove:
  - a tarefa agendada (e a de nome antigo, 'SekiroProgressSync', se existir)
  - os processos do servico e o icone da bandeja
  - o atalho da area de trabalho e o registro em "Aplicativos instalados"
  - a regra de firewall da porta 8777 -- unico passo que pede administrador
  - a pasta da instalacao, com o runtime portatil do Node se ele foi baixado

Mantem o Node.js instalado pelo winget ou ja presente, e o save do jogo.

Antes de apagar a pasta, pergunta se deve guardar o progresso local
(contagens, efeitos, selecao de jogos e copias da hibernacao) em Documentos;
o padrao e guardar. Sem pergunta: -GuardarProgresso ou -ApagarProgresso.
#>

# Os padroes podem vir do ambiente (repassados pelo trackeroao-desinstalador.exe).
param(
  [string]$Destino = $(if ($env:TRACKEROAO_DESTINO) { $env:TRACKEROAO_DESTINO }
                       else { Join-Path $env:LOCALAPPDATA 'trackeroao' }),
  [switch]$GuardarProgresso,
  [switch]$ApagarProgresso,
  # Preenchidos pelo proprio script quando ele se relanca elevado.
  [string]$UsuarioOriginal,
  [switch]$JaElevado
)

$ErrorActionPreference = 'Stop'

function Passo($t) { Write-Host "`n$t" -ForegroundColor Cyan }
function Ok($t)    { Write-Host "  $t" -ForegroundColor Green }
function Nota($t)  { Write-Host "  $t" -ForegroundColor DarkGray }
function Ruim($t)  { Write-Host "  $t" -ForegroundColor Red }

<#
  Com TRACKEROAO_GUI: progresso em linhas @@, sem perguntas (a elevacao e
  feita pelo .exe e o progresso e guardado).
#>
$gui = [bool]$env:TRACKEROAO_GUI
# Erros nao tratados: na janela, viram mensagem com a linha; no console,
# seguem para o PowerShell.
trap {
  if ($gui) {
    [Console]::Out.WriteLine("@@ERRO #unexpected|$($_.InvocationInfo.ScriptLineNumber)|$($_.Exception.Message)")
    [Console]::Out.Flush()
    exit 1
  }
  break
}
if ($gui) {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $ProgressPreference = 'SilentlyContinue'
  if ($env:TRACKEROAO_USUARIO) { $UsuarioOriginal = $env:TRACKEROAO_USUARIO }
  if (-not $ApagarProgresso) { $GuardarProgresso = $true }
}
function Tela($tipo, $texto) {
  if ($gui) { [Console]::Out.WriteLine("@@$tipo $texto"); [Console]::Out.Flush() }
}
function Etapa($pct, $texto) { Tela 'PASSO' "$pct $texto" }
function Detalhe($texto) { Tela 'DETALHE' $texto }
$fraseDaCopia = $null
Etapa 3 '#prep_rem'

$pendencias = @()

<#
  Elevacao (necessaria so para a regra de firewall). O usuario e o $Destino
  sao resolvidos antes de elevar, pois outra conta teria outro %LOCALAPPDATA%.
  Se recusada, a regra fica como pendencia.
#>
$souAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
             ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$elevacaoNegada = $false

if (-not $gui -and -not $souAdmin -and -not $JaElevado) {
  $quemPediu = "$env:USERDOMAIN\$env:USERNAME"
  Nota 'pedindo administrador para remover a regra de firewall'
  $argsElevado = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
            '-Destino', "`"$Destino`"", '-UsuarioOriginal', "`"$quemPediu`"", '-JaElevado')
  if ($GuardarProgresso) { $argsElevado += '-GuardarProgresso' }
  if ($ApagarProgresso)  { $argsElevado += '-ApagarProgresso' }
  try {
    $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList $argsElevado
    exit $p.ExitCode
  } catch {
    Nota 'administrador recusado; seguindo sem ele'
    $elevacaoNegada = $true
  }
}

if ($gui) { $JaElevado = $souAdmin }
if (-not $UsuarioOriginal) { $UsuarioOriginal = "$env:USERDOMAIN\$env:USERNAME" }

# Pasta pessoal do usuario original.
function Pasta-DeQuemPediu($qual) {
  if ($UsuarioOriginal -ne "$env:USERDOMAIN\$env:USERNAME") {
    $apenasNome = ($UsuarioOriginal -split '\\')[-1]
    $tentativa = Join-Path (Join-Path (Split-Path $env:PUBLIC -Parent) $apenasNome) $qual
    if (Test-Path $tentativa) { return $tentativa }
  }
  if ($qual -eq 'Desktop') { return [Environment]::GetFolderPath('Desktop') }
  return [Environment]::GetFolderPath('MyDocuments')
}

Write-Host "trackeroao - desinstalacao" -ForegroundColor White
Nota "pasta: $Destino"

# ============================================================== 1. servico
Passo '1/5  Servico'
Etapa 12 '#r_stop'
Detalhe '#r_stop_d'
foreach ($nome in @('TrackeroaoSync', 'SekiroProgressSync')) {
  if (Get-ScheduledTask -TaskName $nome -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $nome -Confirm:$false -ErrorAction SilentlyContinue
    Ok "tarefa '$nome' removida"
  }
}

# So os processos desta instalacao: os que tem o caminho de sync\ na linha
# de comando.
$encerrados = 0
$marca = $Destino.TrimEnd('\') + '\sync\'
Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe' OR Name = 'wscript.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($marca, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
                 $_.ProcessId -ne $PID } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $encerrados++
  }
# Fecha a janela do Trackeroao, se aberta.
$pastaApp = Join-Path $Destino 'app'
Get-Process -Name 'Trackeroao' -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($pastaApp, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; $encerrados++ }
if ($encerrados) { Ok "$encerrados processo(s) encerrado(s)" } else { Nota 'nada rodando' }

# ================================================================ 2. atalho
Passo '2/5  Atalho'
Etapa 34 '#r_shortcut'
$lnk = Join-Path (Pasta-DeQuemPediu 'Desktop') 'trackeroao.lnk'
if (Test-Path $lnk) { Remove-Item $lnk -Force; Ok "removido: $lnk" } else { Nota 'nao havia atalho' }

# ================================================================== 3. rede
Passo '3/5  Rede'
Etapa 46 '#r_port'
if ($souAdmin -or $JaElevado) {
  $regras = @(Get-NetFirewallRule -DisplayName 'trackeroao (*)' -ErrorAction SilentlyContinue)
  if ($regras.Count) {
    $regras | Remove-NetFirewallRule
    Ok "$($regras.Count) regra(s) de firewall removida(s)"
  } else { Nota 'nao havia regra de firewall' }
} else {
  Nota 'sem administrador, a regra de firewall fica'
  $pendencias += $(if ($gui) { '#r_port_pending' }
                   else { "a regra 'trackeroao (8777)' continua no Firewall do Windows; ela so libera a porta 8777 na rede local" })
}

# ============================================================= 4. progresso
Passo '4/5  Progresso'
Etapa 60 '#r_save'
# Arquivos gerados localmente.
$estado = @('progress.json', 'deaths.json', 'deaths-mem.json', 'bosskills.json', 'efeitos.json',
            'selecao.json', 'sync\.state.json', 'arquivo')
$existentes = @($estado | Where-Object { Test-Path (Join-Path $Destino $_) })

if (-not (Test-Path $Destino)) {
  Nota 'a pasta da instalacao nao existe'
} elseif (-not $existentes.Count) {
  Nota 'nao ha progresso gravado nesta maquina'
} else {
  $guardar = $true
  if ($ApagarProgresso) { $guardar = $false }
  elseif (-not $GuardarProgresso) {
    $r = Read-Host '  Guardar uma copia do progresso desta maquina nos Documentos? (S/n)'
    if ($r -match '^\s*n') { $guardar = $false }
  }
  if ($guardar) {
    $copia = Join-Path (Pasta-DeQuemPediu 'Documents') ("trackeroao-progresso-" + (Get-Date -Format 'yyyy-MM-dd-HHmm'))
    New-Item -ItemType Directory -Path $copia -Force | Out-Null
    foreach ($rel in $existentes) {
      $alvo = Join-Path $copia $rel
      New-Item -ItemType Directory -Path (Split-Path $alvo -Parent) -Force | Out-Null
      Copy-Item -Path (Join-Path $Destino $rel) -Destination $alvo -Recurse -Force
    }
    Ok "copia em $copia"
    $fraseDaCopia = "#r_saved|$(Split-Path $copia -Leaf)"
  } else {
    Nota 'o progresso sai junto com a pasta'
  }
}

# O registro em "Aplicativos instalados", feito pelo instalador em HKCU.
$chave = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\trackeroao'
if ($UsuarioOriginal -eq "$env:USERDOMAIN\$env:USERNAME" -and (Test-Path $chave)) {
  Remove-Item -Path $chave -Recurse -Force -ErrorAction SilentlyContinue
}

# ================================================================= 5. pasta
Passo '5/5  Pasta'
Etapa 78 '#r_files'
if (Test-Path $Destino) {
  # Repete: um processo recem-encerrado pode manter arquivos abertos.
  $removida = $false
  foreach ($tentativa in 1..5) {
    try { Remove-Item -Path $Destino -Recurse -Force; $removida = $true; break }
    catch { Start-Sleep -Seconds 1 }
  }
  if ($removida) { Ok "removida: $Destino" }
  else {
    Ruim "nao consegui remover tudo de $Destino"
    $pendencias += $(if ($gui) { "#r_inuse|$Destino" }
                     else { "apagar a pasta $Destino (algum arquivo estava em uso)" })
  }
} else {
  Nota 'nada a remover'
}

Write-Host "`nPronto. O trackeroao nao esta mais nesta maquina." -ForegroundColor Green
Nota 'o Node.js, se foi instalado fora da pasta, continua: pode servir a outros programas'

if ($pendencias) {
  Write-Host "`nFicou para voce:" -ForegroundColor Yellow
  foreach ($p in $pendencias) { Write-Host "  - $p" -ForegroundColor Yellow; Tela 'PENDENCIA' $p }
}
if ($fraseDaCopia) { Detalhe $fraseDaCopia }
Tela 'PRONTO' '#removed'

# Espera uma tecla para o relatorio ficar visivel.
if (-not $gui -and ($JaElevado -or $env:TRACKEROAO_EXE)) {
  Write-Host "`nTecle algo para fechar." -ForegroundColor DarkGray
  [void]$Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}

if ($gui) { exit 0 }
