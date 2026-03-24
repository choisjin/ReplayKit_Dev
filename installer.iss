; ReplayKit Inno Setup Script
; Compile: Open in Inno Setup Compiler, press Ctrl+F9

#define MyAppName "ReplayKit"
#define MyAppVersion "1.0"
#define MyAppPublisher "ReplayKit"

; dist/ReplayKit path (build_dist.py output)
#define DistDir "dist\ReplayKit"

[Setup]
AppId={{B8F2A3E1-4D5C-4F6A-9E7B-1C2D3E4F5A6B}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName=C:\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=installer_output
OutputBaseFilename=ReplayKit_Setup_{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
SetupIconFile={#DistDir}\replaykit.ico
UninstallDisplayIcon={app}\replaykit.ico
ShowLanguageDialog=auto

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Types]
Name: "standard"; Description: "Standard (+ DLT Viewer)"
Name: "full"; Description: "Full (+ DLT Viewer + Vision Camera)"
Name: "custom"; Description: "Custom"; Flags: iscustom

[Components]
Name: "main"; Description: "ReplayKit Core"; Types: standard full custom; Flags: fixed
Name: "dltsdk"; Description: "DLT Viewer SDK (DLT log monitoring)"; Types: standard full
Name: "vimbax"; Description: "Vimba X SDK (Vision Camera support)"; Types: full

[Files]
; Main project files
Source: "{#DistDir}\*"; DestDir: "{app}"; Excludes: "node-*.msi,VimbaX_Setup*,python-3.10.4-amd64.exe"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: main
; VC++ Runtime (temp)
Source: "{#DistDir}\vcredist_x64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall
; DLT Viewer SDK (directory copy, only if component selected)
Source: "{#DistDir}\DltViewerSDK_21.1.3_ver\*"; DestDir: "{app}\DltViewerSDK_21.1.3_ver"; Flags: ignoreversion recursesubdirs createallsubdirs; Components: dltsdk
; Vimba X SDK installer (temp, only if component selected)
Source: "{#DistDir}\VimbaX_Setup*.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall; Components: vimbax

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\ReplayKit.bat"; IconFilename: "{app}\replaykit.ico"
Name: "{commondesktop}\{#MyAppName}"; Filename: "{app}\ReplayKit.bat"; IconFilename: "{app}\replaykit.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create desktop shortcut"; GroupDescription: "Additional tasks:"

[Code]
function IsVCRedistInstalled: Boolean;
begin
  Result := RegKeyExists(HKLM, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64')
         or RegKeyExists(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  AppDir: String;
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
    Exec('cmd.exe', '/c taskkill /f /im adb.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  if CurUninstallStep = usPostUninstall then
  begin
    AppDir := ExpandConstant('{app}');
    if DirExists(AppDir) then
    begin
      if MsgBox('Remove all remaining files (venv, data, git)?' + #13#10 + AppDir,
                mbConfirmation, MB_YESNO) = IDYES then
        DelTree(AppDir, True, True, True);
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  VCRedist: String;
  VimbaInstaller: String;
begin
  if CurStep = ssPostInstall then
  begin
    // VC++ Runtime (silent)
    if not IsVCRedistInstalled then
    begin
      VCRedist := ExpandConstant('{tmp}\vcredist_x64.exe');
      if FileExists(VCRedist) then
        Exec(VCRedist, '/install /quiet /norestart', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    end;

    // Vimba X SDK (user-driven install, only if component selected)
    if IsComponentSelected('vimbax') then
    begin
      VimbaInstaller := '';
      // Find the VimbaX installer in {tmp}
      if FileExists(ExpandConstant('{tmp}\VimbaX_Setup-2025-3-Win64.exe')) then
        VimbaInstaller := ExpandConstant('{tmp}\VimbaX_Setup-2025-3-Win64.exe');
      if (VimbaInstaller <> '') then
      begin
        Log('Launching Vimba X installer...');
        Exec(VimbaInstaller, '', '', SW_SHOW, ewWaitUntilTerminated, ResultCode);
      end;
    end;

    // Run setup.bat
    Exec('cmd.exe', '/c "' + ExpandConstant('{app}\setup.bat') + '"',
         ExpandConstant('{app}'), SW_SHOW, ewWaitUntilTerminated, ResultCode);
  end;
end;

[Run]
Filename: "{app}\ReplayKit.bat"; Description: "Run ReplayKit"; Flags: nowait postinstall skipifsilent shellexec
