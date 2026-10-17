use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
pub struct Features {
    pub shortcut: String,
    pub tray: bool,
}
pub fn focus(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("focus-search", ());
    }
}
pub fn install(app: &mut tauri::App) -> Features {
    let shortcut = match app.handle().plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(|app, _, event| {
                if event.state() == ShortcutState::Pressed {
                    focus(app);
                }
            })
            .build(),
    ) {
        Ok(()) => match app.global_shortcut().register("Control+Alt+Q") {
            Ok(()) => "Ctrl + Alt + Q".into(),
            Err(_) => "快捷键被占用，仍可从托盘打开".into(),
        },
        Err(_) => "系统快捷键暂不可用".into(),
    };
    let tray = (|| -> tauri::Result<()> {
        use tauri::menu::{Menu, MenuItem};
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
        let show = MenuItem::with_id(app, "show", "打开题库", true, None::<&str>)?;
        let hide = MenuItem::with_id(app, "hide", "收起窗口", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "退出题库", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show, &hide, &quit])?;
        let mut builder = TrayIconBuilder::new()
            .tooltip("题库 · Ctrl + Alt + Q 搜索")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show" => focus(app),
                "hide" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
                "quit" => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    focus(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        Ok(())
    })()
    .is_ok();
    Features { shortcut, tray }
}
