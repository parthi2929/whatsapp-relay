Option Explicit

Dim shell, fso, serviceDir, nodePathFile, nodeExe, runner, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

serviceDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodePathFile = fso.BuildPath(serviceDir, "node-path.txt")

Dim stream
Set stream = fso.OpenTextFile(nodePathFile, 1)
nodeExe = Trim(stream.ReadAll)
stream.Close

runner = fso.BuildPath(serviceDir, "ensure-relay.mjs")
command = Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & runner & Chr(34)

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
