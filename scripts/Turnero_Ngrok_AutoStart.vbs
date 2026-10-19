' ==============================================================================
' TURNERO 2026 — Auto-Inicio de Túnel Ngrok en Segundo Plano
' Este script arranca ngrok de forma 100% invisible (sin ventanas de terminal)
' cada vez que la computadora inicia o se inicia sesión.
' ==============================================================================
Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
ScriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
RootDir = FSO.GetParentFolderName(ScriptDir)
ConfigPath = RootDir & "\ngrok.yml"
WshShell.Run "ngrok start --all --config """ & ConfigPath & """", 0, False
