' Silent entry point for the rewards services (control API :3010 + panel :8890).
'
' WHY THIS FILE EXISTS
' The RewardsPanel scheduled task used to run node.exe directly. A scheduled
' task's action gets a console, so that produced a visible black window -- and
' closing that window killed the service: the task's last result was 3221225786
' (0xC000013A, STATUS_CONTROL_C_EXIT), which is exactly what a process killed by
' its own console closing returns. The panel was gone until it was started again
' by hand.
'
' wscript.exe never allocates a console at all, so there is no window to close
' and nothing for the user to accidentally dismiss.
'
' HOW IT IS WIRED
' The scheduled task's action is:
'   wscript.exe //B //Nologo "<repo>\scripts\win\start-services.vbs"
' Window style 0 hides the window and the third Run argument is False so the
' shell does not wait -- waiting is what inherits an output handle and makes the
' caller block.
'
' The work itself is in start-services.ps1 beside this file.
Option Explicit

Dim sh, fso, here, ps1, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
ps1 = here & "start-services.ps1"

If Not fso.FileExists(ps1) Then
    WScript.Quit 2
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & ps1 & Chr(34)
sh.Run cmd, 0, False
