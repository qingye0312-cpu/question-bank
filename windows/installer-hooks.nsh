!macro NSIS_HOOK_POSTINSTALL
  ; Create the desktop shortcut on ordinary installs, not only when the user
  ; clicks the optional button on the finish page. The generated function
  ; handles fresh installs and legacy shortcut migration.
  Call CreateOrUpdateDesktopShortcut
  ; Updates normally leave shortcuts alone. Repair a missing desktop shortcut
  ; on an existing install, while preserving the explicit /NS opt-out.
  ${If} $UpdateMode = 1
    ${If} $NoShortcutMode = 0
      IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" qbank_desktop_shortcut_exists 0
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
      qbank_desktop_shortcut_exists:
    ${EndIf}
  ${EndIf}
!macroend
