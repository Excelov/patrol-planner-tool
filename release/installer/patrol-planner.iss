#define AppName "巡线规划小工具"
#ifndef AppVersion
#define AppVersion "0.4.0-beta.1"
#endif
#define AppExeName "patrol-planner.exe"
[Setup]
AppId={{9D34A6A1-2B27-4E22-9E2C-PATROLPLANNER}}
AppName={#AppName}
AppVersion={#AppVersion}
DefaultDirName={autopf}\PatrolPlanner
DefaultGroupName={#AppName}
OutputDir=..\
OutputBaseFilename=patrol-planner-{#AppVersion}-setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
[Files]
Source: "..\patrol-planner-v0.4.0-beta.1\patrol-planner.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\patrol-planner-v0.4.0-beta.1\README.md"; DestDir: "{app}"; Flags: isreadme
Source: "..\patrol-planner-v0.4.0-beta.1\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"
[Run]
Filename: "{app}\{#AppExeName}"; Description: "启动{#AppName}"; Flags: nowait postinstall skipifsilent
[UninstallDelete]
Type: filesandordirs; Name: "{userappdata}\PatrolPlanner"
