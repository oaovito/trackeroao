' abrir.vbs - executado pelo atalho da area de trabalho, sem janela:
'
'   1. garante que o servico esta no ar;
'   2. avisa o servico (GET /abrir) para acender o icone da bandeja;
'   3. abre a pagina no navegador padrao.
'
' VBScript (wscript) para nao exibir console.

Option Explicit

Dim fso, shell, raiz, porta, url
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

raiz = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
porta = 8777
url = "http://localhost:" & porta & "/"

' A abertura manual remove o fechado.flag gravado pelo "Fechar" da bandeja.
If fso.FileExists(fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "fechado.flag")) Then
  fso.DeleteFile fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "fechado.flag"), True
End If

' Grava abrir.pedido: sem ele, o servico iniciado pela tarefa agendada encerra
' (a menos que "Iniciar com o Windows" esteja marcado).
Dim marca
Set marca = fso.CreateTextFile(fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "abrir.pedido"), True)
marca.Write Now
marca.Close

' --- 1. o servico esta no ar? ---
Dim http, vivo
vivo = False
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 1000, 1000, 2000, 2000
http.open "GET", url & "progress.json", False
http.send
If Err.Number = 0 And http.status = 200 Then vivo = True
Err.Clear
On Error GoTo 0

If Not vivo Then
  ' Sobe pela tarefa agendada (usuario e diretorio corretos).
  shell.Run "schtasks /run /tn TrackeroaoSync", 0, True

  ' Espera ate cinco segundos pelo servidor.
  Dim tentativa
  For tentativa = 1 To 10
    WScript.Sleep 500
    On Error Resume Next
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 1000, 1000, 2000, 2000
    http.open "GET", url & "progress.json", False
    http.send
    If Err.Number = 0 And http.status = 200 Then
      vivo = True
      Err.Clear
      On Error GoTo 0
      Exit For
    End If
    Err.Clear
    On Error GoTo 0
  Next
End If

' --- 2. acende a bandeja ---
' Falha aqui nao impede o passo 3.
If vivo Then
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 2000, 2000
  http.open "GET", url & "abrir", False
  http.send
  Err.Clear
  On Error GoTo 0
End If

' --- 3. a pagina ---
shell.Run url, 1, False
