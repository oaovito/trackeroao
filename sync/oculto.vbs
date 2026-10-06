' Sobe o servico sem janela. Run com 0 (janela oculta) e False (nao espera o
' processo terminar).
'
'   wscript oculto.vbs "<caminho do node.exe>" "<caminho do main.js>"

Option Explicit

Dim shell, node, script, comando
Set shell = CreateObject("WScript.Shell")

If WScript.Arguments.Count < 2 Then
    WScript.Echo "uso: wscript oculto.vbs <node.exe> <main.js>"
    WScript.Quit 1
End If

node = WScript.Arguments(0)
script = WScript.Arguments(1)

comando = """" & node & """ """ & script & """"
shell.Run comando, 0, False
