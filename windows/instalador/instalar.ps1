<#
Instala o trackeroao a partir da ultima release do repositorio publico.

Etapas:
  1. Node.js: o ja instalado, o winget ou o zip oficial do nodejs.org
     (descompactado na pasta do projeto, com hash conferido)
  2. o projeto, a partir do zip da ultima release (sem exigir git)
  3. a tarefa agendada que sobe o servico oculto no logon
  4. a regra de firewall da porta 8777, para acesso pelo celular
  5. a primeira leitura do save e a suite de testes

Nao instala o jogo nem a Steam. Uma instalacao existente e atualizada,
preservando os arquivos de estado.
#>

# Os valores padrao podem vir do ambiente, que e como o
# trackeroao-instalador.exe os repassa (ver construir-exe.ps1).
param(
  [string]$Destino = $(if ($env:TRACKEROAO_DESTINO) { $env:TRACKEROAO_DESTINO }
                       else { Join-Path $env:LOCALAPPDATA 'trackeroao' }),
  [string]$Repo = $(if ($env:TRACKEROAO_REPO) { $env:TRACKEROAO_REPO }
                    else { 'https://github.com/oaovito/trackeroao' }),
  # Pula a regra de firewall da porta 8777.
  [switch]$SemFirewall,
  # Uso interno: preenchidos ao relancar elevado, com o usuario original
  # (a elevacao pode trocar de conta).
  [string]$UsuarioOriginal,
  [switch]$JaElevado,
  # Caminho do trackeroao-instalador.exe, copiado como desinstalador. Vem do
  # ambiente ou, no processo elevado, por argumento.
  [string]$Exe = $env:TRACKEROAO_EXE
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Passo($t) { Write-Host "`n$t" -ForegroundColor Cyan }
function Ok($t)    { Write-Host "  $t" -ForegroundColor Green }
function Nota($t)  { Write-Host "  $t" -ForegroundColor DarkGray }
function Ruim($t)  { Write-Host "  $t" -ForegroundColor Red }

<#
  Com TRACKEROAO_GUI, o progresso e enviado em linhas iniciadas por @@ (ver o
  protocolo em construir-exe.ps1) e o resto vai para
  %TEMP%\trackeroao-instalar.log. Script gravado como UTF-8 com BOM.
#>
$gui = [bool]$env:TRACKEROAO_GUI
# Erros nao tratados: na janela, viram mensagem com a linha; no console,
# seguem para o PowerShell.
trap {
  # No console, remove a pasta do download.
  if ($tmp -and (Test-Path $tmp)) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
  if ($gui) {
    [Console]::Out.WriteLine("@@ERRO #unexpected|$($_.InvocationInfo.ScriptLineNumber)|$($_.Exception.Message)")
    [Console]::Out.Flush()
    exit 1
  }
  break
}
if ($gui) {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  # Desativa a barra de progresso (deixa o Invoke-WebRequest lento).
  $ProgressPreference = 'SilentlyContinue'
  if ($env:TRACKEROAO_USUARIO) { $UsuarioOriginal = $env:TRACKEROAO_USUARIO }
}
function Tela($tipo, $texto) {
  if ($gui) { [Console]::Out.WriteLine("@@$tipo $texto"); [Console]::Out.Flush() }
}
function Etapa($pct, $texto) { Tela 'PASSO' "$pct $texto" }
function Detalhe($texto) { Tela 'DETALHE' $texto }
# Encerra com erro e informa o motivo a janela.
function Falhar($texto, $janela) {
  Ruim $texto
  Tela 'ERRO' $(if ($janela) { $janela } else { $texto })
  exit 1
}
<#
  Executa programas externos (node, winget) com ErrorActionPreference
  Continue: no PowerShell 5.1, stderr redirecionado com 'Stop' vira erro
  fatal. O resultado e dado pelo codigo de saida.
#>
# Na janela, os temporarios ficam na pasta do .exe, removida ao final.
$baseTemp = if ($gui -and $PSScriptRoot) { $PSScriptRoot } else { $env:TEMP }
function Nativo([scriptblock]$bloco) {
  $ErrorActionPreference = 'Continue'
  & $bloco
}
Etapa 2 '#prep_inst'

# Pendencias, listadas no relatorio final.
$pendencias = @()

<#
  A instalacao roda elevada. Antes de elevar, registra o usuario original e o
  repassa, para que a tarefa agendada, as pastas e o atalho sejam os dele,
  mesmo que a elevacao use outra conta.

  Se a elevacao for recusada, segue sem ela e deixa a porta 8777 como
  pendencia.
#>
$souAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
             ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$elevacaoNegada = $false

if (-not $gui -and -not $souAdmin -and -not $JaElevado -and -not $SemFirewall) {
  $quemPediu = "$env:USERDOMAIN\$env:USERNAME"
  Nota 'pedindo administrador para a instalacao inteira'
  # Nao usar $args (variavel automatica).
  $argsElevado = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"",
            '-Destino', "`"$Destino`"", '-Repo', "`"$Repo`"",
            '-UsuarioOriginal', "`"$quemPediu`"", '-JaElevado')
  if ($Exe) { $argsElevado += @('-Exe', "`"$Exe`"") }
  try {
    $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList $argsElevado
    exit $p.ExitCode
  } catch {
    Nota 'administrador recusado; seguindo sem ele'
    Nota 'tudo que nao depende de administrador vai ser feito normalmente'
    # Distinto de $SemFirewall: aqui a elevacao foi negada.
    $elevacaoNegada = $true
  }
}

# Na janela, a elevacao e feita pelo .exe.
if ($gui) {
  $JaElevado = $souAdmin
  $elevacaoNegada = -not $souAdmin
}

# Usuario original da instalacao, que pode diferir do processo elevado.
if (-not $UsuarioOriginal) { $UsuarioOriginal = "$env:USERDOMAIN\$env:USERNAME" }
if ($JaElevado -and $UsuarioOriginal -ne "$env:USERDOMAIN\$env:USERNAME") {
  Nota "elevado como $env:USERNAME, mas instalando para $UsuarioOriginal"
}

Write-Host "trackeroao - instalacao" -ForegroundColor White
Nota "destino: $Destino"

# ================================================================== 1. Node
Passo '1/6  Node.js'
Etapa 6 '#node_check'

function Node-Portatil($raiz) {
  <#
    Sem winget: zip oficial do nodejs.org em runtime\node, dentro do destino,
    com o hash conferido contra o SHASUMS256.txt. Nao altera o PATH.
  #>
  $arq = switch ($env:PROCESSOR_ARCHITECTURE) {
    'ARM64' { 'win-arm64' }
    'AMD64' { 'win-x64' }
    default { 'win-x86' }
  }

  Nota "baixando o Node oficial ($arq) -- winget nao esta disponivel aqui"
  Etapa 10 '#node_dl'
  Detalhe '#node_dl_d'
  $indice = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $lts = $indice | Where-Object { $_.lts -and $_.files -contains "$arq-zip" } | Select-Object -First 1
  if (-not $lts) { throw "o nodejs.org nao publica zip de $arq" }

  $nome = "node-$($lts.version)-$arq.zip"
  $url  = "https://nodejs.org/dist/$($lts.version)/$nome"
  $tmp  = Join-Path $baseTemp ("trackeroao-node-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $zip = Join-Path $tmp $nome

  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

  $somas = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$($lts.version)/SHASUMS256.txt" -UseBasicParsing).Content
  $esperado = ($somas -split "`n" | Where-Object { $_ -match [regex]::Escape($nome) + '\s*$' }) -split '\s+' | Select-Object -First 1
  $obtido = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if (-not $esperado) { throw "o SHASUMS256.txt nao lista $nome" }
  if ($obtido -ne $esperado.ToLower()) {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    throw "o hash do Node baixado nao confere (esperado $esperado, obtido $obtido)"
  }
  Nota "hash conferido: $($esperado.Substring(0,16))..."

  $runtime = Join-Path $raiz 'runtime'
  New-Item -ItemType Directory -Path $runtime -Force | Out-Null
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $pasta = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
  $alvo = Join-Path $runtime 'node'
  if (Test-Path $alvo) { Remove-Item -Recurse -Force $alvo }
  Move-Item -Path $pasta -Destination $alvo
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

  return (Join-Path $alvo 'node.exe')
}

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $candidato = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $candidato) { $node = $candidato }
}
# O runtime portatil de uma instalacao anterior conta como Node achado.
if (-not $node) {
  $candidato = Join-Path $Destino 'runtime\node\node.exe'
  if (Test-Path $candidato) { $node = $candidato }
}
if (-not $node -and (Get-Command winget -ErrorAction SilentlyContinue)) {
  Nota 'nao encontrado; instalando via winget'
  Etapa 10 '#node_inst'
  Detalhe '#node_inst_d'
  Nativo { winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements --silent 2>&1 | Out-Null }
  $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
  $node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
}
if (-not $node) {
  New-Item -ItemType Directory -Path $Destino -Force | Out-Null
  try { $node = Node-Portatil $Destino }
  catch {
    Ruim "nao consegui obter o Node: $($_.Exception.Message)"
    Falhar 'sem ele nao ha o que instalar. Instale em https://nodejs.org e rode de novo.' '#node_fail'
  }
}
if (-not (Test-Path $node)) { Falhar "o Node apontado nao existe: $node" '#node_broken' }
Ok "node em $node  ($(Nativo { & $node -v 2>&1 }))"

# =============================================================== 2. projeto
Passo '2/6  Projeto'
Etapa 28 '#dl'
Detalhe '#dl_d'
$tmp = Join-Path $baseTemp ("trackeroao-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
$zip = Join-Path $tmp 'fonte.zip'
<#
  Instala a ultima release (tag gravada em versao.json). Se a release nao
  puder ser consultada, usa a main.
#>
$tag = 'main'
$origem = "$Repo/archive/refs/heads/main.zip"
try {
  $apiRepo = $Repo -replace '^https://github\.com/', 'https://api.github.com/repos/'
  $rel = Invoke-RestMethod -Uri "$apiRepo/releases/latest" -UseBasicParsing -Headers @{ 'User-Agent' = 'trackeroao' }
  if ($rel.tag_name) { $tag = $rel.tag_name; $origem = "$Repo/archive/refs/tags/$tag.zip" }
} catch {
  # Usa o redirecionamento de /releases/latest (sem cota da API).
  try {
    $pedido = [System.Net.WebRequest]::Create("$Repo/releases/latest")
    $pedido.AllowAutoRedirect = $false
    $pedido.UserAgent = 'trackeroao'
    $resposta = $pedido.GetResponse()
    $local = $resposta.Headers['Location']
    $resposta.Close()
    if ($local -match '/releases/tag/([^/?#]+)') { $tag = [uri]::UnescapeDataString($Matches[1]); $origem = "$Repo/archive/refs/tags/$tag.zip" }
  } catch { }
  if ($tag -eq 'main') { Nota 'nao consegui consultar a ultima release; instalando a main' }
}
try {
  Invoke-WebRequest -Uri $origem -OutFile $zip -UseBasicParsing
} catch {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  Falhar "nao consegui baixar: $($_.Exception.Message)" '#dl_fail'
}
Etapa 42 '#copy'
Detalhe "#version|$tag"
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$raizBaixada = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName

New-Item -ItemType Directory -Path $Destino -Force | Out-Null

<#
  A copia usa sync\atualizar.js da pasta baixada: valida o zip, preserva o
  estado local, remove arquivos legados e grava versao.json.
#>
Nativo { & $node (Join-Path $raizBaixada 'sync\atualizar.js') --aplicar $raizBaixada $tag $Destino 2>&1 |
  ForEach-Object { Nota "$_" } }
$copiou = $LASTEXITCODE
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
if ($copiou -ne 0) { Falhar 'a copia do projeto falhou; nada foi instalado' '#copy_fail' }
$artes = @(Get-ChildItem (Join-Path $Destino 'docs\icones') -Recurse -File -ErrorAction SilentlyContinue).Count
Ok "projeto $tag em $Destino  ($artes imagens)"

<#
  Desinstalador: o proprio .exe, copiado com "desinstal" no nome (ver
  construir-exe.ps1). Registrado em "Aplicativos instalados" (HKCU) apenas
  quando o processo roda com a conta original.
#>
Etapa 56 '#register'
Detalhe '#register_d'
if ($Exe -and (Test-Path $Exe)) {
  $desinstalador = Join-Path $Destino 'trackeroao-desinstalador.exe'
  try {
    Copy-Item -Path $Exe -Destination $desinstalador -Force
    if ($UsuarioOriginal -eq "$env:USERDOMAIN\$env:USERNAME") {
      $chave = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\trackeroao'
      New-Item -Path $chave -Force | Out-Null
      $valores = @{
        DisplayName = 'trackeroao'; DisplayVersion = ($tag -replace '^v', ''); Publisher = 'oaovito'
        InstallLocation = $Destino; UninstallString = "`"$desinstalador`""
        DisplayIcon = "$desinstalador,0"; URLInfoAbout = $Repo
      }
      foreach ($k in $valores.Keys) { Set-ItemProperty -Path $chave -Name $k -Value $valores[$k] }
      Set-ItemProperty -Path $chave -Name NoModify -Value 1 -Type DWord
      Set-ItemProperty -Path $chave -Name NoRepair -Value 1 -Type DWord
      Ok 'desinstalador em Aplicativos instalados'
    } else {
      Ok "desinstalador em $desinstalador"
    }
  } catch {
    Nota "nao registrei o desinstalador: $($_.Exception.Message)"
  }
} else {
  Nota 'rodando sem o .exe: sem desinstalador; para remover, windows\instalador\desinstalar.ps1'
}

# =============================================================== 3. servico
Passo '3/6  Servico'
Etapa 62 '#service'
Detalhe '#service_d'
$instalador = Join-Path $Destino 'windows\install-sync-service.ps1'
& $instalador -NodePath $node -Usuario $UsuarioOriginal

<#
  Janela do Trackeroao (app\Trackeroao.exe), recebida por TRACKEROAO_APP. A
  pasta app e substituida inteira; uma janela aberta e fechada antes.
#>
$janela = $null
if ($env:TRACKEROAO_APP -and (Test-Path (Join-Path $env:TRACKEROAO_APP 'Trackeroao.exe'))) {
  Etapa 70 '#window'
  $pastaApp = Join-Path $Destino 'app'
  # O icone da bandeja usa o mesmo .exe; repete fechar e copiar ate conseguir.
  for ($tentativa = 1; ; $tentativa++) {
    Get-Process -Name 'Trackeroao' -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -and $_.Path.StartsWith($pastaApp, [StringComparison]::OrdinalIgnoreCase) } |
      Stop-Process -Force -ErrorAction SilentlyContinue
    try {
      if (Test-Path $pastaApp) { Remove-Item -Recurse -Force $pastaApp -ErrorAction Stop }
      New-Item -ItemType Directory -Path $pastaApp -Force | Out-Null
      Copy-Item (Join-Path $env:TRACKEROAO_APP '*') $pastaApp -Force -ErrorAction Stop
      break
    } catch {
      if ($tentativa -ge 10) { throw }
      Start-Sleep -Milliseconds 500
    }
  }
  $janela = Join-Path $pastaApp 'Trackeroao.exe'
  Ok "janela em $janela"
}

# =============================================================== 4. atalho
Passo '4/6  Atalho'
Etapa 74 '#shortcut'
<#
  Atalho na area de trabalho. Aponta para wscript + abrir.vbs, que sobe o
  servico se necessario, acende a bandeja e abre a pagina.
#>
$atalhoVbs = Join-Path $Destino 'sync\abrir.vbs'
if (-not (Test-Path $atalhoVbs)) {
  Nota 'abrir.vbs nao veio no download; sem atalho'
  $pendencias += $(if ($gui) { '#shortcut_fail' } else { 'criar um atalho para o trackeroao: nao consegui' })
} else {
  try {
    # Area de trabalho do usuario original, nao a do processo elevado.
    $desktop = $null
    if ($UsuarioOriginal -and $UsuarioOriginal -ne "$env:USERDOMAIN\$env:USERNAME") {
      $apenasNome = ($UsuarioOriginal -split '\\')[-1]
      $tentativa = Join-Path (Join-Path (Split-Path $env:PUBLIC -Parent) $apenasNome) 'Desktop'
      if (Test-Path $tentativa) { $desktop = $tentativa }
    }
    if (-not $desktop) { $desktop = [Environment]::GetFolderPath('Desktop') }

    # Substitui o atalho existente.
    $lnk = Join-Path $desktop 'Trackeroao.lnk'
    Get-ChildItem $desktop -Filter 'trackeroao.lnk' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
    $ws = New-Object -ComObject WScript.Shell
    $atalho = $ws.CreateShortcut($lnk)
    if ($janela) {
      $atalho.TargetPath = $janela
      $atalho.Arguments = ''
      $atalho.WorkingDirectory = Split-Path $janela -Parent
      # Icone fora de app\, para o Explorer nao travar a troca da janela.
      $ico = Join-Path $Destino 'trackeroao.ico'
      $doApp = Join-Path (Split-Path $janela -Parent) 'trackeroao.ico'
      if (Test-Path $doApp) { Copy-Item $doApp $ico -Force -ErrorAction SilentlyContinue }
      $atalho.IconLocation = $(if (Test-Path $ico) { "$ico,0" } else { "$janela,0" })
    } else {
      $atalho.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
      $atalho.Arguments = "`"$atalhoVbs`""
      $atalho.WorkingDirectory = $Destino
      $atalho.IconLocation = "$(Join-Path $env:WINDIR 'System32\wscript.exe'),0"
    }
    $atalho.Description = 'Trackeroao'
    $atalho.Save()
    Ok "atalho em $lnk"
  } catch {
    Nota "nao criei o atalho: $($_.Exception.Message)"
    $pendencias += $(if ($gui) { '#shortcut_fail' } else { 'criar um atalho para o trackeroao na area de trabalho' })
  }
}

# ================================================================== 4. rede
Passo '5/6  Rede'
Etapa 78 '#net'
Detalhe '#net_d'
# Porta 8777 na rede local, via windows\liberar-porta.ps1.
if ($gui -and $elevacaoNegada -and -not $SemFirewall) {
  # Sem administrador, na janela do instalador, fica como pendencia.
  Nota 'sem administrador: a porta fica fechada'
  $pendencias += '#net_pending'
} elseif ($SemFirewall) {
  Nota 'pulado a pedido (-SemFirewall)'
  $pendencias += 'a porta 8777 nao foi liberada, a pedido: o celular nao vai achar a pagina'
} else {
  $liberar = Join-Path $Destino 'windows\liberar-porta.ps1'
  if (-not (Test-Path $liberar)) {
    Nota 'liberar-porta.ps1 nao veio no download'
    $pendencias += 'liberar a porta 8777 na rede local'
  } else {
    # Elevado, so cria a regra; caso contrario, o script solicita elevacao.
    & $liberar
    if ($LASTEXITCODE -ne 0) {
      $pendencias += "liberar a porta 8777: rode $Destino\windows\liberar-porta.ps1 e aceite o pedido de administrador"
    }
  }
}

# ============================================================= 5. conferir
Passo '6/6  Conferindo'
Etapa 84 '#read'
Push-Location $Destino
# Primeira leitura do save antes da suite.
Nativo { & $node 'sync/parse.js' 2>&1 | Select-Object -Last 1 | ForEach-Object { Nota "$_" } }
Etapa 90 '#check'
Detalhe '#check_d'
Nativo { & $node 'sync/selftest.js' 2>&1 | ForEach-Object { Write-Host "$_" } }
$testes = $LASTEXITCODE
Pop-Location
if ($testes -eq 0) { Ok 'a suite passou inteira nesta maquina' }
else {
  Nota 'alguns testes falharam; se for a parte do save, o jogo talvez nao esteja instalado aqui'
  # Na janela, a saida vai so para o registro (sem o jogo, alguns testes falham).
  if (-not $gui) { $pendencias += "a suite terminou com falha (codigo $testes) -- rode 'npm run selftest' em $Destino para ver quais" }
}

# No console, abre a janela do Trackeroao aqui; na GUI, pelo botao final.
if (-not $gui -and $janela) { Start-Process $janela }
Write-Host "`nPronto." -ForegroundColor Green
Nota 'para abrir: o icone Trackeroao na area de trabalho, ou dois cliques na chama da bandeja'
Nota 'atualizacoes: automaticas e silenciosas, a cada nova release'
Nota 'para remover: Aplicativos instalados do Windows, ou trackeroao-desinstalador.exe na pasta'

if ($pendencias) {
  Write-Host "`nFicou para voce:" -ForegroundColor Yellow
  foreach ($p in $pendencias) { Write-Host "  - $p" -ForegroundColor Yellow; Tela 'PENDENCIA' $p }
}
Detalhe '#done_d'
if ($janela) { Tela 'APP' $janela }
Tela 'PRONTO' '#installed'

# Elevado em console proprio: espera uma tecla para o relatorio ficar visivel.
if ($JaElevado -and -not $gui) {
  Write-Host "`nTecle algo para fechar." -ForegroundColor DarkGray
  [void]$Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
}

# Codigo de saida explicito (nao herda o da suite).
if ($gui) { exit 0 }
