<#
Libera a porta 8777 no firewall para a rede local, para acesso pelo celular.
Pode ser executado separadamente do instalador.

  - Perfis: os que estao em uso (mais Private).
  - Origem: somente LocalSubnet.
  - Escopo: TCP, porta 8777, entrada.

Se nao estiver elevado, solicita administrador e executa novamente.
#>

param(
  [int]$Porta = 8777,
  [switch]$JaElevado
)

$ErrorActionPreference = 'Stop'
$nomeRegra = "trackeroao ($Porta)"

function Nota($t) { Write-Host "  $t" -ForegroundColor DarkGray }
function Ok($t)   { Write-Host "  $t" -ForegroundColor Green }

# Consulta pelo netsh, que nao exige administrador (Get-NetFirewallRule exige).
function Regra-Existe($nome) {
  # Procura o nome da regra na saida (as mensagens do netsh sao traduzidas).
  # netsh pode escrever em stderr; com 'Stop', o PowerShell 5.1 trataria isso como erro fatal.
  $ErrorActionPreference = 'Continue'
  $saida = & netsh advfirewall firewall show rule name="$nome" 2>&1 | Out-String
  return ($saida -match [regex]::Escape($nome))
}

# Perfis de rede em uso.
function Perfis-Em-Uso {
  try {
    $cats = @(Get-NetConnectionProfile -ErrorAction Stop |
              Select-Object -ExpandProperty NetworkCategory -Unique)
  } catch {
    # Sem a consulta, cobre os tres perfis (o alcance ja e limitado ao LocalSubnet).
    return @('Domain', 'Private', 'Public')
  }
  if (-not $cats -or $cats.Count -eq 0) { return @('Domain', 'Private', 'Public') }
  $perfis = @()
  foreach ($c in $cats) {
    switch ("$c") {
      'Private'       { $perfis += 'Private' }
      'DomainAuthenticated' { $perfis += 'Domain' }
      'Public'        { $perfis += 'Public' }
    }
  }
  # Private sempre incluido, caso a rede seja reclassificada.
  if ($perfis -notcontains 'Private') { $perfis += 'Private' }
  return ($perfis | Select-Object -Unique)
}

if (Regra-Existe $nomeRegra) {
  Ok "a porta $Porta ja estava liberada para a rede local"
  return
}

$souAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
             ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $souAdmin) {
  if ($JaElevado) { Write-Host "  nao consegui elevar" -ForegroundColor Red; exit 1 }
  Nota "pedindo administrador para liberar a porta $Porta"
  try {
    $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
      '-Porta', $Porta, '-JaElevado')
    if ($p.ExitCode -eq 0) { Ok "a porta $Porta foi liberada" } else { exit $p.ExitCode }
  } catch {
    Write-Host "  administrador recusado; a porta $Porta continua fechada" -ForegroundColor Yellow
    Write-Host "  o celular nao vai achar a pagina ate isso ser feito" -ForegroundColor Yellow
    exit 2
  }
  return
}

$perfis = Perfis-Em-Uso
Nota "perfis de rede em uso: $($perfis -join ', ')"

New-NetFirewallRule -DisplayName $nomeRegra `
  -Direction Inbound -Protocol TCP -LocalPort $Porta -Action Allow `
  -Profile ($perfis -join ',') `
  -RemoteAddress LocalSubnet `
  -Description 'Pagina de progresso do trackeroao, so para quem esta na mesma rede' | Out-Null

Ok "porta $Porta liberada para $($perfis -join ', '), so do LocalSubnet"
if ($perfis -contains 'Public') {
  Nota 'a rede desta maquina esta classificada como Public; por isso a regra cobre'
  Nota 'esse perfil tambem, e por isso ela se limita a quem esta no mesmo segmento'
}
